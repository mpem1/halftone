/**
 * Halftone Studio — rendering engine.
 *
 * Screening method replicates Photoshop's halftone screens as reverse-
 * engineered from the photocraft project (crates/algo/src/quantize.rs
 * "to_bitmap Halftone" + crates/algo/src/artistic_fx.rs "HalftonePattern"):
 *
 *   1. Tone adjustments (grayscale / saturation / contrast / B&W pivot)
 *      happen FIRST, in image space — before any screening. The source is
 *      NEVER binarized here: thresholding it would erase every midtone,
 *      and the screen of a binary image is just solid blobs with dithered
 *      edges — no dot grid left. B&W's 1-bit look comes from the screen.
 *   2. The ink map (luminance / CMY channel) is lightly blurred
 *      (~16% of the cell pitch) so per-pixel screening doesn't alias.
 *   3. Every pixel is rotated into screen space and evaluated against a
 *      SPOT FUNCTION in cell-local coordinates. The spot is RANK-CALIBRATED:
 *      sampling it over a cell and sorting gives the exact threshold for any
 *      tone, so a 37% gray inks exactly 37% of every cell — dot area is
 *      proportional to tone, the property that makes halftones print right.
 *   4. The round-dot spot is the EUCLIDEAN circle screen
 *      g = 1 - √2·dist: dots are geometrically perfect circles from 0%
 *      up to ~78.5% tone (where neighboring circles physically touch),
 *      then the screen inverts into round paper holes — Photoshop's
 *      "Round" halftone screen. Rank calibration keeps dot area
 *      exactly == tone (the photocraft quantize.rs property), and the
 *      contour stays a true circle at every tone, so the SVG vector
 *      exporter can emit literal <circle> elements with identical
 *      geometry. Square / diamond / ellipse spots are conic as well and
 *      morph the same way via their ranks.
 *   5. Anti-aliasing is k×k supersampling of the 1-bit threshold (3×3 single,
 *      2×2 CMYK); "crisp" mode skips it for true 1-bit output like
 *      Photoshop's Bitmap → Halftone Screen. Line-like screens (lines /
 *      waves / zigzags) use an exact 1px analytic edge band instead.
 *   6. Near-solid SEAL, shared by every shape and BOTH engines: line bands
 *      merge once the paper gap drops below lineSeal() (~10% of the pitch);
 *      spot cells (dot / square / diamond / ellipse) merge once their ink
 *      passes SPOT_SEAL (90% — same "less than 10% paper" semantics). A
 *      sub-pixel gap renders as a dirty hairline / phase-dependent speckle
 *      in 1-bit output, leaves permanent AA pinholes in the vector, and
 *      prints as errors (ink gain closes hairlines unevenly) — so dark
 *      areas close to clean solid instead. The SVG exporter emits the
 *      shape's OWN plane-closing contour for sealed cells (an oversized
 *      circle overlapping its neighbours), never a foreign square, so a
 *      circles SVG contains circles at every tone.
 *   7. Composite flat ink or the source artwork itself ("keep art") per
 *      image pixel. CMYK mode renders 4 independently-angled plates and
 *      multiply-composites them.
 *   8. ZEBRA FLOW (ZebraTrace-style engraving): a family of curves whose
 *      stroke width is modulated by image darkness — halfWidth =
 *      pitch/2·(wMin + k·(wMax−wMin)), ZebraTrace's traced-line formula.
 *      With wMax = 1 the average inked fraction equals the image tone, the
 *      same rank-calibration property as the spot screens. Five families
 *      (waves / lines / rings / spiral / rays) flow at the screen angle;
 *      near-solid strokes widen past their touching width (ZEBRA_SEAL_K)
 *      so neighbours overlap and AA can never leave seams. Both engines
 *      share zebraRibbons() — the SVG exporter emits the same nodes as
 *      filled ribbon polygons.
 */

export type ScreenShape =
  | 'dot'
  | 'square'
  | 'diamond'
  | 'ellipse'
  | 'line'
  | 'wave'
  | 'zigzag'
  | 'zebra'

/** Zebra-flow curve families (ZebraTrace-style engraving screens).
 *  Unlike the cell screens these are curve families whose stroke width is
 *  modulated by image darkness — the family style only changes how the
 *  curves flow across the picture. */
export type ZebraStyle = 'waves' | 'lines' | 'rings' | 'spiral' | 'rays'
export type OutputMode = 'single' | 'cmyk'
export type PlateFilter = 'all' | 'C' | 'M' | 'Y' | 'K'
export type ToneMode = 'color' | 'gray' | 'bw'

