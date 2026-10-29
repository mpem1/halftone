# Halftone Studio

A browser-based halftone screen-room: turn any image into print-ready halftones with a Photoshop-style workflow — continuous tone in, 1-bit dots out.

Built with Next.js + Canvas 2D. No upload, no server processing: every pixel is screened locally in your browser.

## Features

### Screening engine
- **Shapes** — dots, squares, diamonds, ellipses, lines, waves, zigzags
- **Angle control** — 0–180° screen angle per the classic print convention
- **Photoshop-workflow ruling** — set **Output resolution (PPI)** × **Frequency (LPI)** like Photoshop's Bitmap → Halftone Screen dialog; cell size is derived from `PPI / LPI` instead of raw pixels, so what you set is what prints
- **Euclidean round screen** — the dot spot is the true circle screen (Photoshop's "Round"): dots stay *perfect circles* up to ~78.5% tone, where neighbors physically touch, then invert into round paper holes. Rank calibration keeps dot area exactly equal to tone
- **Continuous-tone screening** — the source is never binarized before screening (the #1 cause of ugly halftones). Gray levels go into the screen; a 1-bit dot pattern comes out. B&W mode is a true Bitmap-mode equivalent
- **Rank-calibrated spot functions** — mark area is proportional to tone for every shape (method calibrated against storytold/photocraft's cosine screens)
- **CMYK separation** — four plates at print angles (C 15° / M 75° / Y 0° / K 45°) with an optional **uniform angle** mode for screen printing
- **Crisp / anti-aliased output** — crisp mode renders hard-edged 1-bit dots (0 gray pixels, verified by probe); AA mode supersamples small cells so tiny dots keep their circular silhouette
- **Art in marks** — fill the marks with the source artwork itself instead of flat ink

### Adjustments
Exposure, contrast, level pivot, blur/sharpen, and more — applied to the continuous-tone image *before* screening, matching Photoshop's Grayscale → Levels → Bitmap order.

### Export
- **SVG vector export** — dots leave as true `<circle>` elements (squares/diamonds/ellipses as `<rect>`/`<polygon>`/`<ellipse>`, lines/waves as polygon strips) read from the same rank tables as the raster screen, so the vector file is geometrically identical to the preview at any scale. CMYK exports as four multiply-blended plate groups; art-in-marks embeds the adjusted artwork masked through the vector marks
- **WYSIWYG PNG export** — the same LPI ruling is preserved at export resolution (`cellScale = previewW / exportW`), so a 96-PPI preview and a 300-PPI export produce identical dot structure
- 1-bit output verification: exports contain zero intermediate gray pixels in crisp mode

## Getting started

```bash
bun install
bun run dev
```

Open http://localhost:3000, drop in an image (or use the bundled `public/sample.jpg`), and play.

## QA probe

A Node-side probe screens the sample image through the same engine and reports midtone coverage + 1-bit purity, with zoomed crops for eyeballing dot structure:

```bash
npx tsx scripts/halftone_probe.ts
# writes scripts/probe-out/*.png + a stats table
```

## Reference

Engine decisions were calibrated against the open-source recreations of Adobe's halftone pipeline at [storytold/photocraft](https://github.com/storytold/photocraft) and [storytold/artcraft](https://github.com/storytold/artcraft), plus Adobe's own Bitmap → Halftone Screen workflow (Frequency/Angle/Shape at a chosen output DPI).
