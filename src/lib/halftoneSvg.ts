/**
 * Halftone Studio — SVG vector export.
 *
 * The raster screener evaluates a rank-calibrated spot function per pixel;
 * for the conic spot shapes (dot / square / diamond / ellipse) the inked
 * region {spot > s*(tone)} is analytically a scaled circle / square /
 * rhombus / ellipse inside every screen cell. This exporter emits exactly
 * those contours as SVG primitives, reading thresholds from the SAME rank
 * tables (spotThreshold) — so the vector file is geometrically identical
 * to the raster screen: true <circle> elements that never lose their
 * roundness, at any zoom, at any print resolution.
 *
 * Line-like screens (line / wave / zigzag) become polygon strips: the
 * centerline follows the same wave / zigzag formula as the raster and the
 * thickness profile is sampled from the same blurred ink map.
 *
 * CMYK exports as four independently-angled plate groups composited with
 * multiply blending — the same rosette (or uniform) angles as the raster.
 * keepArt embeds the adjusted artwork and masks it through the vector
 * marks, so art-in-marks survives as vectors too.
 */

import {
  adjustImageData,
  blurInk,
  buildKnockoutMask,
  PLATES,
  spotThreshold,
  type HalftoneParams,
  type PlateName,
  type ScreenShape,
} from './halftone'

const isLineLike = (shape: ScreenShape) =>
  shape === 'line' || shape === 'wave' || shape === 'zigzag'

/** compact number: 2 decimals, trailing zeros and "-0" stripped */
function n2(v: number): string {
  let s = v.toFixed(2).replace(/\.?0+$/, '')
  if (s === '-0') s = '0'
  return s
}