export interface HalftoneParams {
  mode: OutputMode
  shape: ScreenShape
  angleDeg: number // 0..180 base screen angle
  cell: number // screen pitch in px (3..24)
  dotScale: number // 0.5..1.5 mark-area factor (1 = tone-true)
  keepArt: boolean // fill marks with source artwork color (single mode)
  tone: ToneMode // color / continuous grayscale / 1-bit black & white
  threshold: number // 0..1 B&W brightness pivot (0.5 neutral) — never binarizes the source
  saturation: number // -1..1 (0 = unchanged, applies to tone 'color')
  contrast: number // -1..1 (0 = unchanged)
  lights: number // -1..1 split-tone: − recovers blown highlights, + brightens them
  darks: number // -1..1 split-tone: + opens plugged shadows, − deepens them
  spotEnabled: boolean // targeted exposure region active
  spotX: number // region center, 0..1 of image width
  spotY: number // region center, 0..1 of image height
  spotR: number // region radius as fraction of max(w,h) — circular at any resolution
  spotExposure: number // -1..1 luminance shift inside the region (feathered edge)
  kStrength: number // 0..1 black-plate strength in CMYK mode
  plateFilter: PlateFilter // which CMYK plate(s) to show
  uniformPlates: boolean // CMYK: all plates share one angle (Photoshop Color Halftone look) vs rosette offsets
  inkColor: string // hex, single mode
  transparent: boolean // marks on transparent background (alpha PNG)
  crisp: boolean // hard 1-bit mark edges — no anti-aliasing (print mode)
  knockout: boolean // remove background-colored source areas before screening
  knockoutColor: string // hex, background color to remove
  knockoutTolerance: number // 0..0.35 how far from knockoutColor still counts
  zebraStyle: ZebraStyle // zebra shape: how the curves flow across the image
  zebraWidthMax: number // stroke width at solid black, × cell pitch (1 = tone-true)
  zebraWidthMin: number // stroke width at white, × cell pitch (hairline keeps curves visible)
  zebraFlow: number // 0..1.2 curve meander amplitude, × cell pitch
}

export const DEFAULT_PARAMS: HalftoneParams = {
  mode: 'single',
  shape: 'dot',
  angleDeg: 45,
  cell: 10,
  dotScale: 1,
  keepArt: false,
  tone: 'color',
  threshold: 0.5,
  saturation: 0,
  contrast: 0,
  lights: 0,
  darks: 0,
  spotEnabled: false,
  spotX: 0.5,
  spotY: 0.5,
  spotR: 0.22,
  spotExposure: 0,
  kStrength: 0.55,
  plateFilter: 'all',
  uniformPlates: false,
  inkColor: '#000000',
  transparent: false,
  crisp: true,
  knockout: false,
  knockoutColor: '#ffffff',
  knockoutTolerance: 0.1,
  zebraStyle: 'waves',
  zebraWidthMax: 1,
  zebraWidthMin: 0.03,
  zebraFlow: 0.7,
}

export const SHAPE_LABELS: Record<ScreenShape, string> = {
  dot: 'Dots',
  square: 'Squares',
  diamond: 'Diamonds',
  ellipse: 'Ellipses',
  line: 'Lines',
  wave: 'Waves',
  zigzag: 'Zigzags',
  zebra: 'Zebra flow',
}

export const ZEBRA_STYLE_LABELS: Record<ZebraStyle, string> = {
  waves: 'Waves',
  lines: 'Lines',
  rings: 'Rings',
  spiral: 'Spiral',
  rays: 'Rays',
}

/** CMYK plate definitions: ink rgb (0..1) + screen angle offset.
 *  Exported so the SVG exporter builds the exact same separations. */
export const PLATES = {
  C: { rgb: [0, 1, 1], offset: 15, channel: 0 },
  M: { rgb: [1, 0, 1], offset: 75, channel: 1 },
  Y: { rgb: [1, 1, 0], offset: 0, channel: 2 },
  K: { rgb: [0, 0, 0], offset: 45, channel: -1 },
} as const

export type PlateName = keyof typeof PLATES

function hexToRgb01(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return [0, 0, 0]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Apply tone + saturation / contrast to an ImageData in place.
 *  tone 'gray' desaturates to continuous luminance (real grays survive).
 *  tone 'bw' ALSO keeps the continuous tone: the 1-bit look must come from
 *  the screen itself (hard-edged dots), never from thresholding the source.
 *  A binarized image has no midtones, and screening it yields solid blobs
 *  with dithered edges instead of a dot grid. p.threshold is therefore a
 *  brightness pivot (0.5 = neutral, up to ±0.6) that shifts the tone so
 *  users can weigh the output darker or lighter — dots survive at any
 *  setting, exactly like weighing exposure before screening in a print shop.
 *
 *  Split-tone levels: p.lights / p.darks dodge+burn the two halves of the
 *  tone range independently (smoothstep-weighted so midtones blend between
 *  both). Targeted region: p.spotExposure shifts luminance inside a feathered
 *  circular area (center/radius in normalized coords → resolution-independent,
 *  preview and export land identically). Both preserve hue by scaling RGB
 *  toward the new luminance. */
export function adjustImageData(img: ImageData, p: HalftoneParams): void {
  const sat = p.tone === 'color' ? 1 + p.saturation : 0
  const con = 1 + p.contrast
  const shift = p.tone === 'bw' ? (p.threshold - 0.5) * 1.2 : 0
  const li = p.lights
  const da = p.darks
  const split = li !== 0 || da !== 0
  const spotAmt = p.spotEnabled ? p.spotExposure : 0
  const spotOn = spotAmt !== 0
  const w = img.width
  // spot geometry in pixels (radius normalized by max dimension → circle)
  const scx = p.spotX * w
  const scy = p.spotY * img.height
  const scr = Math.max(4, p.spotR * Math.max(w, img.height))
  const FEATHER = 0.45 // outer fraction of the radius that ramps to zero
  const d = img.data
  const ss = (t: number) => {
    const c = t < 0 ? 0 : t > 1 ? 1 : t
    return c * c * (3 - 2 * c)
  }
  let px = 0
  let py = 0
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
    // split-tone levels + targeted exposure: luminance shift, hue preserved
    if (split || spotOn) {
      const lum = 0.299 * r + 0.587 * g + 0.114 * b
      let sh = 0
      if (split) {
        sh += li * 0.5 * ss((lum - 0.25) / 0.5)
        sh += da * 0.5 * ss((0.75 - lum) / 0.5)
      }
      if (spotOn) {
        const dx = px + 0.5 - scx
        const dy = py + 0.5 - scy
        const dist = Math.sqrt(dx * dx + dy * dy) / scr
        if (dist < 1) {
          sh += spotAmt * (dist < 1 - FEATHER ? 1 : ss((1 - dist) / FEATHER))
        }
      }
      if (sh !== 0) {
        if (lum > 0.02) {
          const f = (lum + sh) / lum
          r *= f
          g *= f
          b *= f
        } else {
          r += sh
          g += sh
          b += sh
        }
      }
    }
    if (shift !== 0) {
      r += shift
      g += shift
      b += shift
    }
    d[i] = r <= 0 ? 0 : r >= 1 ? 255 : (r * 255) | 0
    d[i + 1] = g <= 0 ? 0 : g >= 1 ? 255 : (g * 255) | 0
    d[i + 2] = b <= 0 ? 0 : b >= 1 ? 255 : (b * 255) | 0
    d[i + 3] = 255
    px++
    if (px === w) {
      px = 0
      py++
    }
  }
}

