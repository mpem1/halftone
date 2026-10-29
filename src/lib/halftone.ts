/**
 * Halftone Studio — rendering engine.
 *
 * Port of the validated Python pipeline to Canvas2D + typed arrays.
 * Pipeline per screen layer:
 *   1. Adjust the source (tone / saturation / contrast) in image space.
 *   2. Build the ink map (luminance / CMY channel), multiplied by an
 *      analytic validity mask so nothing outside the real image dots.
 *   3. Per-cell average in rotated screen space -> area-proportional mark
 *      size (dot/square/diamond/ellipse radius, or line half-thickness).
 *   4. Analytic per-pixel coverage in screen space (1px AA band, or hard
 *      1-bit when crisp), mapped back to image space by exact inverse
 *      rotation sampling — no canvas resampling anywhere, so mark edges
 *      stay as sharp as the screen grid allows (Photoshop-bitmap style).
 *   5. Composite flat ink or the source artwork itself ("keep art") per
 *      image pixel.
 * CMYK mode renders 4 independently-angled plates (1-bit capable) and
 * multiply-composites them in image space.
 */

export type ScreenShape =
  | 'dot'
  | 'square'
  | 'diamond'
  | 'ellipse'
  | 'line'
  | 'wave'
  | 'zigzag'
export type OutputMode = 'single' | 'cmyk'
export type PlateFilter = 'all' | 'C' | 'M' | 'Y' | 'K'
export type ToneMode = 'color' | 'gray' | 'bw'

export interface HalftoneParams {
  mode: OutputMode
  shape: ScreenShape
  angleDeg: number // 0..180 base screen angle
  cell: number // screen pitch in px (3..24)
  dotScale: number // 0.2..1.2 mark size factor
  keepArt: boolean // fill marks with source artwork color (single mode)
  tone: ToneMode // color / continuous grayscale / 1-bit black & white
  threshold: number // 0..1 white cutoff used when tone = 'bw'
  saturation: number // -1..1 (0 = unchanged, applies to tone 'color')
  contrast: number // -1..1 (0 = unchanged)
  kStrength: number // 0..1 black-plate strength in CMYK mode
  plateFilter: PlateFilter // which CMYK plate(s) to show
  inkColor: string // hex, single mode
  transparent: boolean // marks on transparent background (alpha PNG)
  crisp: boolean // hard 1-bit mark edges — no anti-aliasing (print mode)
  knockout: boolean // remove background-colored source areas before screening
  knockoutColor: string // hex, background color to remove
  knockoutTolerance: number // 0..0.35 how far from knockoutColor still counts
}

export const DEFAULT_PARAMS: HalftoneParams = {
  mode: 'single',
  shape: 'dot',
  angleDeg: 45,
  cell: 6,
  dotScale: 0.62,
  keepArt: false,
  tone: 'color',
  threshold: 0.5,
  saturation: 0,
  contrast: 0,
  kStrength: 0.55,
  plateFilter: 'all',
  inkColor: '#000000',
  transparent: false,
  crisp: true,
  knockout: false,
  knockoutColor: '#ffffff',
  knockoutTolerance: 0.1,
}

export const SHAPE_LABELS: Record<ScreenShape, string> = {
  dot: 'Dots',
  square: 'Squares',
  diamond: 'Diamonds',
  ellipse: 'Ellipses',
  line: 'Lines',
  wave: 'Waves',
  zigzag: 'Zigzags',
}

/** CMYK plate definitions: ink rgb (0..1) + screen angle offset. */
const PLATES = {
  C: { rgb: [0, 1, 1], offset: 15, channel: 0 },
  M: { rgb: [1, 0, 1], offset: 75, channel: 1 },
  Y: { rgb: [1, 1, 0], offset: 0, channel: 2 },
  K: { rgb: [0, 0, 0], offset: 45, channel: -1 },
} as const

type PlateName = keyof typeof PLATES

