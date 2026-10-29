/**
 * Probe: what does the CURRENT engine actually produce for a real photo,
 * per tone mode? Renders full previews + 8x nearest crops like the user's
 * 990% zoom, and prints midtone statistics.
 */
import sharp from 'sharp'
import {
  adjustImageData,
  blurInk,
  screenCoverage,
  DEFAULT_PARAMS,
  type HalftoneParams,
} from '../src/lib/halftone.ts'

const SRC = '/home/z/my-project/public/sample.jpg'
const OUT = '/home/z/my-project/scripts/probe-out'
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
console.log('done')
