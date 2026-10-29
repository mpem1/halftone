/**
 * Probe: zebra flow screens (ZebraTrace-style engraving).
 *
 * Verifies, for all five curve families:
 *   1. tone-true encoding — a linear ramp's measured ink matches the ramp
 *      (ZebraTrace's halfWidth = pitch/2·(wMin + k·(wMax−wMin)) with
 *      wMin→0 / wMax=1 gives average coverage == tone),
 *   2. solid black seals into full coverage for the straight families and
 *      into dense woodcut texture for the flowing ones,
 *   3. raster ↔ SVG parity (sharp-rendered vector ink vs raster coverage),
 *   4. real-photo previews + 8x crops + vector render for eyeballing,
 *   5. timing at export-scale resolution.
 */
import sharp from 'sharp'
import {promises as fs} from 'node:fs'
import {
  DEFAULT_PARAMS,
  ZEBRA_SEAL_K,
  adjustImageData,
  blurInk,
  rasterizeZebra,
  zebraRibbons,
  type HalftoneParams,
  type ZebraStyle,
} from '../src/lib/halftone.ts'
import { buildHalftoneSVG } from '../src/lib/halftoneSvg.ts'

const OUT = '/home/z/my-project/scripts/probe-out'
const SRC = '/home/z/my-project/public/sample.jpg'

type Img = { data: Uint8ClampedArray; width: number; height: number }

async function savePng(px: Uint8ClampedArray, w: number, h: number, file: string) {
  await sharp(Buffer.from(px.buffer, px.byteOffset, px.length), {
    raw: { width: w, height: h, channels: 4 },
  }).png().toFile(`${OUT}/${file}`)
}

/** gray(px) composite of a coverage buffer over white */
function composite(cov: Float32Array): Uint8ClampedArray {
  const n = cov.length
  const od = new Uint8ClampedArray(n * 4)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const v = ((1 - cov[i]) * 255) | 0
    od[j] = v
    od[j + 1] = v
    od[j + 2] = v
    od[j + 3] = 255
  }
  return od
}

/** single-mode zebra pipeline exactly like renderHalftone (DOM-free):
 *  adjust → ink map → blur → ribbons → raster. Returns coverage AND the
 *  blurred ink map so the SVG exporter reads the identical source. */
function pipeline(img: Img, p: HalftoneParams): { cov: Float32Array; ink: Float32Array } {
  adjustImageData(img as unknown as ImageData, p)
  const n = img.width * img.height
  const d = img.data
  const ink = new Float32Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const lum = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) / 255
    ink[i] = 1 - lum
  }
  blurInk(ink, img.width, img.height, p.cell)
  const crisp = p.crisp || p.tone === 'bw'
  const cov = rasterizeZebra(
    zebraRibbons(
      ink, img.width, img.height, p.cell,
      p.zebraStyle, p.zebraWidthMax, p.zebraWidthMin, p.zebraFlow,
      (p.angleDeg * Math.PI) / 180, p.dotScale,
    ),
    img.width, img.height, crisp,
  )
  return { cov, ink }
}

function meanCov(cov: Float32Array, w: number, x0: number, x1: number): number {
  const h = (cov.length / w) | 0
  let s = 0
  let c = 0
  for (let y = 0; y < h; y++) {
    for (let x = x0; x < x1; x++) {
      s += cov[y * w + x]
      c++
    }
  }
  return s / c
}

async function svgInk(svg: string, w: number, h: number): Promise<number> {
  const { data } = await sharp(Buffer.from(svg), { density: 216 })
    .resize(w * 3, h * 3)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let dark = 0
  for (let i = 0; i < data.length; i++) if (data[i] < 128) dark++
  return dark / data.length
}

/** synthetic: solid black | linear ramp (ink 0.9→0.1) | white — 420×320 */
function rampImage(): Img {
  const cw = 420
  const ch = 320
  const data = new Uint8ClampedArray(cw * ch * 4)
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const ink = x < 60 ? 1 : x >= 360 ? 0 : 0.9 - ((x - 60) / 300) * 0.8
      const v = ((1 - ink) * 255) | 0
      const j = (y * cw + x) * 4
      data[j] = v
      data[j + 1] = v
      data[j + 2] = v
      data[j + 3] = 255
    }
  }
  return { data, width: cw, height: ch }
}

