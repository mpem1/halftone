/**
 * Halftone Studio — rendering engine.
 *
 * Port of the validated Python pipeline to Canvas2D + typed arrays.
 * Pipeline per screen layer:
 *   1. Rotate the (adjusted) source into screen space via canvas transform.
 *   2. Build the ink map (luminance / CMY channel), multiplied by an
 *      analytic validity mask so nothing outside the real image dots.
 *   3. Per-cell average -> area-proportional mark size (dot/square/diamond/
 *      ellipse radius, or line half-thickness).
 *   4. Per-pixel coverage with a 1px AA band, colored by flat ink or by the
 *      source artwork itself ("keep art" mode).
 *   5. Rotate the composite back into image orientation.
 * CMYK mode renders 4 independently-angled plates and multiply-composites
 * them in image space.
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

export interface HalftoneParams {
  mode: OutputMode
  shape: ScreenShape
  angleDeg: number // 0..180 base screen angle
  cell: number // screen pitch in px (3..24)
  dotScale: number // 0.2..1.2 mark size factor
  keepArt: boolean // fill marks with source artwork color (single mode)
  saturation: number // -1..1 (0 = unchanged)
  contrast: number // -1..1 (0 = unchanged)
  blackWhite: boolean // force desaturation
  kStrength: number // 0..1 black-plate strength in CMYK mode
  plateFilter: PlateFilter // which CMYK plate(s) to show
  inkColor: string // hex, single mode
  transparent: boolean // marks on transparent background (alpha PNG)
  hardAlpha: boolean // threshold alpha — no semi-transparent pixels
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
  saturation: 0,
  contrast: 0,
  blackWhite: false,
  kStrength: 0.55,
  plateFilter: 'all',
  inkColor: '#000000',
  transparent: false,
  hardAlpha: false,
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

/** Apply saturation / contrast / B&W to an ImageData in place. */
function adjustImageData(img: ImageData, p: HalftoneParams): void {
  const sat = p.blackWhite ? 0 : 1 + p.saturation
  const con = 1 + p.contrast
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
    d[i] = r <= 0 ? 0 : r >= 1 ? 255 : (r * 255) | 0
    d[i + 1] = g <= 0 ? 0 : g >= 1 ? 255 : (g * 255) | 0
    d[i + 2] = b <= 0 ? 0 : b >= 1 ? 255 : (b * 255) | 0
    d[i + 3] = 255
  }
}

/** Draw src rotated by theta into a (rw, rh) screen-space canvas. */
function drawIntoScreen(
  src: HTMLCanvasElement,
  theta: number,
  rw: number,
  rh: number,
  w: number,
  h: number,
): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = rw
  c.height = rh
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.translate(rw / 2, rh / 2)
  ctx.rotate(theta)
  ctx.translate(-w / 2, -h / 2)
  ctx.drawImage(src, 0, 0)
  return c
}

/** Draw a screen-space canvas back into image orientation on dst ctx. */
function drawBackToImage(
  screenCanvas: HTMLCanvasElement,
  dstCtx: CanvasRenderingContext2D,
  theta: number,
  rw: number,
  rh: number,
  w: number,
  h: number,
): void {
  dstCtx.save()
  dstCtx.imageSmoothingEnabled = true
  dstCtx.imageSmoothingQuality = 'high'
  dstCtx.translate(w / 2, h / 2)
  dstCtx.rotate(-theta)
  dstCtx.translate(-rw / 2, -rh / 2)
  dstCtx.drawImage(screenCanvas, 0, 0)
  dstCtx.restore()
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
      alpha[idx] = a <= 0 ? 0 : a >= 1 ? 1 : a
    }
  }

  return { alpha, means, rows, cols, rw, rh, cell }
}

