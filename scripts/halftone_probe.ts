/**
 * Probe: what does the CURRENT engine actually produce for a real photo,
 * per tone mode? Renders full previews + 8x nearest crops like the user's
 * 990% zoom, and prints midtone statistics.
 */
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import {
  adjustImageData,
  blurInk,
  screenCoverage,
  DEFAULT_PARAMS,
  type HalftoneParams,
} from '../src/lib/halftone.ts'
import { buildHalftoneSVG } from '../src/lib/halftoneSvg.ts'

const SRC = `${import.meta.dir}/../public/sample.jpg`
const OUT = `${import.meta.dir}/probe-out`
mkdirSync(OUT, { recursive: true })
const W = 900 // working width similar to app's capped preview

type Img = { data: Uint8ClampedArray; width: number; height: number }

async function loadImage(): Promise<Img> {
  const h = await sharp(SRC).resize(W, null).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return {
    data: new Uint8ClampedArray(h.data.buffer, h.data.byteOffset, h.data.length),
    width: h.info.width,
    height: h.info.height,
  }
}

/** single-mode composite: coverage -> ink over white (mirrors renderHalftone) */
function composite(cov: Float32Array, img: Img, inkRgb: [number, number, number], keepArt: boolean): Uint8ClampedArray {
  const n = img.width * img.height
  const od = new Uint8ClampedArray(n * 4)
  const d = img.data
  for (let i = 0, j = 0, q = 0; i < n; i++, j += 4, q += 4) {
    const a = cov[i]
    const cr = keepArt ? d[q] / 255 : inkRgb[0]
    const cg = keepArt ? d[q + 1] / 255 : inkRgb[1]
    const cb = keepArt ? d[q + 2] / 255 : inkRgb[2]
    od[j] = ((1 - a + cr * a) * 255) | 0
    od[j + 1] = ((1 - a + cg * a) * 255) | 0
    od[j + 2] = ((1 - a + cb * a) * 255) | 0
    od[j + 3] = 255
  }
  return od
}

async function savePng(px: Uint8ClampedArray, w: number, h: number, file: string) {
  await sharp(Buffer.from(px.buffer, px.byteOffset, px.length), {
    raw: { width: w, height: h, channels: 4 },
  }).png().toFile(`${OUT}/${file}`)
}

async function crop8x(file: string, tag: string, cx: number, cy: number, size = 110) {
  const left = Math.max(0, cx - size / 2), top = Math.max(0, cy - size / 2)
  await sharp(`${OUT}/${file}`)
    .extract({ left, top, width: size, height: size })
    .resize(size * 8, size * 8, { kernel: 'nearest' })
    .toFile(`${OUT}/crop8x-${tag}.png`)
}

function inkStats(ink: Float32Array, tag: string) {
  let solid = 0, mid = 0, empty = 0
  for (let i = 0; i < ink.length; i++) {
    const v = ink[i]
    if (v >= 0.95) solid++
    else if (v > 0.05) mid++
    else empty++
  }
  const pct = (x: number) => ((x / ink.length) * 100).toFixed(1)
  console.log(`  [${tag}] solid=${pct(solid)}%  midtone(dots zone)=${pct(mid)}%  paper=${pct(empty)}%`)
}

const img = await loadImage()
console.log(`source: ${img.width}x${img.height}`)

const scenarios: Array<{ tag: string; p: Partial<HalftoneParams> }> = [
  { tag: 'color-default', p: {} },
  { tag: 'gray', p: { tone: 'gray' } },
  { tag: 'bw-fixed', p: { tone: 'bw', threshold: 0.5 } },
  { tag: 'bw-level65', p: { tone: 'bw', threshold: 0.65 } },
  { tag: 'bw-cell14', p: { tone: 'bw', threshold: 0.5, cell: 14 } },
  { tag: 'bw-lights-rec', p: { tone: 'bw', lights: -0.5 } },
  { tag: 'bw-darks-lift', p: { tone: 'bw', darks: 0.5 } },
  {
    tag: 'bw-spot-face',
    p: {
      tone: 'bw',
      spotEnabled: true,
      spotX: 0.5,
      spotY: 0.42,
      spotR: 0.18,
      spotExposure: -0.45,
    },
  },
]

