/**
 * Halftone Studio — SVG rasterization for preview & PNG export.
 *
 * The SVG document is the single source of truth: the workspace preview,
 * the PNG export and the .svg file itself all come from the SAME geometry
 * (buildHalftoneSVG), so what you see and what you print can never drift.
 *
 * Rasterizing happens in-browser: the SVG string is loaded as an <img>
 * (blob URL) and drawn onto a canvas. Browsers rasterize vector content at
 * the drawn size, so marks stay crisp at any resolution — the PNG is no
 * longer bounded by the raster screener's cell rendering. The root
 * width/height attributes are rewritten to the target size first so every
 * engine (including Safari, which rasterizes SVG at intrinsic size) decodes
 * the vector at exactly the destination resolution.
 *
 * crispFromSvg() restores the Photoshop Bitmap workflow on top of that:
 * it rasterizes a background-free variant at 2× supersample, thresholds the
 * mark-coverage alpha at 50% and rebuilds a true 1-bit image — hard edges
 * for screen-print film positives, with colors sampled from the normal
 * render so art-in-marks survives.
 */

/** Rasterize an SVG string to a canvas of exactly w×h. */
export async function rasterizeSvg(
  svg: string,
  w: number,
  h: number,
): Promise<HTMLCanvasElement> {
  // retarget the root <svg> so the intrinsic size equals the destination:
  // viewBox keeps the coordinate system, vectors re-render at full quality
  const sized = svg.replace(
    /(<svg[^>]*?)\swidth="[^"]*"\sheight="[^"]*"/,
    `$1 width="${w}" height="${h}"`,
  )
  const url = URL.createObjectURL(new Blob([sized], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('SVG rasterization failed'))
      img.src = url
    })
    const cv = document.createElement('canvas')
    cv.width = w
    cv.height = h
    const ctx = cv.getContext('2d')!
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, w, h)
    return cv
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * True 1-bit PNG from the same SVG geometry.
 *
 * `coverageSvg` — the same halftone built with `transparent: true`, so the
 * mark alpha IS the ink coverage (works for every shape, ink color and
 * art-in-masks). Rasterized at 2× and block-averaged down to w×h, then
 * thresholded at 50%.
 *
 * `colorSvg` — the normal render, sampled for mark colors: the flat ink
 * color, or the artwork itself in art-in-marks mode.
 *
 * Single-screen mode only: CMYK rosettes are multiply-blended color, where
 * per-pixel coverage is meaningless — they always export smooth.
 */
export async function rasterizeSvgCrisp(
  coverageSvg: string,
  colorSvg: string,
  w: number,
  h: number,
  inkColor: string,
  keepArt: boolean,
  transparent: boolean,
): Promise<HTMLCanvasElement> {
  const K = 2 // supersample factor
  const cov = await rasterizeSvg(coverageSvg, w * K, h * K)
  const covData = cov.getContext('2d')!.getImageData(0, 0, w * K, h * K).data

  let colData: Uint8ClampedArray | null = null
  if (keepArt) {
    const col = await rasterizeSvg(colorSvg, w, h)
    colData = col.getContext('2d')!.getImageData(0, 0, w, h).data
  }

  // parse the flat ink color once: #rrggbb
  const ink = inkColor.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  const inkRgb = ink
    ? [parseInt(ink[1], 16), parseInt(ink[2], 16), parseInt(ink[3], 16)]
    : [0, 0, 0]

  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d')!
  const od = ctx.createImageData(w, h)
  const d = od.data
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // average the K×K block's mark alpha → sub-pixel coverage
      let acc = 0
      for (let sy = 0; sy < K; sy++) {
        const row = (y * K + sy) * w * K
        for (let sx = 0; sx < K; sx++) {
          acc += covData[(row + x * K + sx) * 4 + 3]
        }
      }
      const on = acc / (K * K) >= 128
      const o = (y * w + x) * 4
      if (on) {
        if (keepArt && colData) {
          d[o] = colData[o]
          d[o + 1] = colData[o + 1]
          d[o + 2] = colData[o + 2]
        } else {
          d[o] = inkRgb[0]
          d[o + 1] = inkRgb[1]
          d[o + 2] = inkRgb[2]
        }
        d[o + 3] = 255
      } else if (keepArt && colData) {
        // art-in-marks: paper pixels come straight from the normal render —
        // white when the export is opaque, transparent when it is not
        d[o] = colData[o]
        d[o + 1] = colData[o + 1]
        d[o + 2] = colData[o + 2]
        d[o + 3] = colData[o + 3]
      } else if (!transparent) {
        // flat ink over opaque paper
        d[o] = 255
        d[o + 1] = 255
        d[o + 2] = 255
        d[o + 3] = 255
      }
      // flat ink + transparent export → no mark stays (0,0,0,0)
    }
  }
  ctx.putImageData(od, 0, 0)
  return out
}