/* ------------------------------------------------------------------ */
/* Screening core                                                      */
/* ------------------------------------------------------------------ */

/** Spot value g(u01, v01) in [0..1]-ish: 1 at the cell center (first ink),
 *  falling to ≤0 at the last inked contour. u01/v01 ∈ [0,1).
 *  sx = absolute screen x in px (wave phase), cell = pitch in px. */
function spotValue(
  shape: ScreenShape,
  u01: number,
  v01: number,
  sx: number,
  cell: number,
): number {
  switch (shape) {
    case 'dot': {
      // Euclidean circle screen (Photoshop "Round"): contour is a true
      // circle of radius (1-g)/√2 in cell units — dots stay perfect
      // circles until they touch at ~78.5% tone, then invert into round
      // paper holes. Max distance across the cell is √(½)·√2 = 1, so the
      // spot spans exactly [0..1] and rank-calibrates cleanly.
      const dx = u01 - 0.5
      const dy = v01 - 0.5
      return 1 - Math.sqrt(dx * dx + dy * dy) * Math.SQRT2
    }
    case 'square': {
      const a = Math.abs(u01 * 2 - 1)
      const b = Math.abs(v01 * 2 - 1)
      return 1 - (a > b ? a : b)
    }
    case 'diamond': {
      return 1 - (Math.abs(u01 * 2 - 1) + Math.abs(v01 * 2 - 1)) * 0.5
    }
    case 'ellipse': {
      const a = (u01 * 2 - 1) / 1.55
      const b = (v01 * 2 - 1) / 1.1
      return 1 - Math.sqrt(a * a + b * b)
    }
    default:
      return 1
  }
}

/** Rank-calibrated thresholds per spot shape, cached: the spot sampled over
 *  a cell and sorted ascending. For tone t (0..1 ink) the threshold is
 *  table[(1-t)·(n-1)] — the value whose rank leaves exactly t of the cell
 *  above it, so inked area == tone (photocraft quantize.rs ranking). */
const SPOT_RES = 96
const spotTables = new Map<ScreenShape, Float32Array>()
function getSpotTable(shape: ScreenShape): Float32Array {
  let t = spotTables.get(shape)
  if (!t) {
    t = new Float32Array(SPOT_RES * SPOT_RES)
    for (let i = 0; i < t.length; i++) {
      t[i] = spotValue(
        shape,
        ((i % SPOT_RES) + 0.5) / SPOT_RES,
        (((i / SPOT_RES) | 0) + 0.5) / SPOT_RES,
        0,
        8,
      )
    }
    t.sort()
    spotTables.set(shape, t)
  }
  return t
}

/** bilinear sample of a float map at fractional pixel coords (clamped).
 *  Shared by the raster screener's cell seal and the SVG exporter so both
 *  read the ink map identically. */
export function sampleMap(
  map: Float32Array,
  w: number,
  h: number,
  x: number,
  y: number,
): number {
  const cx = x < 0 ? 0 : x > w - 1 ? w - 1 : x
  const cy = y < 0 ? 0 : y > h - 1 ? h - 1 : y
  const x0 = cx | 0
  const y0 = cy | 0
  const x1 = x0 + 1 < w ? x0 + 1 : x0
  const y1 = y0 + 1 < h ? y0 + 1 : y0
  const fx = cx - x0
  const fy = cy - y0
  const a = map[y0 * w + x0]
  const b = map[y0 * w + x1]
  const c = map[y1 * w + x0]
  const d = map[y1 * w + x1]
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy
}