/** Rotate a screen-space coverage map back to image space (0..1 per pixel). */
function coverageToImage(
  sa: ScreenAlpha,
  w: number,
  h: number,
  theta: number,
): Float32Array {
  const sc = document.createElement('canvas')
  sc.width = sa.rw
  sc.height = sa.rh
  const sctx = sc.getContext('2d')!
  const id = sctx.createImageData(sa.rw, sa.rh)
  const dd = id.data
  for (let i = 0, j = 0; i < sa.alpha.length; i++, j += 4) {
    const a = (sa.alpha[i] * 255) | 0
    dd[j] = a
    dd[j + 1] = a
    dd[j + 2] = a
    dd[j + 3] = 255
  }
  sctx.putImageData(id, 0, 0)

  const tmp = document.createElement('canvas')
  tmp.width = w
  tmp.height = h
  const tctx = tmp.getContext('2d')!
  drawBackToImage(sc, tctx, theta, sa.rw, sa.rh, w, h)
  const back = tctx.getImageData(0, 0, w, h).data
  const cov = new Float32Array(w * h)
  for (let i = 0, j = 0; i < cov.length; i++, j += 4) cov[i] = back[j] / 255
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
  octx.imageSmoothingEnabled = true
  octx.imageSmoothingQuality = 'high'

  // 1) adjusted source
  const adj = document.createElement('canvas')
  adj.width = w
  adj.height = h
  const actx = adj.getContext('2d')!
  actx.drawImage(src, 0, 0)
  const adjId = actx.getImageData(0, 0, w, h)
  adjustImageData(adjId, p)
  actx.putImageData(adjId, 0, 0)

  const theta = (p.angleDeg * Math.PI) / 180
  const paper: [number, number, number] = [1, 1, 1]
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
    const sa = buildScreenAlpha(inkMap, w, h, theta, p.cell, p.dotScale, p.shape)

    if (p.transparent) {
      // true knockout: alpha = ink coverage, straight-alpha RGBA, no paper
      const cov = coverageToImage(sa, w, h, theta)
      const outId = new ImageData(w, h)
      const od = outId.data
      const [ir, ig, ib] = hexToRgb01(p.inkColor)
      for (let i = 0, j = 0; i < w * h; i++, j += 4) {
        let a = cov[i]
        if (p.hardAlpha) a = a >= 0.5 ? 1 : 0
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

    // composite in screen space on paper
    const sc = document.createElement('canvas')
    sc.width = sa.rw
    sc.height = sa.rh
    const sctx = sc.getContext('2d')!
    const sid = sctx.createImageData(sa.rw, sa.rh)
    const sd = sid.data

    // optional per-pixel artwork color in screen space
    let artData: Uint8ClampedArray | null = null
    if (p.keepArt) {
      const art = drawIntoScreen(adj, theta, sa.rw, sa.rh, w, h)
      artData = art.getContext('2d')!.getImageData(0, 0, sa.rw, sa.rh).data
    }
    const [ir, ig, ib] = hexToRgb01(p.inkColor)

    for (let i = 0, j = 0; i < sa.alpha.length; i++, j += 4) {
      const a = sa.alpha[i]
      let cr: number, cg: number, cb: number
      if (artData) {
        const k = j
        cr = artData[k] / 255
        cg = artData[k + 1] / 255
        cb = artData[k + 2] / 255
      } else {
        cr = ir
        cg = ig
        cb = ib
      }
      sd[j] = ((paper[0] * (1 - a) + cr * a) * 255) | 0
      sd[j + 1] = ((paper[1] * (1 - a) + cg * a) * 255) | 0
      sd[j + 2] = ((paper[2] * (1 - a) + cb * a) * 255) | 0
      sd[j + 3] = 255
    }
    sctx.putImageData(sid, 0, 0)

    octx.fillStyle = '#ffffff'
    octx.fillRect(0, 0, w, h)
    drawBackToImage(sc, octx, theta, sa.rw, sa.rh, w, h)
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

    const plates: PlateName[] =
      p.plateFilter === 'all' ? ['C', 'M', 'Y', 'K'] : [p.plateFilter]

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
          inkMap[i] =
            Math.pow(1 - maxCh[i], 1.25) * p.kStrength * (mask ? mask[i] : 1)
        }
      }
      const th = theta + (plate.offset * Math.PI) / 180
      const sa = buildScreenAlpha(inkMap, w, h, th, p.cell, p.dotScale, p.shape)
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
        let a = 1 - invUnion[i]
        if (p.hardAlpha) a = a >= 0.5 ? 1 : 0
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