/** bilinear sample of a float map at fractional pixel coords (clamped) */
function sample(map: Float32Array, w: number, h: number, x: number, y: number): number {
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

function rgb01ToHex(rgb: readonly [number, number, number] | readonly number[]): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0')
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`
}

/** wave / zigzag centerline offset at screen x — mirrors screenCoverage */
function lineOffset(shape: ScreenShape, rx: number, cell: number): number {
  const amp = cell * 0.28
  if (shape === 'wave') return amp * Math.sin((rx * Math.PI) / cell)
  if (shape === 'zigzag') {
    const period = cell * 2
    let q = rx / period
    q -= Math.floor(q)
    const tri = q < 0.5 ? q * 2 : 2 - q * 2
    return amp * (tri * 2 - 1)
  }
  return 0
}

/**
 * Marks for one plate, in SCREEN coordinates (rotation applied by the
 * caller's group transform). Grid is dot-centered: cell centers sit at
 * multiples of `cell`, exactly like the raster's rotation-about-center.
 */
function plateMarks(
  ink: Float32Array,
  w: number,
  h: number,
  theta: number,
  cell: number,
  p: HalftoneParams,
): string {
  const out: string[] = []
  const ca = Math.cos(theta)
  const sa = Math.sin(theta)
  const shape = p.shape
  const lineLike = isLineLike(shape)
  const half = cell * 0.5
  const ms = p.dotScale
  // rotated image bounds in screen space
  const rxMax = Math.abs(ca) * (w / 2) + Math.abs(sa) * (h / 2)
  const ryMax = Math.abs(sa) * (w / 2) + Math.abs(ca) * (h / 2)

  if (!lineLike) {
    const kMin = Math.ceil(-rxMax / cell)
    const kMax = Math.floor(rxMax / cell)
    const mMin = Math.ceil(-ryMax / cell)
    const mMax = Math.floor(ryMax / cell)
    for (let m = mMin; m <= mMax; m++) {
      const ry = m * cell
      for (let k = kMin; k <= kMax; k++) {
        const rx = k * cell
        // screen -> image coords (inverse rotation), pixel-center convention
        const ix = ca * rx + sa * ry + w / 2 - 0.5
        const iy = -sa * rx + ca * ry + h / 2 - 0.5
        const t0 = sample(ink, w, h, ix, iy)
        if (t0 <= 0.004) continue
        if (t0 >= 0.996) {
          out.push(
            `<rect x="${n2(rx - half)}" y="${n2(ry - half)}" width="${n2(cell)}" height="${n2(cell)}"/>`,
          )
          continue
        }
        const tt = Math.min(1, t0 * ms * ms)
        // rank-calibrated contour: identical geometry to the raster screen
        const s = spotThreshold(shape, tt)
        const g = 1 - s // contour scale factor in cell units
        if (g <= 0.0005) continue
        switch (shape) {
          case 'dot': {
            // contour {dist < g/√2}: a true circle, merged past ~78.5% tone
            const r = (g / Math.SQRT2) * cell
            out.push(`<circle cx="${n2(rx)}" cy="${n2(ry)}" r="${n2(r)}"/>`)
            break
          }
          case 'square': {
            const hs = (g * cell) / 2
            out.push(
              `<rect x="${n2(rx - hs)}" y="${n2(ry - hs)}" width="${n2(g * cell)}" height="${n2(g * cell)}"/>`,
            )
            break
          }
          case 'diamond': {
            const d = g * cell
            out.push(
              `<polygon points="${n2(rx - d)},${n2(ry)} ${n2(rx)},${n2(ry - d)} ${n2(rx + d)},${n2(ry)} ${n2(rx)},${n2(ry + d)}"/>`,
            )
            break
          }
          case 'ellipse': {
            out.push(
              `<ellipse cx="${n2(rx)}" cy="${n2(ry)}" rx="${n2(g * 0.775 * cell)}" ry="${n2(g * 0.55 * cell)}"/>`,
            )
            break
          }
        }
      }
    }
    return out.join('')
  }

  // line-like: one polygon strip per screen row; thickness follows the ink
  const mMin = Math.ceil((-ryMax - half) / cell)
  const mMax = Math.floor((ryMax + half) / cell)
  const step = cell / 3
  const span = rxMax * 2 + cell
  const count = Math.max(2, Math.ceil(span / step))
  for (let m = mMin; m <= mMax; m++) {
    const ry = m * cell
    const top: string[] = []
    const bot: string[] = []
    let any = false
    for (let i = 0; i <= count; i++) {
      const rx = -rxMax - cell / 2 + i * step
      const off = lineOffset(shape, rx, cell)
      const yc = ry + off
      const ix = ca * rx + sa * yc + w / 2 - 0.5
      const iy = -sa * rx + ca * yc + h / 2 - 0.5
      const t0 = sample(ink, w, h, ix, iy)
      const hh = Math.min(1, t0 * ms) * half
      if (hh > 0.02) any = true
      top.push(`${n2(rx)},${n2(yc - hh)}`)
      bot.push(`${n2(rx)},${n2(yc + hh)}`)
    }
    if (!any) continue
    bot.reverse()
    out.push(`<polygon points="${top.join(' ')} ${bot.join(' ')}"/>`)
  }
  return out.join('')
}

export interface SvgPlate {
  ink: Float32Array
  theta: number
  fill: string
}

export interface SvgBuildOpts {
  w: number
  h: number
  cell: number
  params: HalftoneParams
  plates: SvgPlate[]
  /** data URL of the ADJUSTED artwork (keepArt) */
  artHref?: string
}

/** DOM-free SVG document builder — shared by the browser exporter and the Node probe. */
export function buildHalftoneSVG(o: SvgBuildOpts): string {
  const { w, h, cell, params: p } = o
  const cx = w / 2
  const cy = h / 2
  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
  )
  parts.push(
    `<defs><clipPath id="ht-clip"><rect x="0" y="0" width="${w}" height="${h}"/></clipPath></defs>`,
  )

  const single = p.mode === 'single'
  if (single && p.keepArt && o.artHref) {
    // art-in-marks: adjusted artwork masked through the vector marks
    const plate = o.plates[0]
    parts.push('<mask id="ht-marks" maskUnits="userSpaceOnUse" x="0" y="0" width="' + w + '" height="' + h + '">')
    parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="black"/>`)
    parts.push(
      `<g transform="translate(${n2(cx)} ${n2(cy)}) rotate(${n2(-p.angleDeg)})" fill="white">`,
    )
    parts.push(plateMarks(plate.ink, w, h, plate.theta, cell, p))
    parts.push('</g></mask>')
    if (!p.transparent) parts.push(`<rect width="${w}" height="${h}" fill="#ffffff"/>`)
    parts.push(
      `<image href="${o.artHref}" x="0" y="0" width="${w}" height="${h}" mask="url(#ht-marks)" preserveAspectRatio="none"/>`,
    )
  } else {
    if (!p.transparent) parts.push(`<rect width="${w}" height="${h}" fill="#ffffff"/>`)
    parts.push('<g clip-path="url(#ht-clip)" style="isolation:isolate">')
    for (const plate of o.plates) {
      const blend = single ? '' : ' style="mix-blend-mode:multiply"'
      parts.push(
        `<g transform="translate(${n2(cx)} ${n2(cy)}) rotate(${n2(-(plate.theta * 180) / Math.PI)})" fill="${plate.fill}"${blend}>`,
      )
      parts.push(plateMarks(plate.ink, w, h, plate.theta, cell, p))
      parts.push('</g>')
    }
    parts.push('</g>')
  }
  parts.push('</svg>')
  return parts.join('')
}