/** Near-solid seal for the spot shapes (dot / square / diamond / ellipse):
 *  a cell whose ink AND scaled tone both reach this merges into solid —
 *  the identical rule lives in the SVG exporter. Below ~10% paper the
 *  leftover white is winding hairline channels between almost-merged dots:
 *  they render as phase-dependent speckle in 1-bit output, leave AA
 *  pinholes in the vector, and print as errors (ink gain closes them
 *  unevenly) — dark areas close to clean solid instead. */
export const SPOT_SEAL = 0.9

const isLineLike = (shape: ScreenShape) =>
  shape === 'line' || shape === 'wave' || shape === 'zigzag'

/** Paper-gap seal for line-like screens: once the white gap between
 *  neighbouring lines drops below this length (px), the eye reads it as a
 *  dirty hairline rather than a tone — 1-bit sampling renders it as
 *  phase-dependent dotted white rows, and vector anti-aliasing leaves a
 *  permanent light seam between strips that merely abut. Both the raster
 *  screener and the SVG exporter merge the bands to solid at the SAME
 *  threshold (a fraction of the pitch, so preview and export agree at any
 *  resolution) — dark areas read solid instead of striped. */
export function lineSeal(cell: number): number {
  return Math.max(0.5, cell * 0.1)
}

/** Rank-calibrated threshold for tone t (0..1): the spot value whose
 *  contour leaves exactly t of every cell inked. Shared by the raster
 *  screener AND the SVG exporter so both produce identical geometry. */
export function spotThreshold(shape: ScreenShape, t: number): number {
  const table = getSpotTable(shape)
  return table[Math.min(table.length - 1, ((1 - t) * (table.length - 1)) | 0)]
}

/** Two box-blur passes ≈ gaussian. Keeps per-pixel screening from aliasing
 *  image detail finer than the screen pitch (photocraft blurs lum by
 *  cell*0.15 in HalftonePattern). */
export function blurInk(src: Float32Array, w: number, h: number, cell: number): Float32Array {
  const r = Math.max(1, Math.round(cell * 0.16))
  let a = src
  let b = new Float32Array(w * h)
  for (let pass = 0; pass < 2; pass++) {
    // horizontal a -> b
    for (let y = 0; y < h; y++) {
      const row = y * w
      let sum = 0
      for (let k = -r; k <= r; k++) sum += a[row + Math.min(w - 1, Math.max(0, k))]
      const norm = 1 / (2 * r + 1)
      for (let x = 0; x < w; x++) {
        b[row + x] = sum * norm
        const add = a[row + Math.min(w - 1, x + r + 1)]
        const sub = a[row + Math.max(0, x - r)]
        sum += add - sub
      }
    }
    // vertical b -> a
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let k = -r; k <= r; k++) sum += b[Math.min(h - 1, Math.max(0, k)) * w + x]
      const norm = 1 / (2 * r + 1)
      for (let y = 0; y < h; y++) {
        a[y * w + x] = sum * norm
        const add = b[Math.min(h - 1, y + r + 1) * w + x]
        const sub = b[Math.max(0, y - r) * w + x]
        sum += add - sub
      }
    }
  }
  return a
}

/**
 * Per-pixel halftone screen — the heart of the engine.
 * ink: (w*h) ink amounts 0..1 (already adjusted + blurred).
 * Returns (w*h) mark coverage 0..1.
 */