const styles: ZebraStyle[] = ['waves', 'lines', 'rings', 'spiral', 'rays']

/* ------------------------------------------------------------------ */
/* 1+2+3: synthetic ramp — tone-true, solid seal, vector parity        */
/* ------------------------------------------------------------------ */

console.log('Zebra synthetic ramp (black | ramp 0.9→0.1 | white), cell=12, crisp:')
for (const style of styles) {
  const img = rampImage()
  const p: HalftoneParams = {
    ...DEFAULT_PARAMS,
    shape: 'zebra',
    zebraStyle: style,
    cell: 12,
  }
  const { cov, ink } = pipeline(img, p)
  const w = img.width

  // tone-true bands (interior columns, clear of the blur transition zones)
  const bands: Array<[number, number, number]> = [
    [100, 140, 0.9 - ((120 - 60) / 300) * 0.8],
    [180, 220, 0.9 - ((200 - 60) / 300) * 0.8],
    [260, 300, 0.9 - ((280 - 60) / 300) * 0.8],
  ]
  let err = 0
  for (const [x0, x1, want] of bands) {
    err += Math.abs(meanCov(cov, w, x0, x1) - want)
  }
  err /= bands.length
  const solid = meanCov(cov, w, 4, 52)
  const paper = meanCov(cov, w, 372, 416)

  const svg = buildHalftoneSVG({
    w: img.width,
    h: img.height,
    cell: p.cell,
    params: p,
    plates: [{ ink, theta: (p.angleDeg * Math.PI) / 180, fill: '#000000' }],
  })
  const paths = (svg.match(/<path/g) || []).length
  const vInk = await svgInk(svg, w, img.height)
  let rMean = 0
  for (let i = 0; i < cov.length; i++) rMean += cov[i]
  rMean /= cov.length
  const delta = Math.abs(vInk - rMean)

  const okTone = err < 0.08 // rays now scale width by local arc gap → tone-true at every radius
  const okSolid =
    style === 'lines' ? solid >= 0.99
    : style === 'rays' ? solid >= 0.97
    : style === 'waves' ? solid >= 0.8
    : style === 'spiral' ? solid >= 0.82
    : solid >= 0.88
  const okParity = delta < 0.025
  console.log(
    `  [${style}] tone err=${(err * 100).toFixed(2)}% ${okTone ? 'PASS' : 'FAIL'} · solid=${(solid * 100).toFixed(1)}% ${okSolid ? 'PASS' : 'FAIL'} · paper=${(paper * 100).toFixed(2)}% · svg ${paths} paths · raster=${(rMean * 100).toFixed(2)}% vec=${(vInk * 100).toFixed(2)}% Δ=${(delta * 100).toFixed(2)}% ${okParity ? 'PASS' : 'FAIL'}`,
  )
  await sharp(Buffer.from(svg)).png().toFile(`${OUT}/zebra-vec-${style}.png`)
  await fs.writeFile(`${OUT}/zebra-${style}.svg`, svg)
  await savePng(composite(cov), w, img.height, `zebra-${style}.png`)
}

/* ------------------------------------------------------------------ */
/* 4: real photo, all styles + AA variant + flow variant               */
/* ------------------------------------------------------------------ */

async function loadImage(): Promise<Img> {
  const h = await sharp(SRC).resize(900, null).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return {
    data: new Uint8ClampedArray(h.data.buffer, h.data.byteOffset, h.data.length),
    width: h.info.width,
    height: h.info.height,
  }
}