/**
 * Render the full halftone as an SVG string from a source canvas —
 * the vector twin of renderHalftone(): same adjustments, same knockout,
 * same ink maps + blur, same rank calibration, same plate angles.
 */
export function renderHalftoneSVG(
  src: HTMLCanvasElement,
  p: HalftoneParams,
  cellScale = 1,
): string {
  const w = src.width
  const h = src.height
  const cell = Math.max(2, p.cell * cellScale)
  const ctx = src.getContext('2d')!
  const adjId = ctx.getImageData(0, 0, w, h)
  adjustImageData(adjId, p)
  const mask = p.knockout ? buildKnockoutMask(adjId, p) : null
  const n = w * h
  const theta = (p.angleDeg * Math.PI) / 180

  if (p.mode === 'single') {
    const d = adjId.data
    const ink = new Float32Array(n)
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const lum = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) / 255
      ink[i] = (1 - lum) * (mask ? mask[i] : 1)
    }
    blurInk(ink, w, h, cell)
    let artHref: string | undefined
    if (p.keepArt) {
      const tmp = document.createElement('canvas')
      tmp.width = w
      tmp.height = h
      tmp.getContext('2d')!.putImageData(adjId, 0, 0)
      artHref = tmp.toDataURL('image/png')
    }
    return buildHalftoneSVG({
      w,
      h,
      cell,
      params: p,
      plates: [{ ink, theta, fill: p.inkColor }],
      artHref,
    })
  }

  // CMYK — identical plate construction to renderHalftone
  const d = adjId.data
  const chan: Float32Array[] = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
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
  const plateNames: PlateName[] =
    p.tone === 'bw' ? ['K'] : p.plateFilter === 'all' ? ['C', 'M', 'Y', 'K'] : [p.plateFilter]
  const plates: SvgPlate[] = []
  for (const name of plateNames) {
    const plate = PLATES[name]
    const ink = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      if (plate.channel >= 0) {
        ink[i] = (1 - chan[plate.channel][i]) * (mask ? mask[i] : 1)
      } else {
        ink[i] =
          Math.pow(1 - maxCh[i], 1.25) *
          (p.tone === 'bw' ? 1 : p.kStrength) *
          (mask ? mask[i] : 1)
      }
    }
    blurInk(ink, w, h, cell)
    const th = theta + ((p.uniformPlates ? 0 : plate.offset) * Math.PI) / 180
    plates.push({ ink, theta: th, fill: rgb01ToHex(plate.rgb) })
  }
  return buildHalftoneSVG({ w, h, cell, params: p, plates })
}