for (const s of scenarios) {
  const p: HalftoneParams = { ...DEFAULT_PARAMS, ...s.p }
  // clone source per scenario
  const clone: Img = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height }
  adjustImageData(clone as unknown as ImageData, p)

  // ink map exactly like renderHalftone single mode
  const n = clone.width * clone.height
  const d = clone.data
  const ink = new Float32Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const lum = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) / 255
    ink[i] = 1 - lum
  }
  inkStats(ink, s.tag)

  blurInk(ink, clone.width, clone.height, p.cell)
  const crisp = p.crisp || p.tone === 'bw'
  const ss = crisp ? 1 : 3
  const cov = screenCoverage(ink, clone.width, clone.height, (p.angleDeg * Math.PI) / 180, p.cell, p.dotScale, p.shape, crisp, ss)
  const px = composite(cov, clone, [0, 0, 0], false)

  // 1-bit verification for bw: every pixel must be exactly 0 or 255
  if (p.tone === 'bw') {
    let bad = 0
    for (let j = 0; j < px.length; j += 4) {
      const v = px[j]
      if (v !== 0 && v !== 255) bad++
    }
    console.log(`  [${s.tag}] 1-bit check: ${bad === 0 ? 'PASS (pure 0/255)' : `FAIL — ${bad} gray pixels`}`)
  }

  const file = `prev-${s.tag}.png`
  await savePng(px, clone.width, clone.height, file)
  await crop8x(file, s.tag, (clone.width * 0.5) | 0, (clone.height * 0.45) | 0)
  console.log(`  wrote ${file} + crop8x-${s.tag}.png (ss=${ss}, crisp=${crisp}, cell=${p.cell})`)
}

/* ------------------------------------------------------------------ */
/* SVG vector export parity: synthetic tones with known answers        */
/* ------------------------------------------------------------------ */

async function svgScenario(tag: string, p: Partial<HalftoneParams>) {
  const pp: HalftoneParams = { ...DEFAULT_PARAMS, ...p }
  const cw = 400
  const ch = 300
  // left half = 50% gray (ink 0.5), right half = 25% gray (ink 0.75)
  const data = new Uint8ClampedArray(cw * ch * 4)
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const v = (x < cw / 2 ? 0.5 : 0.75) * 255
      const j = (y * cw + x) * 4
      data[j] = v
      data[j + 1] = v
      data[j + 2] = v
      data[j + 3] = 255
    }
  }
  const img2 = { data, width: cw, height: ch }
  adjustImageData(img2 as unknown as ImageData, pp)

  const n = cw * ch
  const ink = new Float32Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const lum = (0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]) / 255
    ink[i] = 1 - lum
  }
  const theta = (pp.angleDeg * Math.PI) / 180
  const cov = screenCoverage(ink, cw, ch, theta, pp.cell, pp.dotScale, pp.shape, true, 1)
  let sum = 0
  for (let i = 0; i < n; i++) sum += cov[i]
  const rasterMean = sum / n

  const svg = buildHalftoneSVG({
    w: cw,
    h: ch,
    cell: pp.cell,
    params: pp,
    plates: [{ ink, theta, fill: '#000000' }],
  })
  const circles = (svg.match(/<circle/g) || []).length
  const rects = (svg.match(/<rect/g) || []).length
  const polys = (svg.match(/<polygon/g) || []).length
  const ellipses = (svg.match(/<ellipse/g) || []).length
  await sharp(Buffer.from(svg)).toFile(`${OUT}/vec-${tag}.png`)
  // rasterize the vector at 3x and measure ink fraction (lum < 0.5)
  const { data: buf, info } = await sharp(Buffer.from(svg), { density: 216 })
    .resize(cw * 3, ch * 3)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let dark = 0
  for (let i = 0; i < buf.length; i++) if (buf[i] < 128) dark++
  const svgMean = dark / buf.length
  const delta = Math.abs(svgMean - rasterMean)
  console.log(
    `  [svg:${tag}] marks: ${circles} circles, ${rects} rects, ${polys} polys, ${ellipses} ellipses`,
  )
  console.log(
    `  [svg:${tag}] raster coverage=${(rasterMean * 100).toFixed(2)}%  vector ink=${(svgMean * 100).toFixed(2)}%  delta=${(delta * 100).toFixed(2)}% ${delta < 0.02 ? 'PASS' : 'FAIL'}`,
  )
  // zoomed crop of the vector raster for eyeballing dot roundness
  await sharp(`${OUT}/vec-${tag}.png`)
    .extract({ left: 20, top: 20, width: 110, height: 110 })
    .resize(880, 880, { kernel: 'nearest' })
    .toFile(`${OUT}/vec-crop8x-${tag}.png`)
  await sharp(Buffer.from(svg)).toFile(`${OUT}/vec-${tag}.svg`)
  void info
}