const photo = await loadImage()
console.log(`\nphoto previews (${photo.width}x${photo.height}):`)
const photoCases: Array<{ tag: string; p: Partial<HalftoneParams> }> = [
  { tag: 'waves', p: {} },
  { tag: 'lines', p: { zebraStyle: 'lines' } },
  { tag: 'rings', p: { zebraStyle: 'rings' } },
  { tag: 'spiral', p: { zebraStyle: 'spiral' } },
  { tag: 'rays', p: { zebraStyle: 'rays' } },
  { tag: 'waves-aa', p: { crisp: false } },
  { tag: 'waves-flow100', p: { zebraFlow: 1.0 } },
  { tag: 'waves-max130', p: { zebraWidthMax: 1.3 } },
]
for (const c of photoCases) {
  const clone: Img = { data: new Uint8ClampedArray(photo.data), width: photo.width, height: photo.height }
  const p: HalftoneParams = { ...DEFAULT_PARAMS, shape: 'zebra', ...c.p }
  const { cov } = pipeline(clone, p)
  await savePng(composite(cov), clone.width, clone.height, `zebra-photo-${c.tag}.png`)
  if (c.tag === 'waves' || c.tag === 'rings' || c.tag === 'spiral') {
    await sharp(`${OUT}/zebra-photo-${c.tag}.png`)
      .extract({ left: 340, top: 160, width: 120, height: 120 })
      .resize(960, 960, { kernel: 'nearest' })
      .toFile(`${OUT}/zebra-crop8x-${c.tag}.png`)
  }
  console.log(`  wrote zebra-photo-${c.tag}.png`)
}

// SVG of the photo (waves) + parity on the identical ink map
{
  const clone: Img = { data: new Uint8ClampedArray(photo.data), width: photo.width, height: photo.height }
  const p: HalftoneParams = { ...DEFAULT_PARAMS, shape: 'zebra' }
  const { cov, ink } = pipeline(clone, p)
  const svg = buildHalftoneSVG({
    w: clone.width,
    h: clone.height,
    cell: p.cell,
    params: p,
    plates: [{ ink, theta: (p.angleDeg * Math.PI) / 180, fill: '#000000' }],
  })
  await sharp(Buffer.from(svg)).png().toFile(`${OUT}/zebra-photo-waves-vec.png`)
  await fs.writeFile(`${OUT}/zebra-photo-waves.svg`, svg)
  const paths = (svg.match(/<path/g) || []).length
  let rMean = 0
  for (let i = 0; i < cov.length; i++) rMean += cov[i]
  rMean /= cov.length
  const vInk = await svgInk(svg, clone.width, clone.height)
  const delta = Math.abs(vInk - rMean)
  console.log(
    `  [svg:photo-waves] ${paths} paths · raster=${(rMean * 100).toFixed(2)}% vec=${(vInk * 100).toFixed(2)}% Δ=${(delta * 100).toFixed(2)}% ${delta < 0.025 ? 'PASS' : 'FAIL'}`,
  )
}

/* ------------------------------------------------------------------ */
/* 5: export-scale timing                                              */
/* ------------------------------------------------------------------ */

{
  const big = await sharp(SRC).resize(1800, null).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const img: Img = {
    data: new Uint8ClampedArray(big.data.buffer, big.data.byteOffset, big.data.length),
    width: big.info.width,
    height: big.info.height,
  }
  const p: HalftoneParams = { ...DEFAULT_PARAMS, shape: 'zebra', cell: 12 }
  adjustImageData(img as unknown as ImageData, p)
  const n = img.width * img.height
  const d = img.data
  const ink = new Float32Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const lum = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) / 255
    ink[i] = 1 - lum
  }
  blurInk(ink, img.width, img.height, p.cell)
  const t0 = performance.now()
  const ribs = zebraRibbons(
    ink, img.width, img.height, p.cell,
    'waves', 1, 0.03, 0.5, Math.PI / 4, 1,
  )
  const t1 = performance.now()
  const cov = rasterizeZebra(ribs, img.width, img.height, true)
  const t2 = performance.now()
  console.log(
    `\ntiming @${img.width}x${img.height} cell=12 waves crisp: ribbons ${Math.round(t1 - t0)}ms + raster ${Math.round(t2 - t1)}ms (sealK=${ZEBRA_SEAL_K})`,
  )
  void cov
}
console.log('done')