function hexToRgb01(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return [0, 0, 0]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Apply tone + saturation / contrast to an ImageData in place.
 *  tone 'gray' desaturates to continuous luminance (real grays survive).
 *  tone 'bw' is TRUE black & white: the contrasted gray is thresholded at
 *  p.threshold so every pixel ends up pure #000 or #fff — no grays. */
function adjustImageData(img: ImageData, p: HalftoneParams): void {
  const sat = p.tone === 'color' ? 1 + p.saturation : 0
  const con = 1 + p.contrast
  const binarize = p.tone === 'bw'
  const thr = p.threshold
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] / 255
    let g = d[i + 1] / 255
    let b = d[i + 2] / 255
    if (sat !== 1) {
      const lum = 0.299 * r + 0.587 * g + 0.114 * b
      r = lum + (r - lum) * sat
      g = lum + (g - lum) * sat
      b = lum + (b - lum) * sat
    }
    if (con !== 1) {
      r = (r - 0.5) * con + 0.5
      g = (g - 0.5) * con + 0.5
      b = (b - 0.5) * con + 0.5
    }
    if (binarize) {
      // after desaturation all channels carry the same gray value
      const v = g >= thr ? 255 : 0
      d[i] = v
      d[i + 1] = v
      d[i + 2] = v
    } else {
      d[i] = r <= 0 ? 0 : r >= 1 ? 255 : (r * 255) | 0
      d[i + 1] = g <= 0 ? 0 : g >= 1 ? 255 : (g * 255) | 0
      d[i + 2] = b <= 0 ? 0 : b >= 1 ? 255 : (b * 255) | 0
    }
    d[i + 3] = 255
  }
}

interface ScreenAlpha {
  alpha: Float32Array // (rh, rw) coverage 0..1
  means: Float32Array // per-cell ink (for line thickness)
  rows: number
  cols: number
  rw: number
  rh: number
  cell: number
}

/**
 * Build screen-space coverage for one ink layer.
 * inkMap: Float32Array (h*w) of ink amounts 0..1 in IMAGE space.
 */
