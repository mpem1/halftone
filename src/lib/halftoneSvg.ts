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
 * thickness profile is sampled from the same blurred ink map. Neighbouring
 * strips whose paper gap drops below lineSeal() are sealed with a small
 * same-color overlap — strips that merely ABUT leave a permanent light seam
 * between them once any renderer anti-aliases the shared edge, which is why
 * solid-black areas used to show a white line between every line. The seal
 * threshold is a fraction of the cell pitch, identical to the raster
 * screener's, so preview and vector agree at any resolution.
 *
 * Spot screens (dot / square / diamond / ellipse) seal their near-solid
 * cells with the SAME rule as the raster (SPOT_SEAL on cell-center ink +
 * scaled tone): a sealed cell is emitted as the shape's OWN plane-closing
 * contour — an oversized circle / rect / rhombus / ellipse overlapping its
 * neighbours — never a foreign full-cell square, so a circles SVG contains
 * circles at every tone and solid regions keep scalloped, not blocky,
 * boundaries.
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
  lineSeal,
  PLATES,
  sampleMap,
  spotThreshold,
  SPOT_SEAL,
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
        const t0 = sampleMap(ink, w, h, ix, iy)
        if (t0 <= 0.004) continue
        const tt = Math.min(1, t0 * ms * ms)
        // near-solid seal — same rule as the raster screener. Emit the
        // shape's OWN plane-closing contour (a few percent oversized so
        // neighbours overlap and anti-aliasing can never leave corner
        // pinholes) instead of a foreign full-cell square
        if (tt >= SPOT_SEAL && t0 >= SPOT_SEAL) {
          switch (shape) {
            case 'dot':
              // circles close the plane at r = cell/√2 (corner distance);
              // +3% keeps the union seamless
              out.push(
                `<circle cx="${n2(rx)}" cy="${n2(ry)}" r="${n2((1.03 / Math.SQRT2) * cell)}"/>`,
              )
              break
            case 'square':
              out.push(
                `<rect x="${n2(rx - cell * 0.51)}" y="${n2(ry - cell * 0.51)}" width="${n2(cell * 1.02)}" height="${n2(cell * 1.02)}"/>`,
              )
              break
            case 'diamond':
              // rhombus closes the plane at half-diagonals = cell
              out.push(
                `<polygon points="${n2(rx - 1.03 * cell)},${n2(ry)} ${n2(rx)},${n2(ry - 1.03 * cell)} ${n2(rx + 1.03 * cell)},${n2(ry)} ${n2(rx)},${n2(ry + 1.03 * cell)}"/>`,
              )
              break
            case 'ellipse':
              // this contour reaches the cell corner at g = √(1.242) ≈ 1.115;
              // 1.15 leaves overlap margin
              out.push(
                `<ellipse cx="${n2(rx)}" cy="${n2(ry)}" rx="${n2(0.775 * 1.15 * cell)}" ry="${n2(0.55 * 1.15 * cell)}"/>`,
              )
              break
          }
          continue
        }
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
  // waves are curved → sample finer; lines/zigzags are straight between
  // corners → cell/3 is plenty
  const step = shape === 'wave' ? cell / 6 : cell / 3
  const span = rxMax * 2 + cell
  const x0 = -rxMax - cell / 2
  const x1 = x0 + span
  // zigzag triangle corners sit exactly at rx = k·cell: snap the sample grid
  // onto them so peaks are NEVER truncated between samples (cell/3 divides
  // cell, so a step-aligned grid always contains every corner)
  const zs = shape === 'zigzag' ? Math.ceil(x0 / step) * step : x0
  const ze = shape === 'zigzag' ? Math.floor(x1 / step) * step : x1
  const count = Math.max(2, Math.ceil((ze - zs) / step))

  // pass 1: half-thickness per row per sample (ink at each row's centerline)
  const cols = count + 1
  const nrows = mMax - mMin + 1
  const hhMap = new Float32Array(nrows * cols)
  for (let m = mMin; m <= mMax; m++) {
    const ry = m * cell
    const base = (m - mMin) * cols
    for (let i = 0; i < cols; i++) {
      const rx = zs + i * step
      const off = lineOffset(shape, rx, cell)
      const yc = ry + off
      const ix = ca * rx + sa * yc + w / 2 - 0.5
      const iy = -sa * rx + ca * yc + h / 2 - 0.5
      const t0 = sampleMap(ink, w, h, ix, iy)
      hhMap[base + i] = Math.min(1, t0 * ms) * half
    }
  }

  // pass 2: build the strips. Wherever the paper gap to a neighbour drops
  // below the seal threshold (near-solid tones), extend BOTH strips toward
  // each other so they OVERLAP by exactly the seal length: strips that only
  // abut leave a light anti-aliasing seam between them at every render
  // resolution — the white line between lines the tool used to show even at
  // solid black. Same-color overlap composites to full coverage instead.
  const SEAL = lineSeal(cell)
  for (let m = mMin; m <= mMax; m++) {
    const ry = m * cell
    const base = (m - mMin) * cols
    const up = m > mMin ? base - cols : -1
    const dn = m < mMax ? base + cols : -1
    const top: string[] = []
    const bot: string[] = []
    let any = false
    for (let i = 0; i < cols; i++) {
      const rx = zs + i * step
      const off = lineOffset(shape, rx, cell)
      const yc = ry + off
      const hh = hhMap[base + i]
      let extT = 0
      let extB = 0
      if (hh > 0) {
        if (up >= 0) {
          const g = cell - hh - hhMap[up + i]
          if (g <= SEAL) extT = g / 2 + SEAL / 2
        }
        if (dn >= 0) {
          const g = cell - hh - hhMap[dn + i]
          if (g <= SEAL) extB = g / 2 + SEAL / 2
        }
      }
      if (hh > 0.02) any = true
      top.push(`${n2(rx)},${n2(yc - hh - extT)}`)
      bot.push(`${n2(rx)},${n2(yc + hh + extB)}`)
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