export function screenCoverage(
  ink: Float32Array,
  w: number,
  h: number,
  theta: number,
  cell: number,
  markScale: number,
  shape: ScreenShape,
  crisp: boolean,
  ss: number, // supersampling factor (1 = hard 1-bit at pixel centers)
): Float32Array {
  const out = new Float32Array(w * h)
  const ca = Math.cos(theta)
  const sa = Math.sin(theta)
  const lineLike = isLineLike(shape)
  const table = lineLike ? null : getSpotTable(shape)
  const nTab = table ? table.length : 0
  const half = cell * 0.5
  const amp = cell * 0.28
  const ssInv = 1 / ss
  const lineHalf = lineLike ? half : 0

  for (let y = 0; y < h; y++) {
    const uy = y + 0.5 - h / 2
    const row = y * w
    for (let x = 0; x < w; x++) {
      const t0 = ink[row + x]
      if (t0 <= 0.004) continue
      // mark scale: spot shapes scale AREA (t·s²), lines scale thickness
      const t = lineLike ? t0 * markScale : t0 * markScale * markScale
      if (t >= 0.996) {
        out[row + x] = 1
        continue
      }
      const tt = t > 1 ? 1 : t
      // pixel -> screen space (rotation about image center, dot-centered grid)
      const ux = x + 0.5 - w / 2
      const rx = ca * ux - sa * uy
      const ry = sa * ux + ca * uy

      if (lineLike) {
        // rows of constant screen-y; thickness fraction == ink exactly
        let vy = ry + half
        vy -= Math.floor(vy / cell) * cell
        vy -= half
        let off = 0
        if (shape === 'wave') {
          off = amp * Math.sin((rx * Math.PI) / cell)
        } else if (shape === 'zigzag') {
          const period = cell * 2
          let q = rx / period
          q -= Math.floor(q)
          const tri = q < 0.5 ? q * 2 : 2 - q * 2
          off = amp * (tri * 2 - 1)
        }
        const hh = tt * lineHalf
        // near-solid seal: merge the band into solid once the paper gap to
        // the neighbouring lines hits the seal threshold — identical rule in
        // the SVG exporter (lineSeal), so preview and vector stay identical
        if (cell - hh * 2 <= lineSeal(cell)) {
          out[row + x] = 1
          continue
        }
        const d = vy - off
        const ad = d < 0 ? -d : d
        out[row + x] = crisp
          ? ad <= hh
            ? 1
            : 0
          : ad >= hh + 0.5
            ? 0
            : ad <= hh - 0.5
              ? 1
              : 0.5 + hh - ad
        continue
      }

      // spot shapes: near-solid cells SEAL into solid (same rule as the SVG
      // exporter). The CELL's center ink decides — not this pixel's — so
      // raster and vector seal the exact same set of cells
      if (tt >= SPOT_SEAL) {
        const kx = Math.round(rx / cell)
        const ky = Math.round(ry / cell)
        const ix = ca * (kx * cell) + sa * (ky * cell) + w / 2 - 0.5
        const iy = -sa * (kx * cell) + ca * (ky * cell) + h / 2 - 0.5
        if (sampleMap(ink, w, h, ix, iy) >= SPOT_SEAL) {
          out[row + x] = 1
          continue
        }
      }

      // threshold = rank-calibrated spot value for this tone
      const sStar = table![((1 - tt) * (nTab - 1)) | 0]
      if (ss <= 1 || crisp) {
        const u01 = (rx + half) / cell
        const v01 = (ry + half) / cell
        const g = spotValue(shape, u01 - Math.floor(u01), v01 - Math.floor(v01), rx, cell)
        out[row + x] = g > sStar ? 1 : 0
      } else {
        let cnt = 0
        for (let qy = 0; qy < ss; qy++) {
          const oy = ((qy + 0.5) * ssInv - 0.5)
          const v01r = (ry + oy + half) / cell
          const vf = v01r - Math.floor(v01r)
          for (let qx = 0; qx < ss; qx++) {
            const ox = ((qx + 0.5) * ssInv - 0.5)
            const u01r = (rx + ox + half) / cell
            const uf = u01r - Math.floor(u01r)
            if (spotValue(shape, uf, vf, rx + ox, cell) > sStar) cnt++
          }
        }
        out[row + x] = cnt / (ss * ss)
      }
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Zebra flow — ZebraTrace-style engraving screens                     */
/* ------------------------------------------------------------------ */

/** One variable-width stroke: a polyline (image-space points) plus the
 *  half-width at every node. `closed` marks looping families (rings).
 *  The SVG exporter emits the SAME nodes as filled ribbon polygons, so
 *  preview and vector share geometry exactly like the cell screens. */
export interface ZebraRibbon {
  pts: Float32Array // xy pairs along the centerline
  hw: Float32Array // stroke half-width at each node (px)
  closed: boolean
}

/** Near-solid seal for zebra strokes: once local darkness passes this the
 *  stroke widens past its touching width so same-tone neighbours OVERLAP
 *  by a few percent instead of merely abutting. Abutting same-color edges
 *  leave a permanent anti-aliasing seam between them (the white line
 *  between lines bug — same cure as lineSeal, but driven by tone instead
 *  of pitch, because zebra neighbour distance depends on the image). */
export const ZEBRA_SEAL_K = 0.92

/**
 * Build the zebra curve family for an ink map. Geometry lives in IMAGE
 * space — the screen angle is baked into the curve directions, so the
 * SVG exporter can emit these paths without a rotation transform.
 *
 * Tone encoding follows ZebraTrace's traced lines exactly:
 *   halfWidth = pitch/2 · (wMin + k·(wMax − wMin)),  k = darkness
 * so with wMin→0 / wMax = 1 the average inked fraction along a row equals
 * the image tone — the same rank-calibration property as the spot screens.
 * Near-solid tones (k ≥ ZEBRA_SEAL_K) widen past the touching width so
 * neighbouring strokes overlap and anti-aliasing can never leave seams.
 */
export function zebraRibbons(
  ink: Float32Array,
  w: number,
  h: number,
  cell: number,
  style: ZebraStyle,
  widthMax: number,
  widthMin: number,
  flow: number,
  theta: number,
  markScale: number,
): ZebraRibbon[] {
  const ribbons: ZebraRibbon[] = []
  const cx = w / 2
  const cy = h / 2
  const R = Math.sqrt(cx * cx + cy * cy) // half-diagonal — every family spans it

  const push = (xs: number[], ys: number[], closed: boolean, scale?: Float32Array, seal?: Float32Array) => {
    const n = xs.length
    if (n < 2) return
    const pts = new Float32Array(n * 2)
    const hw = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const x = xs[i]
      const y = ys[i]
      pts[i * 2] = x
      pts[i * 2 + 1] = y
      // `scale` lets a family modulate the LOCAL neighbour distance (rays:
      // arc gap grows with radius) so width/distance stays tone-true;
      // `seal` may widen just the near-solid branch to the WORST-side gap
      // so the seal bridges the widest paper channel without biasing tone
      const sc = scale ? scale[i] : 1
      const k = Math.min(1, sampleMap(ink, w, h, x, y) * markScale)
      if (k < 0.004) {
        hw[i] = 0
      } else if (k >= ZEBRA_SEAL_K) {
        hw[i] = cell * 0.5 * (seal ? seal[i] : sc) * Math.max(widthMax, 1.06)
      } else {
        hw[i] = cell * 0.5 * sc * (widthMin + k * (widthMax - widthMin))
      }
    }
    ribbons.push({ pts, hw, closed })
  }

  if (style === 'waves' || style === 'lines') {
    // rows of curves running along the screen angle, spaced one pitch apart.
    // ZebraTrace's wave presets undulate IN PHASE (cos(a·13)/30 — no i term):
    // parallel flowing curves keep their separation, so the amplitude can
    // safely reach a full pitch without rows ever crossing
    const dirX = Math.cos(theta)
    const dirY = Math.sin(theta)
    const nrmX = -dirY
    const nrmY = dirX
    const J = Math.ceil(R / cell) + 1
    const amp = style === 'waves' ? Math.min(flow, 1.2) * 0.9 * cell : 0
    const step = style === 'waves' ? cell / 6 : cell / 3
    const xs: number[] = []
    const ys: number[] = []
    for (let j = -J; j <= J; j++) {
      xs.length = 0
      ys.length = 0
      const ox = cx + nrmX * (j * cell)
      const oy = cy + nrmY * (j * cell)
      // slight per-row phase drift keeps the flow organic without crossing
      const phase = j * 0.35
      for (let s = -R; s <= R; s += step) {
        let x = ox + dirX * s
        let y = oy + dirY * s
        if (amp > 0) {
          const off = amp * Math.sin((s * 2 * Math.PI) / (cell * 13) + phase)
          x += nrmX * off
          y += nrmY * off
        }
        xs.push(x)
        ys.push(y)
      }
      push(xs, ys, false)
    }
  } else if (style === 'rings') {
    // concentric guilloché circles around the image center; a gentle radial
    // wobble (phase-shifting per ring) keeps them organic, never crossing
    const wob = Math.min(flow, 1.2) * 0.3 * cell
    const J = Math.ceil(R / cell)
    for (let j = 1; j <= J; j++) {
      const r0 = j * cell
      const dPhi = Math.max(1.2, cell / 6) / r0
      const xs: number[] = []
      const ys: number[] = []
      for (let phi = 0; phi < 2 * Math.PI; phi += dPhi) {
        const r = r0 + (wob > 0 ? wob * Math.sin(6 * phi + j * 1.7) : 0)
        xs.push(cx + r * Math.cos(phi))
        ys.push(cy + r * Math.sin(phi))
      }
      push(xs, ys, true)
    }
  } else if (style === 'spiral') {
    // one Archimedean spiral: one pitch per turn, from the center out
    const wob = Math.min(flow, 1.2) * 0.2 * cell
    const step = Math.max(1.2, cell / 6)
    const xs: number[] = []
    const ys: number[] = []
    // half-twist start so the innermost step is finite; anchor the center
    let phi = Math.PI / 4
    xs.push(cx)
    ys.push(cy)
    for (;;) {
      let r = (cell * phi) / (2 * Math.PI)
      if (wob > 0) r += wob * Math.sin(0.5 * phi)
      if (r > R) break
      xs.push(cx + r * Math.cos(phi))
      ys.push(cy + r * Math.sin(phi))
      phi += step / Math.max(r, 0.5)
    }
    push(xs, ys, false)
  } else {
    // rays: a fan of straight strokes through an EXTERNAL vanishing point.
    // Center-converging spokes can't be tone-true (neighbour arc gap ∝
    // radius collapses to zero at the pivot — strokes thin to stipple) or
    // printable (uncompensated, the interior over-inks 2×). A pivot at
    // D = 2.5·R keeps the arc gap within ±40% of the pitch across the whole
    // image, and each stroke's width still scales with its LOCAL gap, so
    // ink fraction == tone everywhere while the curves stay visible
    const D = 2.5 * R
    const px = cx + Math.cos(theta + Math.PI / 2) * D
    const py = cy + Math.sin(theta + Math.PI / 2) * D
    const N = Math.max(12, Math.round((2 * Math.PI * D) / cell))
    const wob = Math.min(flow, 1.2) * 0.3
    const step = cell / 3
    const cnt = Math.ceil((D + R) / step) + 1
    const scale = new Float32Array(cnt)
    const seal = new Float32Array(cnt)
    for (let j = 0; j < N; j++) {
      const a = theta + (j * 2 * Math.PI) / N
      const xs: number[] = []
      const ys: number[] = []
      for (let i = 0; i < cnt; i++) {
        const d = i * step
        // tone width follows the IDEAL arc gap (d·2π/N — wobble averages
        // out); the seal follows the gap to the WIDEST side, wobble
        // included, so it bridges the worst paper channel without biasing
        // midtone ink
        const F = (d / cell) * 0.9
        const wA = (wob * cell) / Math.max(d, cell)
        const s0 = wob > 0 ? Math.sin(F + j * 2.1) : 0
        const sUp = wob > 0 ? Math.sin(F + (j + 1) * 2.1) : 0
        const sDn = wob > 0 ? Math.sin(F + (j - 1) * 2.1) : 0
        const gapUp = d * (2 * Math.PI / N + (sUp - s0) * wA)
        const gapDn = d * (2 * Math.PI / N + (s0 - sDn) * wA)
        scale[i] = Math.max(0.02, ((d * 2 * Math.PI) / N) / cell)
        seal[i] = Math.max(0.02, Math.max(gapUp, gapDn) / cell)
        // angular wobble amplitude ∝ 1/d so the TANGENTIAL displacement
        // stays a constant fraction of the pitch — constant radians would
        // swing the far end by hundreds of px and rays would cross
        const aa = a + (wob > 0 ? wA * s0 : 0)
        xs.push(px + d * Math.cos(aa))
        ys.push(py + d * Math.sin(aa))
      }
      push(xs, ys, false, scale, seal)
    }
  }
  return ribbons
}

/**
 * Rasterize zebra ribbons into the coverage buffer (union — strokes may
 * overlap freely). Each segment becomes two triangles; crisp mode tests
 * pixel centers (1-bit like the cell screens), smooth mode averages a
 * 3×3 subsample grid for anti-aliased edges.
 */
export function rasterizeZebra(
  ribbons: ZebraRibbon[],
  w: number,
  h: number,
  crisp: boolean,
): Float32Array {
  const out = new Float32Array(w * h)

  const tri = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
  ) => {
    const minx = Math.max(0, Math.floor(Math.min(ax, bx, cx)))
    const maxx = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)))
    if (minx > maxx) return
    const miny = Math.max(0, Math.floor(Math.min(ay, by, cy)))
    const maxy = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)))
    if (miny > maxy) return
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (area === 0) return
    const pos = area > 0
    if (crisp) {
      for (let y = miny; y <= maxy; y++) {
        const py = y + 0.5
        const row = y * w
        for (let x = minx; x <= maxx; x++) {
          const px = x + 0.5
          const e1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
          if (e1 > 0 !== pos && e1 !== 0) continue
          const e2 = (cx - bx) * (py - by) - (cy - by) * (px - bx)
          if (e2 > 0 !== pos && e2 !== 0) continue
          const e3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx)
          if (e3 > 0 !== pos && e3 !== 0) continue
          out[row + x] = 1
        }
      }
    } else {
      const e1x = bx - ax
      const e1y = by - ay
      const e2x = cx - bx
      const e2y = cy - by
      const e3x = ax - cx
      const e3y = ay - cy
      for (let y = miny; y <= maxy; y++) {
        const row = y * w
        for (let x = minx; x <= maxx; x++) {
          let cnt = 0
          for (let q = 0; q < 9; q++) {
            const px = x + ((q % 3) + 0.5) / 3
            const py = y + (((q / 3) | 0) + 0.5) / 3
            let e = e1x * (py - ay) - e1y * (px - ax)
            if (e > 0 !== pos && e !== 0) continue
            e = e2x * (py - by) - e2y * (px - bx)
            if (e > 0 !== pos && e !== 0) continue
            e = e3x * (py - cy) - e3y * (px - cx)
            if (e > 0 !== pos && e !== 0) continue
            cnt++
          }
          const c = cnt / 9
          if (c > out[row + x]) out[row + x] = c
        }
      }
    }
  }

  for (const rb of ribbons) {
    const { pts, hw, closed } = rb
    const n = hw.length
    const segs = closed ? n : n - 1
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n
      const hw0 = hw[i]
      const hw1 = hw[j]
      if (hw0 <= 0.01 && hw1 <= 0.01) continue
      let tx = pts[j * 2] - pts[i * 2]
      let ty = pts[j * 2 + 1] - pts[i * 2 + 1]
      const tl = Math.sqrt(tx * tx + ty * ty)
      if (tl < 1e-6) continue
      tx /= tl
      ty /= tl
      const nx = -ty
      const ny = tx
      const x0 = pts[i * 2]
      const y0 = pts[i * 2 + 1]
      const x1 = pts[j * 2]
      const y1 = pts[j * 2 + 1]
      // ribbon quad corners (left/right of travel direction)
      const lx0 = x0 + nx * hw0
      const ly0 = y0 + ny * hw0
      const rx0 = x0 - nx * hw0
      const ry0 = y0 - ny * hw0
      const lx1 = x1 + nx * hw1
      const ly1 = y1 + ny * hw1
      const rx1 = x1 - nx * hw1
      const ry1 = y1 - ny * hw1
      tri(lx0, ly0, lx1, ly1, rx1, ry1)
      tri(lx0, ly0, rx1, ry1, rx0, ry0)
    }
  }
  return out
}