function buildScreenAlpha(
  inkMap: Float32Array,
  w: number,
  h: number,
  theta: number,
  cell: number,
  dotScale: number,
  shape: ScreenShape,
  crisp: boolean,
): ScreenAlpha {
  const ca = Math.cos(theta)
  const sa = Math.sin(theta)
  const rw = Math.ceil(w * Math.abs(ca) + h * Math.abs(sa)) + 2 * cell
  const rh = Math.ceil(w * Math.abs(sa) + h * Math.abs(ca)) + 2 * cell

  // sample ink map into screen space via inverse mapping (exact, no ghosts)
  const inkS = new Float32Array(rw * rh)
  for (let y = 0; y < rh; y++) {
    const dy = y + 0.5 - rh / 2
    let idx = y * rw
    for (let x = 0; x < rw; x++) {
      const dx = x + 0.5 - rw / 2
      const ox = ca * dx + sa * dy + w / 2
      const oy = -sa * dx + ca * dy + h / 2
      if (ox < 0 || oy < 0 || ox >= w || oy >= h) {
        idx++
        continue
      }
      inkS[idx++] = inkMap[(oy | 0) * w + (ox | 0)]
    }
  }

  // per-cell means
  const rows = Math.ceil(rh / cell)
  const cols = Math.ceil(rw / cell)
  const means = new Float32Array(rows * cols)
  for (let cy = 0; cy < rows; cy++) {
    const y0 = cy * cell
    const y1 = Math.min(y0 + cell, rh)
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * cell
      const x1 = Math.min(x0 + cell, rw)
      let sum = 0
      for (let y = y0; y < y1; y++) {
        const row = y * rw
        for (let x = x0; x < x1; x++) sum += inkS[row + x]
      }
      means[cy * cols + cx] = sum / ((y1 - y0) * (x1 - x0))
    }
  }

  // distance-to-own-cell-center LUTs (pixel centers at +0.5)
  const dxArr = new Float32Array(rw)
  const dyArr = new Float32Array(rh)
  for (let x = 0; x < rw; x++) {
    const c = (((x + 0.5) / cell) | 0) * cell + cell * 0.5
    dxArr[x] = x + 0.5 - c
  }
  for (let y = 0; y < rh; y++) {
    const c = (((y + 0.5) / cell) | 0) * cell + cell * 0.5
    dyArr[y] = y + 0.5 - c
  }

  // per-cell mark size
  const rCell = new Float32Array(rows * cols)
  const hCell = new Float32Array(rows * cols) // line half-thickness
  for (let i = 0; i < means.length; i++) {
    const m = means[i]
    if (m <= 0.015) {
      rCell[i] = -1
      hCell[i] = -1
      continue
    }
    rCell[i] = cell * Math.sqrt(m) * dotScale
    hCell[i] = Math.min(cell * 0.5, m * cell * dotScale)
  }

  // radius lookup per pixel
  const rMap = new Float32Array(rw * rh)
  const hMap = new Float32Array(rw * rh)
  for (let y = 0; y < rh; y++) {
    const crow = ((y + 0.5) / cell) | 0
    const mrow = crow * cols
    let idx = y * rw
    for (let x = 0; x < rw; x++) {
      const ci = mrow + (((x + 0.5) / cell) | 0)
      rMap[idx] = rCell[ci]
      hMap[idx] = hCell[ci]
      idx++
    }
  }

  // coverage
  const alpha = new Float32Array(rw * rh)
  // area-calibration per shape (so equal ink = equal coverage)
  const shapeFactor =
    shape === 'diamond'
      ? 1.25
      : shape === 'square'
        ? 0.89
        : shape === 'ellipse'
          ? 0.85
          : 1
  for (let y = 0; y < rh; y++) {
    const dy = dyArr[y]
    let idx = y * rw
    for (let x = 0; x < rw; x++, idx++) {
      const r = rMap[idx]
      if (r < 0) continue
      const dx = dxArr[x]
      let d: number
      switch (shape) {
        case 'dot':
          d = Math.sqrt(dx * dx + dy * dy)
          break
        case 'square':
          d = Math.max(Math.abs(dx), Math.abs(dy))
          break
        case 'diamond':
          d = Math.abs(dx) + Math.abs(dy)
          break
        case 'ellipse':
          d = Math.sqrt((dx / 1.7) * (dx / 1.7) + (dy / 0.8) * (dy / 0.8))
          break
        case 'line':
          d = Math.abs(dy)
          break
        case 'wave': {
          // sine row: one period every 2 cells, phase continuous across cells
          const px = x + 0.5
          const amp = cell * 0.28
          d = Math.abs(dy - amp * Math.sin((px * Math.PI) / cell))
          break
        }
        case 'zigzag': {
          // triangle row: one period every 2 cells
          const px = x + 0.5
          const period = cell * 2
          const t = (px % period) / period
          const tri = t < 0.5 ? t * 2 : 2 - t * 2
          d = Math.abs(dy - cell * 0.28 * (tri * 2 - 1))
          break
        }
      }
      const size =
        shape === 'line' || shape === 'wave' || shape === 'zigzag'
          ? hMap[idx]
          : r * shapeFactor
      const a = 0.5 + size - d
      // crisp: threshold to 1-bit like a bitmap halftone — prints clean
      alpha[idx] = crisp ? (a >= 0.5 ? 1 : 0) : a <= 0 ? 0 : a >= 1 ? 1 : a
    }
  }

  return { alpha, means, rows, cols, rw, rh, cell }
}

/** Map screen-space coverage back to image space EXACTLY: every image
 *  pixel center is rotated into the screen grid and the analytic coverage
 *  is nearest-sampled. No canvas resampling pass — a 1px edge stays a 1px
 *  edge instead of being smeared by bilinear interpolation. */
function coverageToImage(
  sa: ScreenAlpha,
  w: number,
  h: number,
  theta: number,
): Float32Array {
  const ca = Math.cos(theta)
  const sn = Math.sin(theta)
  const cov = new Float32Array(w * h)
  const hw = w / 2
  const hh = h / 2
  const hrw = sa.rw / 2
  const hrh = sa.rh / 2
  for (let y = 0; y < h; y++) {
    const uy = y + 0.5 - hh
    let i = y * w
    for (let x = 0; x < w; x++, i++) {
      const ux = x + 0.5 - hw
      const sx = ca * ux - sn * uy + hrw
      const sy = sn * ux + ca * uy + hrh
      if (sx < 0 || sy < 0 || sx >= sa.rw || sy >= sa.rh) continue
      cov[i] = sa.alpha[(sy | 0) * sa.rw + (sx | 0)]
    }
  }
  return cov
}

/** Mask: 0 where source pixel matches the knockout color, 1 elsewhere.
 *  Soft ramp between tol and tol*1.25 so boundaries fade rather than jag. */
