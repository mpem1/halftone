# Halftone Studio

**▶ Open the app: [https://mpem1.github.io/halftone/](https://mpem1.github.io/halftone/)**

A browser-based halftone screen-room: turn any image into print-ready halftones with a Photoshop-style workflow — continuous tone in, screened marks out.

Built with Next.js + SVG. No upload, no server processing: every pixel is screened locally in your browser. Nothing to install — the link above is the whole app.

**One engine, three outputs.** The workspace preview, the PNG download and the SVG file are all rendered from the *same* vector geometry — what you see is mathematically what you print, at any resolution.

## Features

### Screening engine
- **Shapes** — dots, squares, diamonds, ellipses, lines, waves, zigzags
- **Angle control** — 0–180° screen angle per the classic print convention
- **Photoshop-workflow ruling** — set **Output resolution (PPI)** × **Frequency (LPI)** like Photoshop's Bitmap → Halftone Screen dialog; cell size is derived from `PPI / LPI` instead of raw pixels, so what you set is what prints
- **Euclidean round screen** — the dot spot is the true circle screen (Photoshop's "Round"): dots stay *perfect circles* up to ~78.5% tone, where neighbors physically touch, then invert into round paper holes. Rank calibration keeps dot area exactly equal to tone
- **Zebra flow screens** — ZebraTrace-style engraving: continuous parallel curves whose width follows the image tone, in five curve families — **waves, lines, rings, spiral, rays** — with a flow (meander) control and width limit; preview, PNG and SVG share the same curve math
- **Continuous-tone screening** — the source is never binarized before screening (the #1 cause of ugly halftones). Gray levels go into the screen; a 1-bit dot pattern comes out. B&W mode is a true Bitmap-mode equivalent
- **Rank-calibrated spot functions** — mark area is proportional to tone for every shape (method calibrated against storytold/photocraft's cosine screens)
- **CMYK separation** — four plates at print angles (C 15° / M 75° / Y 0° / K 45°) with an optional **uniform angle** mode for screen printing
- **Smooth vector marks everywhere** — marks are true vector contours, so preview, PNG and SVG all show smooth, printer-grade edges; screen printers get hard 1-bit edges from the PNG option below
- **Invert colors** — a true color negative applied at the start of the adjustment chain (Photoshop's Adjustments → Invert): the artwork's colors flip visibly (art-in-marks and CMYK show the negative), and flipping colors also flips which areas print — light artwork prints, dark artwork becomes paper, the workflow for dark garments. The knockout color keeps matching the colors visible in the original artwork either way
- **Garment-color knockout, remove or keep** — "Knockout" takes any shirt/background color: **Remove color** drops no dots where it shows; **Keep only color** prints just that range and knocks out everything else. **Connected to edges only** flood-fills inward from the image border, so the actual background goes while shapes of the same color *inside* the design (white letters on a white background) keep their ink — turn it off to wipe every matching pixel instead
- **Art in marks** — fill the marks with the source artwork itself instead of flat ink
- **Drag & drop** — drop an image anywhere on the page (jpg/png/webp) instead of hunting through folders; the Upload button still works

### Adjustments
Exposure, contrast, level pivot, blur/sharpen, and more — applied to the continuous-tone image *before* screening, matching Photoshop's Grayscale → Levels → Bitmap order.
- **Split-tone levels** — lift or crush shadows and highlights independently, so you can recover detail in faces or skies without shifting the whole image; channels are renormalized together when they would clip, so heavy lifts never repaint shadows blue/green or highlights yellow
- **Targeted exposure (dodge & burn)** — brush a region on the image and lighten or darken just that area before screening
- **Invert** — flips the artwork's colors to their negative first, so a black design with white/blue details screens correctly onto a black shirt (invert on) or a white shirt (invert off, knock out the black background)

### Export — one geometry, three outputs

The workspace preview *is* the SVG: it is built by the same vector engine and rasterized by the browser at working resolution. Every export button writes that exact geometry.

- **SVG vector export** — the master output: dots leave as true `<circle>` elements (squares/diamonds/ellipses as `<rect>`/`<polygon>`/`<ellipse>`, lines/waves/zebra as polygon strips) read from the same rank tables as the screen, so the file is geometrically identical to the preview at any scale. CMYK exports as four multiply-blended plate groups; art-in-marks embeds the adjusted artwork masked through the vector marks
- **PNG export** — a rasterization of that same SVG at the export resolution (`cellScale = previewW / exportW` keeps the LPI identical), so the PNG matches the preview and the printed SVG pixel-for-pixel in structure
- **Crisp 1-bit PNG (film mode)** — optionally the marks are supersampled 2× and thresholded to pure black-and-white (zero gray pixels, verified by probe) for screen-print film positives; CMYK rosettes keep smooth blended edges
- **WYSIWYG ruling** — a 96-PPI preview and a 300-PPI export produce identical dot structure, like Photoshop's Bitmap → Halftone Screen

---

## For developers (optional — not needed to use the app)

Everything above works straight from the live link. Clone and run locally only if you want to modify the engine:

```bash
bun install
bun run dev
```

Open http://localhost:3000, drop in an image (or use the bundled `public/sample.jpg`), and play.

### QA probe

A Bun-side probe screens the sample image through the same engine and reports raster-vs-SVG parity, midtone coverage + 1-bit purity, with zoomed crops for eyeballing dot structure:

```bash
bun scripts/halftone_probe.ts
# writes scripts/probe-out/*.png + a stats table (gitignored)
```

## Reference

Engine decisions were calibrated against the open-source recreations of Adobe's halftone pipeline at [storytold/photocraft](https://github.com/storytold/photocraft) and [storytold/artcraft](https://github.com/storytold/artcraft), plus Adobe's own Bitmap → Halftone Screen workflow (Frequency/Angle/Shape at a chosen output DPI). The zebra flow screens take their cue from [maxim-s-barabash/ZebraTrace](https://github.com/maxim-s-barabash/ZebraTrace).