/** Mask: 0 where source pixel matches the knockout color, 1 elsewhere.
 *  Soft ramp between tol and tol*1.25 so boundaries fade rather than jag. */
export function buildKnockoutMask(img: ImageData, p: HalftoneParams): Float32Array {
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

/** Main entry: render params onto out canvas at source resolution.
 *  maxDim: optional working-resolution cap for fast interactive previews.
 *  cellScale: multiplies the screen pitch — pass outWidth/previewWidth when
 *  rendering the same view at a higher resolution so the printed ruling
 *  (dots per image width) stays IDENTICAL to the preview. */
export function renderHalftone(
  src: HTMLCanvasElement,
  out: HTMLCanvasElement,
  p: HalftoneParams,
  maxDim?: number,
  cellScale = 1,
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
  const cell = Math.max(2, p.cell * cellScale)
  const n = w * h
  // AA quality: k×k supersampling of the 1-bit threshold. Small cells get
  // extra samples so tiny dots keep their circular silhouette instead of
  // collapsing into pixel squares (4×4 single / 3×3 CMYK at cell < 8).
  const crisp = p.crisp || p.tone === 'bw'
  const ss = crisp
    ? 1
    : p.mode === 'cmyk'
      ? cell < 8
        ? 3
        : 2
      : cell < 8
        ? 4
        : 3
  // screen dispatch: cell-grid shapes go through the spot screener, zebra
  // flow builds its curve family and rasterizes variable-width strokes
  const coverage = (inkMap: Float32Array, th: number): Float32Array => {
    if (p.shape === 'zebra') {
      const ribs = zebraRibbons(
        inkMap, w, h, cell,
        p.zebraStyle, p.zebraWidthMax, p.zebraWidthMin, p.zebraFlow,
        th, p.dotScale,
      )
      return rasterizeZebra(ribs, w, h, crisp)
    }
    return screenCoverage(inkMap, w, h, th, cell, p.dotScale, p.shape, crisp, ss)
  }

  if (p.mode === 'single') {
    // ink map from adjusted luminance (+ background knockout)
    const d = adjId.data
    const mask = p.knockout ? buildKnockoutMask(adjId, p) : null
    const inkMap: Float32Array = new Float32Array(n)
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const lum = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) / 255
      inkMap[i] = (1 - lum) * (mask ? mask[i] : 1)
    }
    const blurred = blurInk(inkMap, w, h, cell)
    const cov = coverage(blurred, theta)

    if (p.transparent) {
      // true knockout: alpha = ink coverage, straight-alpha RGBA, no paper
      const outId = new ImageData(w, h)
      const od = outId.data
      const [ir, ig, ib] = hexToRgb01(p.inkColor)
      for (let i = 0, j = 0; i < n; i++, j += 4) {
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

    // composite in image space: ink color or the adjusted artwork itself
    const outId = new ImageData(w, h)
    const od = outId.data
    const [ir, ig, ib] = hexToRgb01(p.inkColor)
    for (let i = 0, j = 0; i < n; i++, j += 4) {
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
    const mask = p.knockout ? buildKnockoutMask(adjId, p) : null
    const chan: Float32Array[] = [
      new Float32Array(n),
      new Float32Array(n),
      new Float32Array(n),
    ]
    const maxCh = new Float32Array(n)
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
    const acc = new Float32Array(n * 3).fill(1)
    // for transparent output: running product of (1 - coverage) per plate
    const invUnion = p.transparent ? new Float32Array(n).fill(1) : null

    for (const name of plates) {
      const plate = PLATES[name]
      const inkMap = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        if (plate.channel >= 0) {
          inkMap[i] = (1 - chan[plate.channel][i]) * (mask ? mask[i] : 1)
        } else {
          // full-strength black when tone = 'bw' (kStrength shapes photo K only)
          inkMap[i] =
            Math.pow(1 - maxCh[i], 1.25) *
            (p.tone === 'bw' ? 1 : p.kStrength) *
            (mask ? mask[i] : 1)
        }
      }
      blurInk(inkMap, w, h, cell)
      // Rosette mode: classic ink angles (C+15 M+75 Y+0 K+45 from the base —
      // the US standard set rotated). Uniform mode: every plate at the base
      // angle, replicating Photoshop Color Halftone with equalized channels.
      const th =
        theta + ((p.uniformPlates ? 0 : plate.offset) * Math.PI) / 180
      const cov = coverage(inkMap, th)
      if (invUnion) {
        for (let i = 0; i < n; i++) invUnion[i] *= 1 - cov[i]
      }
      // multiply-composite this plate's layer (1 - a·(1-ink)) into acc
      const [pr, pg, pb] = plate.rgb
      for (let i = 0, j = 0; i < n; i++, j += 3) {
        const a = cov[i]
        acc[j] *= 1 - a * (1 - pr)
        acc[j + 1] *= 1 - a * (1 - pg)
        acc[j + 2] *= 1 - a * (1 - pb)
      }
    }

    const outId = new ImageData(w, h)
    const od = outId.data
    if (invUnion) {
      // straight-alpha assembly: union coverage as alpha, ink color unmixed
      // from the white-paper composite so it reads correctly on any backdrop
      for (let i = 0, j = 0, q = 0; i < n; i++, j += 4, q += 3) {
        const a = 1 - invUnion[i]
        if (a > 0) {
          for (let c = 0; c < 3; c++) {
            const v = (acc[q + c] - (1 - a)) / a
            od[j + c] = Math.min(255, Math.max(0, v * 255)) | 0
          }
        } else {
          od[j] = 0
          od[j + 1] = 0
          od[j + 2] = 0
        }
        od[j + 3] = (a * 255) | 0
      }
    } else {
      for (let i = 0, j = 0, q = 0; i < n; i++, j += 4, q += 3) {
        od[j] = (acc[q] * 255) | 0
        od[j + 1] = (acc[q + 1] * 255) | 0
        od[j + 2] = (acc[q + 2] * 255) | 0
        od[j + 3] = 255
      }
    }
    octx.putImageData(outId, 0, 0)
  }

  return performance.now() - t0
}

export const PLATE_ANGLES = (baseDeg: number) => ({
  C: (baseDeg + 15) % 180,
  M: (baseDeg + 75) % 180,
  Y: baseDeg % 180,
  K: (baseDeg + 45) % 180,
})