function buildKnockoutMask(img: ImageData, p: HalftoneParams): Float32Array {
  const kc = hexToRgb01(p.knockoutColor)
  const lo = p.knockoutTolerance
  const hi = lo * 1.25 + 0.02
  const d = img.data
  const mask = new Float32Array(d.length / 4).fill(1)
  for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
    const dist = Math.max(
      Math.abs(d[j] / 255 - kc[0]),
      Math.abs(d[j + 1] / 255 - kc[1]),
      Math.abs(d[j + 2] / 255 - kc[2]),
    )
    if (dist <= lo) mask[i] = 0
    else if (dist < hi) mask[i] = (dist - lo) / (hi - lo)
  }
  return mask
}

/** Render marks for one plate into an RGBA buffer on paper (multiply-safe). */
function plateToImageData(
  sa: ScreenAlpha,
  inkRgb: [number, number, number],
  w: number,
  h: number,
  theta: number,
): ImageData {
  const cov = coverageToImage(sa, w, h, theta)
  const out = new ImageData(w, h)
  const od = out.data
  const [ir, ig, ib] = inkRgb
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const a = cov[i]
    // layer value = 1 - a*(1-ink) per channel (multiply-compositable)
    od[j] = ((1 - a * (1 - ir)) * 255) | 0
    od[j + 1] = ((1 - a * (1 - ig)) * 255) | 0
    od[j + 2] = ((1 - a * (1 - ib)) * 255) | 0
    od[j + 3] = 255
  }
  return out
}

/** Main entry: render params onto out canvas at source resolution.
 *  maxDim: optional working-resolution cap for fast interactive previews. */
