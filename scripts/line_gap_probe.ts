/**
 * Line-gap probe: why do LINE screens show a white line between every line
 * even where the image should be solid black?
 *
 * Measures raster + SVG output for uniform dark tones at angle 0 (rows are
 * directly comparable) plus a 45deg mean check, saves 8x crops for eyeballing.
 * Run before AND after the seal fix to prove the fix.
 */
import sharp from 'sharp'
import {
  adjustImageData,
  blurInk,
  screenCoverage,
  DEFAULT_PARAMS,
  type HalftoneParams,
} from '../src/lib/halftone.ts'
import { buildHalftoneSVG } from '../src/lib/halftoneSvg.ts'

const OUT = '/home/z/my-project/scripts/probe-out'

type Img = { data: Uint8ClampedArray; width: number; height: number }

function uniformTone(w: number, h: number, inkAmount: number): Img {
  const v = Math.round((1 - inkAmount) * 255)
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = v
    data[i + 1] = v
    data[i + 2] = v
    data[i + 3] = 255
  }
  return { data, width: w, height: h }
}

function buildInk(img: Img, p: HalftoneParams) {
  adjustImageData(img as unknown as ImageData, p)
  const n = img.width * img.height
  const ink = new Float32Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const lum = (0.299 * img.data[j] + 0.587 * img.data[j + 1] + 0.114 * img.data[j + 2]) / 255
    ink[i] = 1 - lum
  }
  blurInk(ink, img.width, img.height, p.cell)
  return ink
}

async function savePng(px: Uint8ClampedArray, w: number, h: number, file: string) {
  await sharp(Buffer.from(px.buffer, px.byteOffset, px.length), {
    raw: { width: w, height: h, channels: 4 },
  }).png().toFile(`${OUT}/${file}`)
}

async function measureSvg(svg: string, w: number, h: number, tag: string) {
  const { data, info } = await sharp(Buffer.from(svg), { density: 216 })
    .resize(w * 3, h * 3)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let sum = 0
  let lightRows = 0
  let maxRowMin = 0
  for (let y = 0; y < info.height; y++) {
    let mn = 255
    for (let x = 0; x < info.width; x++) {
      const v = data[y * info.width + x]
      sum += 255 - v
      if (v < mn) mn = v
    }
    if (mn > 30) lightRows++
    if (mn > maxRowMin) maxRowMin = mn
  }
  const meanInk = sum / (info.width * info.height) / 255
  console.log(
    `    svg : ink=${(meanInk * 100).toFixed(2)}%  rows-with-light-run=${lightRows}/${info.height}  lightest-row-min=${maxRowMin}`,
  )
  // 6x eyeball crop of the 3x raster
  const crop = Math.min(120, info.width, info.height)
  await sharp(Buffer.from(svg), { density: 216 })
    .resize(w * 3, h * 3)
    .extract({ left: 30, top: 30, width: crop, height: crop })
    .resize(crop * 6, crop * 6, { kernel: 'nearest' })
    .toFile(`${OUT}/gap-svg-${tag}.png`)
  await sharp(Buffer.from(svg)).toFile(`${OUT}/gap-${tag}.svg`)
}

async function run(tag: string, inkAmount: number, p: Partial<HalftoneParams>) {
  const pp: HalftoneParams = { ...DEFAULT_PARAMS, ...p, shape: 'line' }
  const w = 300
  const h = 200
  const img = uniformTone(w, h, inkAmount)
  const ink = buildInk(img, pp)
  const theta = (pp.angleDeg * Math.PI) / 180
  const cov = screenCoverage(ink, w, h, theta, pp.cell, pp.dotScale, 'line', pp.crisp, 1)

  let mean = 0
  let zeroRows = 0
  let maxRowMinCov = 1
  for (let y = 0; y < h; y++) {
    let rowSum = 0
    let rowMin = 1
    for (let x = 0; x < w; x++) {
      const c = cov[y * w + x]
      rowSum += c
      if (c < rowMin) rowMin = c
    }
    mean += rowSum / w
    if (rowMin === 0) zeroRows++
    if (rowMin < maxRowMinCov) maxRowMinCov = rowMin
  }
  mean /= h
  console.log(
    `[${tag}] ink=${inkAmount} cell=${pp.cell} a=${pp.angleDeg} crisp=${pp.crisp} ms=${pp.dotScale}`,
  )
  console.log(
    `    rasp: cov=${(mean * 100).toFixed(2)}%  rows-with-white=${zeroRows}/${h}  lightest-row-min-cov=${maxRowMinCov.toFixed(2)}`,
  )
  const px = new Uint8ClampedArray(w * h * 4)
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const a = cov[i]
    const g = ((1 - a) * 255) | 0
    px[j] = g
    px[j + 1] = g
    px[j + 2] = g
    px[j + 3] = 255
  }
  await savePng(px, w, h, `gap-rasp-${tag}.png`)
  await sharp(`${OUT}/gap-rasp-${tag}.png`)
    .extract({ left: 10, top: 10, width: 40, height: 40 })
    .resize(480, 480, { kernel: 'nearest' })
    .toFile(`${OUT}/gap-rasp-crop-${tag}.png`)

  const svg = buildHalftoneSVG({
    w,
    h,
    cell: pp.cell,
    params: pp,
    plates: [{ ink, theta, fill: '#000000' }],
  })
  await measureSvg(svg, w, h, tag)
}

console.log('--- solid black (must be 100%, zero white/light rows) ---')
await run('black-c10-a0', 1.0, { tone: 'bw', cell: 10, angleDeg: 0 })
await run('black-c20-a0', 1.0, { tone: 'bw', cell: 20, angleDeg: 0 })
await run('black-c10-a45', 1.0, { tone: 'bw', cell: 10, angleDeg: 45 })
await run('black-c10-soft', 1.0, { tone: 'gray', cell: 10, angleDeg: 0, crisp: false })
await run('black-c10-ms13', 1.0, { tone: 'bw', cell: 10, angleDeg: 0, dotScale: 1.3 })

console.log('--- photo-dark tones (gaps are tone-true; measure how big) ---')
await run('ink95-c10', 0.95, { tone: 'bw', cell: 10, angleDeg: 0 })
await run('ink90-c10', 0.9, { tone: 'bw', cell: 10, angleDeg: 0 })
await run('ink85-c10', 0.85, { tone: 'bw', cell: 10, angleDeg: 0 })
await run('ink90-c10-ms13', 0.9, { tone: 'bw', cell: 10, angleDeg: 0, dotScale: 1.3 })

console.log('done')