/* ------------------------------------------------------------------ */
/* Split-tone levels + targeted region: synthetic direction checks     */
/* ------------------------------------------------------------------ */

/** mean ink (1 - luminance) of left/right halves after adjustment;
 *  left = 50% gray (ink 0.5), right = 25% gray (ink 0.25) */
function meanInk(adjust: Partial<HalftoneParams>): { left: number; right: number } {
  const cw = 200
  const ch = 100
  const data = new Uint8ClampedArray(cw * ch * 4)
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const v = (x < cw / 2 ? 0.5 : 0.75) * 255
      const j = (y * cw + x) * 4
      data[j] = v
      data[j + 1] = v
      data[j + 2] = v
      data[j + 3] = 255
    }
  }
  const pp: HalftoneParams = { ...DEFAULT_PARAMS, ...adjust }
  adjustImageData({ data, width: cw, height: ch } as unknown as ImageData, pp)
  let ls = 0
  let rs = 0
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const j = (y * cw + x) * 4
      const lum = (0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]) / 255
      if (x < cw / 2) ls += 1 - lum
      else rs += 1 - lum
    }
  }
  const half = (cw * ch) / 2
  return { left: ls / half, right: rs / half }
}

console.log('\nSplit-tone levels + target region (left 50% gray / right 25% ink):')
{
  const base = meanInk({})
  const li = meanInk({ lights: -0.6 })
  const da = meanInk({ darks: 0.6 })
  const spL = meanInk({ spotEnabled: true, spotX: 0.25, spotY: 0.5, spotR: 0.2, spotExposure: -0.5 })
  const spR = meanInk({ spotEnabled: true, spotX: 0.75, spotY: 0.5, spotR: 0.2, spotExposure: -0.5 })
  console.log(
    `  baseline         left=${base.left.toFixed(3)} right=${base.right.toFixed(3)}`,
  )
  console.log(
    `  lights=-0.6      left=${li.left.toFixed(3)} right=${li.right.toFixed(3)}`,
  )
  console.log(
    `  darks=+0.6       left=${da.left.toFixed(3)} right=${da.right.toFixed(3)}`,
  )
  console.log(
    `  spot(-0.5)@left  left=${spL.left.toFixed(3)} right=${spR.right.toFixed(3)}`,
  )
  const t1 = li.right > base.right + 0.2 && li.left > base.left + 0.05
  const t2 = da.left < base.left - 0.08 && Math.abs(da.right - base.right) < 0.02
  const t3 = spL.left > base.left + 0.08 && Math.abs(spL.right - base.right) < 0.02
  const t4 = spR.right > base.right + 0.05 && Math.abs(spR.left - base.left) < 0.02
  console.log(
    `  lights darken highlights: ${t1 ? 'PASS' : 'FAIL'} · darks lift shadows only: ${t2 ? 'PASS' : 'FAIL'}`,
  )
  console.log(
    `  spot hits its region only (left): ${t3 ? 'PASS' : 'FAIL'} · (right): ${t4 ? 'PASS' : 'FAIL'}`,
  )
}

console.log('\nSVG vector parity (synthetic 50% / 25% ink halves):')
await svgScenario('dot', { tone: 'bw' })
await svgScenario('square', { tone: 'bw', shape: 'square' })
await svgScenario('diamond', { tone: 'bw', shape: 'diamond' })
await svgScenario('ellipse', { tone: 'bw', shape: 'ellipse' })
await svgScenario('line', { tone: 'bw', shape: 'line' })
await svgScenario('wave', { tone: 'bw', shape: 'wave' })
await svgScenario('zigzag', { tone: 'bw', shape: 'zigzag' })
console.log('done')