export function renderHalftone(
  src: HTMLCanvasElement,
  out: HTMLCanvasElement,
  p: HalftoneParams,
  maxDim?: number,
): number {
  const t0 = performance.now()
  if (maxDim && Math.max(src.width, src.height) > maxDim) {
    const s = maxDim / Math.max(src.width, src.height)
    const small = document.createElement('canvas')
    small.width = Math.round(src.width * s)
    small.height = Math.round(src.height * s)
    const smctx = small.getContext('2d')!
    smctx.imageSmoothingQuality = 'high'
    smctx.drawImage(src, 0, 0, small.width, small.height)
    src = small
  }
  const w = src.width
  const h = src.height
  out.width = w
  out.height = h
  const octx = out.getContext('2d')!

  // 1) adjusted source — tone / saturation / contrast happen BEFORE screening
  const adjId = src.getContext('2d')!.getImageData(0, 0, w, h)
  adjustImageData(adjId, p)

  const theta = (p.angleDeg * Math.PI) / 180
  const white = document.createElement('canvas')
  white.width = w
  white.height = h
  const whctx = white.getContext('2d')!
  whctx.fillStyle = '#ffffff'
  whctx.fillRect(0, 0, w, h)

  if (p.mode === 'single') {
    // ink map from adjusted luminance (+ background knockout)
    const d = adjId.data
    const mask = p.knockout ? buildKnockoutMask(adjId, p) : null
    const inkMap = new Float32Array(w * h)
    for (let i = 0, j = 0; i < inkMap.length; i++, j += 4) {
      const lum = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) / 255
      inkMap[i] = Math.pow(1 - lum, 1.18) * (mask ? mask[i] : 1)
    }
    const sa = buildScreenAlpha(
      inkMap,
      w,
      h,
      theta,
      p.cell,
      p.dotScale,
      p.shape,
      p.crisp,
    )

    if (p.transparent) {
      // true knockout: alpha = ink coverage, straight-alpha RGBA, no paper
      const cov = coverageToImage(sa, w, h, theta)
      const outId = new ImageData(w, h)
      const od = outId.data
      const [ir, ig, ib] = hexToRgb01(p.inkColor)
      for (let i = 0, j = 0; i < w * h; i++, j += 4) {
        const a = cov[i]
        if (p.keepArt) {
          od[j] = d[j]
          od[j + 1] = d[j + 1]
          od[j + 2] = d[j + 2]
        } else {
          od[j] = (ir * 255) | 0
          od[j + 1] = (ig * 255) | 0
          od[j + 2] = (ib * 255) | 0
        }
        od[j + 3] = (a * 255) | 0
      }
      octx.putImageData(outId, 0, 0)
      return performance.now() - t0
    }

    // composite in image space — coverage is inverse-mapped exactly and art
    // colors come straight from the adjusted source: zero resampling, so a
    // mark edge is exactly as sharp as the screen grid defines it
    const cov = coverageToImage(sa, w, h, theta)
    const outId = new ImageData(w, h)
    const od = outId.data
    const [ir, ig, ib] = hexToRgb01(p.inkColor)
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      const a = cov[i]
      let cr: number, cg: number, cb: number
      if (p.keepArt) {
        cr = d[j] / 255
        cg = d[j + 1] / 255
        cb = d[j + 2] / 255
      } else {
        cr = ir
        cg = ig
        cb = ib
      }
      od[j] = ((1 - a + cr * a) * 255) | 0
      od[j + 1] = ((1 - a + cg * a) * 255) | 0
      od[j + 2] = ((1 - a + cb * a) * 255) | 0
      od[j + 3] = 255
    }
    octx.putImageData(outId, 0, 0)
  } else {
    // CMYK separation, multiply-composited in image space
    const d = adjId.data
    const n = w * h
    const mask = p.knockout ? buildKnockoutMask(adjId, p) : null
    const chan: Float32Array[] = [
      new Float32Array(n),
      new Float32Array(n),
      new Float32Array(n),
    ]
    let maxCh = new Float32Array(n)
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r = d[j] / 255
      const g = d[j + 1] / 255
      const b = d[j + 2] / 255
      chan[0][i] = r
      chan[1][i] = g
      chan[2][i] = b
      maxCh[i] = Math.max(r, g, b)
    }

    // 1-bit B&W prints through the black plate only — C+M+Y screens of a gray
    // image would just stack into a muddy overprint; K alone is the clean plate.
    const plates: PlateName[] =
      p.tone === 'bw'
        ? ['K']
        : p.plateFilter === 'all'
          ? ['C', 'M', 'Y', 'K']
          : [p.plateFilter]

    // start from paper, multiply each selected plate
    const acc = whctx.getImageData(0, 0, w, h) // white
    const ad = acc.data
    // for transparent output: running product of (1 - coverage) per plate
    const invUnion = p.transparent ? new Float32Array(n).fill(1) : null

    for (const name of plates) {
      const plate = PLATES[name]
      const inkMap = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        if (plate.channel >= 0) {
          inkMap[i] = Math.pow(1 - chan[plate.channel][i], 1.1) * (mask ? mask[i] : 1)
        } else {
          // full-strength black when tone = 'bw' (kStrength shapes photo K only)
          inkMap[i] =
            Math.pow(1 - maxCh[i], 1.25) *
            (p.tone === 'bw' ? 1 : p.kStrength) *
            (mask ? mask[i] : 1)
        }
      }
      const th = theta + (plate.offset * Math.PI) / 180
      const sa = buildScreenAlpha(
        inkMap,
        w,
        h,
        th,
        p.cell,
        p.dotScale,
        p.shape,
        p.crisp,
      )
      if (invUnion) {
        const cov = coverageToImage(sa, w, h, th)
        for (let i = 0; i < n; i++) invUnion[i] *= 1 - cov[i]
      }
      const layer = plateToImageData(sa, plate.rgb as [number, number, number], w, h, th)
      const ld = layer.data
      for (let j = 0; j < ad.length; j += 4) {
        ad[j] = (ad[j] * ld[j]) / 255
        ad[j + 1] = (ad[j + 1] * ld[j + 1]) / 255
        ad[j + 2] = (ad[j + 2] * ld[j + 2]) / 255
      }
    }

    if (invUnion) {
      // straight-alpha assembly: union coverage as alpha, ink color unmixed
      // from the white-paper composite so it reads correctly on any backdrop
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const a = 1 - invUnion[i]
        if (a > 0) {
          for (let c = 0; c < 3; c++) {
            const v = (ad[j + c] / 255 - (1 - a)) / a
            ad[j + c] = Math.min(255, Math.max(0, v * 255)) | 0
          }
        } else {
          ad[j] = 0
          ad[j + 1] = 0
          ad[j + 2] = 0
        }
        ad[j + 3] = (a * 255) | 0
      }
    }
    octx.putImageData(acc, 0, 0)
  }

  return performance.now() - t0
}

export const PLATE_ANGLES = (baseDeg: number) => ({
  C: (baseDeg + 15) % 180,
  M: (baseDeg + 75) % 180,
  Y: baseDeg % 180,
  K: (baseDeg + 45) % 180,
})
