'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Download,
  RotateCcw,
  Upload,
  Image as ImageIcon,
  ZoomIn,
  ZoomOut,
  Maximize,
} from 'lucide-react'
import {
  DEFAULT_PARAMS,
  PLATE_ANGLES,
  SHAPE_LABELS,
  renderHalftone,
  type HalftoneParams,
  type OutputMode,
  type PlateFilter,
  type ScreenShape,
  type ToneMode,
} from '@/lib/halftone'

const MAX_WORK = 1800 // working resolution cap (long edge)
const MAX_EXPORT = 2600 // export resolution cap

/** tiny shape glyphs */
function ShapeGlyph({ shape }: { shape: ScreenShape }) {
  const c = 'currentColor'
  switch (shape) {
    case 'dot':
      return <circle cx="8" cy="8" r="4.5" fill={c} />
    case 'square':
      return <rect x="3" y="3" width="10" height="10" fill={c} />
    case 'diamond':
      return <rect x="4.7" y="4.7" width="6.6" height="6.6" fill={c} transform="rotate(45 8 8)" />
    case 'ellipse':
      return <ellipse cx="8" cy="8" rx="6.5" ry="3.4" fill={c} />
    case 'line':
      return (
        <g stroke={c} strokeWidth="2.2">
          <line x1="1.5" y1="4" x2="14.5" y2="4" />
          <line x1="1.5" y1="8" x2="14.5" y2="8" />
          <line x1="1.5" y1="12" x2="14.5" y2="12" />
        </g>
      )
    case 'wave':
      return (
        <g stroke={c} strokeWidth="1.8" fill="none">
          <path d="M1 6 Q 4.25 1.5, 7.5 6 T 14 6" />
          <path d="M2 11 Q 5.25 6.5, 8.5 11 T 15 11" />
        </g>
      )
    case 'zigzag':
      return (
        <g stroke={c} strokeWidth="1.8" fill="none">
          <path d="M1.5 5 L5.5 2.5 L9.5 5 L13.5 2.5" />
          <path d="M1.5 12 L5.5 9.5 L9.5 12 L13.5 9.5" />
        </g>
      )
  }
}

const SHAPES: ScreenShape[] = [
  'dot',
  'square',
  'diamond',
  'ellipse',
  'line',
  'wave',
  'zigzag',
]
const PLATES: PlateFilter[] = ['all', 'C', 'M', 'Y', 'K']

const clampZ = (z: number) => Math.min(16, Math.max(0.02, z))
type ViewState = { z: number; x: number; y: number }

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <Card className="border-zinc-800 bg-zinc-900/60">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium tracking-wide text-zinc-400 uppercase">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  )
}

export default function HalftoneStudio() {
  const [params, setParams] = useState<HalftoneParams>(DEFAULT_PARAMS)
  const [fileName, setFileName] = useState('sample.jpg')
  const [renderMs, setRenderMs] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [ready, setReady] = useState(false)

  const srcRef = useRef<HTMLCanvasElement | null>(null)
  const viewRef = useRef<HTMLCanvasElement | null>(null)
  const origRef = useRef<HTMLImageElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const rafRef = useRef(0)

  // --- zoom / pan viewport ---
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState<ViewState>({ z: 1, x: 0, y: 0 })
  const viewStateRef = useRef<ViewState>({ z: 1, x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [fitted, setFitted] = useState(false)
  const fitPendingRef = useRef(true)
  const fitZRef = useRef(1)
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<{
    dist: number
    z: number
    mx: number
    my: number
    px: number
    py: number
  } | null>(null)

  const applyView = useCallback((v: ViewState) => {
    viewStateRef.current = v
    setView(v)
  }, [])

  /** fit canvas inside the stage, centered */
  const fitView = useCallback(() => {
    const stage = stageRef.current
    const cv = viewRef.current
    if (!stage || !cv || !cv.width || !cv.height) return
    const z = Math.min(
      (stage.clientWidth / cv.width) * 0.96,
      (stage.clientHeight / cv.height) * 0.96,
    )
    const zz = clampZ(z)
    fitZRef.current = zz
    setFitted(true)
    applyView({
      z: zz,
      x: (stage.clientWidth - cv.width * zz) / 2,
      y: (stage.clientHeight - cv.height * zz) / 2,
    })
  }, [applyView])

  /** zoom by factor anchored at a client point */
  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const stage = stageRef.current
      if (!stage) return
      const rect = stage.getBoundingClientRect()
      const sx = clientX - rect.left
      const sy = clientY - rect.top
      const { z, x, y } = viewStateRef.current
      const nz = clampZ(z * factor)
      if (nz === z) return
      applyView({ z: nz, x: sx - ((sx - x) * nz) / z, y: sy - ((sy - y) * nz) / z })
    },
    [applyView],
  )

  /** zoom to an absolute scale anchored at stage center */
  const zoomTo = useCallback(
    (target: number) => {
      const stage = stageRef.current
      if (!stage) return
      const sx = stage.clientWidth / 2
      const sy = stage.clientHeight / 2
      const { z, x, y } = viewStateRef.current
      const nz = clampZ(target)
      applyView({ z: nz, x: sx - ((sx - x) * nz) / z, y: sy - ((sy - y) * nz) / z })
    },
    [applyView],
  )

  // non-passive wheel zoom over the stage
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0016))
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // refit on window resize when currently at fit scale
  useEffect(() => {
    const onResize = () => {
      if (Math.abs(viewStateRef.current.z - fitZRef.current) < 1e-6) fitView()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [fitView])

  /** load an image (url or object) into the working canvas */
  const loadSource = useCallback((img: HTMLImageElement, name: string) => {
    const scale = Math.min(1, MAX_WORK / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(2, Math.round(img.naturalWidth * scale))
    const h = Math.max(2, Math.round(img.naturalHeight * scale))
    const c = srcRef.current ?? document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, w, h)
    srcRef.current = c
    origRef.current = img
    fitPendingRef.current = true
    setFileName(name)
    setReady(true)
  }, [])

  // initial sample
  useEffect(() => {
    const img = new Image()
    img.onload = () => loadSource(img, 'sample.jpg — performer over clouds')
    img.src = '/sample.jpg'
  }, [loadSource])

  // render on parameter change (rAF-throttled)
  useEffect(() => {
    if (!ready || !srcRef.current || !viewRef.current) return
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const ms = renderHalftone(
        srcRef.current!,
        viewRef.current!,
        params,
        params.mode === 'cmyk' ? 1400 : undefined,
      )
      setRenderMs(Math.round(ms))
      if (fitPendingRef.current) {
        fitPendingRef.current = false
        fitView()
      }
    })
    return () => cancelAnimationFrame(rafRef.current)
  }, [params, ready, fitView])

  const onFile = useCallback(
    (f: File | undefined) => {
      if (!f) return
      const url = URL.createObjectURL(f)
      const img = new Image()
      img.onload = () => {
        loadSource(img, f.name)
        URL.revokeObjectURL(url)
        setParams((p) => ({ ...p }))
      }
      img.src = url
    },
    [loadSource],
  )

  const exportPng = useCallback(async () => {
    if (!origRef.current) return
    setExporting(true)
    // let the button paint its loading state first
    await new Promise((r) => setTimeout(r, 30))
    try {
      const img = origRef.current
      const scale = Math.min(1, MAX_EXPORT / Math.max(img.naturalWidth, img.naturalHeight))
      const w = Math.round(img.naturalWidth * scale)
      const h = Math.round(img.naturalHeight * scale)
      const big = document.createElement('canvas')
      big.width = w
      big.height = h
      const bctx = big.getContext('2d')!
      bctx.imageSmoothingQuality = 'high'
      bctx.drawImage(img, 0, 0, w, h)
      const out = document.createElement('canvas')
      renderHalftone(big, out, params)
      const blob = await new Promise<Blob | null>((res) => out.toBlob(res, 'image/png'))
      if (blob) {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `halftone-${params.mode}-${params.shape}${
          params.transparent ? '-transparent' : ''
        }.png`
        a.click()
        URL.revokeObjectURL(a.href)
      }
    } finally {
      setExporting(false)
    }
  }, [params])

  // --- stage pointer handling: drag to pan, pinch to zoom ---
  const onStagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[data-no-pan]')) return
    const stage = stageRef.current
    if (!stage) return
    stage.setPointerCapture(e.pointerId)
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    setDragging(true)
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()]
      const { z, x, y } = viewStateRef.current
      pinchRef.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        z,
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
        px: x,
        py: y,
      }
    }
  }

  const onStagePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const pts = pointersRef.current
    const prev = pts.get(e.pointerId)
    if (!prev) return
    const cur = { x: e.clientX, y: e.clientY }
    pts.set(e.pointerId, cur)
    if (pts.size >= 2 && pinchRef.current) {
      const [a, b] = [...pts.values()]
      const pin = pinchRef.current
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      if (pin.dist > 4 && dist > 4) {
        const nz = clampZ(pin.z * (dist / pin.dist))
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        applyView({
          z: nz,
          x: mx - ((pin.mx - pin.px) / pin.z) * nz,
          y: my - ((pin.my - pin.py) / pin.z) * nz,
        })
      }
    } else if (pts.size === 1) {
      const v = viewStateRef.current
      applyView({ ...v, x: v.x + (cur.x - prev.x), y: v.y + (cur.y - prev.y) })
    }
  }

  const onStagePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId)
    if (pointersRef.current.size < 2) pinchRef.current = null
    if (pointersRef.current.size === 0) setDragging(false)
  }

  const onStageDoubleClick = (e: React.MouseEvent) => {
    const { z } = viewStateRef.current
    if (z > 1.05) fitView()
    else zoomAt(e.clientX, e.clientY, 1 / z) // snap to 100% under cursor
  }

  const set = <K extends keyof HalftoneParams>(k: K, v: HalftoneParams[K]) =>
    setParams((p) => ({ ...p, [k]: v }))

  /** enabling art-in-marks must never touch the user's screen parameters */
  const enableKeepArt = (on: boolean) => set('keepArt', on)

  const plateAngles = PLATE_ANGLES(params.angleDeg)
  const isCmyk = params.mode === 'cmyk'

  return (
    <div className="dark min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-950/90 px-4 py-3 lg:px-6">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-semibold tracking-tight">Halftone Studio</h1>
            <p className="hidden text-xs text-zinc-500 sm:block">
              dots · lines · waves · zigzags — CMYK, art-in-marks &amp; transparent PNG
            </p>
          </div>
          <Badge variant="outline" className="border-zinc-700 font-mono text-xs text-zinc-400">
            {renderMs} ms
          </Badge>
        </div>
      </header>

      <main className="mx-auto flex max-w-[1600px] flex-col gap-5 p-4 lg:flex-row lg:p-6">
        {/* preview */}
        <section className="min-w-0 flex-1" aria-label="Preview">
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardContent className="p-4">
              <div
                ref={stageRef}
                onPointerDown={onStagePointerDown}
                onPointerMove={onStagePointerMove}
                onPointerUp={onStagePointerEnd}
                onPointerCancel={onStagePointerEnd}
                onDoubleClick={onStageDoubleClick}
                aria-label="Zoomable halftone preview"
                className="bg-checker relative h-[62vh] min-h-[380px] touch-none overflow-hidden rounded-md border border-zinc-800 lg:h-[calc(100vh-240px)]"
              >
                <canvas
                  ref={viewRef}
                  aria-label="Halftone preview"
                  className="absolute left-0 top-0 origin-top-left shadow-2xl select-none"
                  style={{
                    transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
                    imageRendering: view.z >= 2 ? 'pixelated' : 'auto',
                    cursor: dragging ? 'grabbing' : 'grab',
                    opacity: fitted ? 1 : 0,
                  }}
                />
                {/* zoom controls */}
                <div
                  data-no-pan
                  className="absolute right-3 top-3 flex items-center gap-0.5 rounded-lg border border-zinc-700 bg-zinc-950/85 p-1 shadow-lg backdrop-blur"
                >
                  <button
                    type="button"
                    aria-label="Zoom out"
                    onClick={() => zoomTo(viewStateRef.current.z / 1.5)}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                  >
                    <ZoomOut className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    aria-label="Zoom to 100 percent"
                    onClick={() => zoomTo(1)}
                    className="h-8 min-w-14 rounded-md px-1 text-center font-mono text-xs text-amber-400 hover:bg-zinc-800"
                  >
                    {Math.round(view.z * 100)}%
                  </button>
                  <button
                    type="button"
                    aria-label="Zoom in"
                    onClick={() => zoomTo(viewStateRef.current.z * 1.5)}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                  >
                    <ZoomIn className="h-4 w-4" />
                  </button>
                  <span className="mx-0.5 h-5 w-px bg-zinc-700" aria-hidden="true" />
                  <button
                    type="button"
                    aria-label="Zoom to 100 percent"
                    onClick={() => zoomTo(1)}
                    className="flex h-8 items-center justify-center rounded-md px-2 font-mono text-[11px] text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                  >
                    1:1
                  </button>
                  <button
                    type="button"
                    aria-label="Fit to view"
                    onClick={fitView}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                  >
                    <Maximize className="h-4 w-4" />
                  </button>
                </div>
                <p
                  data-no-pan
                  className="absolute bottom-3 left-3 hidden rounded-md bg-zinc-950/75 px-2 py-1 text-[10px] text-zinc-500 sm:block"
                >
                  scroll to zoom · drag to pan · double-click = 100%
                </p>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="flex items-center gap-2 text-xs text-zinc-500">
                  <ImageIcon className="h-3.5 w-3.5" />
                  <span className="truncate max-w-[220px]">{fileName}</span>
                </p>
                <div className="flex gap-2">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(e) => onFile(e.target.files?.[0])}
                    aria-label="Upload image"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-zinc-700 hover:bg-zinc-800"
                    onClick={() => fileRef.current?.click()}
                  >
                    <Upload className="h-4 w-4" /> Upload
                  </Button>
                  <Button
                    size="sm"
                    className="bg-amber-500 font-medium text-zinc-950 hover:bg-amber-400"
                    onClick={exportPng}
                    disabled={exporting || !ready}
                  >
                    <Download className="h-4 w-4" />
                    {exporting ? 'Exporting…' : 'Download PNG'}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* controls */}
        <aside className="w-full shrink-0 lg:w-[340px]" aria-label="Controls">
          <div className="studio-scroll space-y-4 pb-6 lg:max-h-[calc(100vh-140px)] lg:overflow-y-auto lg:pr-2">
              {/* mode */}
              <Section title="Output mode">
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ['single', 'Single screen'],
                      ['cmyk', 'CMYK separator'],
                    ] as [OutputMode, string][]
                  ).map(([m, label]) => (
                    <Button
                      key={m}
                      size="sm"
                      variant={params.mode === m ? 'default' : 'outline'}
                      className={
                        params.mode === m
                          ? 'bg-amber-500 font-medium text-zinc-950 hover:bg-amber-400'
                          : 'border-zinc-700 hover:bg-zinc-800'
                      }
                      onClick={() => set('mode', m)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
                {isCmyk &&
                  (params.tone === 'bw' ? (
                    <p className="text-xs leading-relaxed text-zinc-500">
                      B&amp;W prints through the black plate only — switch tone to
                      Color or Grayscale for the full CMYK separation.
                    </p>
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-1.5">
                        {PLATES.map((pl) => (
                          <Button
                            key={pl}
                            size="sm"
                            variant={params.plateFilter === pl ? 'default' : 'outline'}
                            className={`h-7 px-2.5 font-mono text-xs ${
                              params.plateFilter === pl
                                ? 'bg-amber-500 text-zinc-950 hover:bg-amber-400'
                                : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'
                            }`}
                            onClick={() => set('plateFilter', pl)}
                          >
                            {pl === 'all' ? 'All plates' : pl}
                          </Button>
                        ))}
                      </div>
                      <div className="grid grid-cols-4 gap-1 text-center font-mono text-[10px] text-zinc-500">
                        {(['C', 'M', 'Y', 'K'] as const).map((pl) => (
                          <div key={pl} className="rounded border border-zinc-800 py-1">
                            {pl} {plateAngles[pl]}°
                          </div>
                        ))}
                      </div>
                      <SliderField
                        label="Black plate strength"
                        value={params.kStrength}
                        min={0}
                        max={1}
                        step={0.05}
                        display={`${Math.round(params.kStrength * 100)}%`}
                        onChange={(v) => set('kStrength', v)}
                      />
                    </>
                  ))}
              </Section>

              {/* screen */}
              <Section title="Screen">
                <div className="grid grid-cols-5 gap-1.5">
                  {SHAPES.map((s) => (
                    <button
                      key={s}
                      title={SHAPE_LABELS[s]}
                      aria-label={SHAPE_LABELS[s]}
                      onClick={() => set('shape', s)}
                      className={`flex h-11 items-center justify-center rounded-md border transition-colors ${
                        params.shape === s
                          ? 'border-amber-500 bg-amber-500/10 text-amber-400'
                          : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'
                      }`}
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16">
                        <ShapeGlyph shape={s} />
                      </svg>
                    </button>
                  ))}
                </div>
                <SliderField
                  label="Orientation"
                  value={params.angleDeg}
                  min={0}
                  max={180}
                  step={1}
                  display={`${params.angleDeg}°`}
                  onChange={(v) => set('angleDeg', v)}
                />
                <SliderField
                  label="Cell size (screen pitch)"
                  value={params.cell}
                  min={3}
                  max={24}
                  step={1}
                  display={`${params.cell} px`}
                  onChange={(v) => set('cell', v)}
                />
                <SliderField
                  label="Mark scale"
                  value={params.dotScale}
                  min={0.2}
                  max={1.2}
                  step={0.02}
                  display={`${Math.round(params.dotScale * 100)}%`}
                  onChange={(v) => set('dotScale', v)}
                />
              </Section>

              {/* mark fill — flat ink vs artwork-in-halftone */}
              {!isCmyk && (
                <Section title="Mark fill">
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      size="sm"
                      variant={!params.keepArt ? 'default' : 'outline'}
                      className={
                        !params.keepArt
                          ? 'bg-amber-500 font-medium text-zinc-950 hover:bg-amber-400'
                          : 'border-zinc-700 hover:bg-zinc-800'
                      }
                      onClick={() => enableKeepArt(false)}
                    >
                      Flat ink
                    </Button>
                    <Button
                      size="sm"
                      variant={params.keepArt ? 'default' : 'outline'}
                      className={
                        params.keepArt
                          ? 'bg-amber-500 font-medium text-zinc-950 hover:bg-amber-400'
                          : 'border-zinc-700 hover:bg-zinc-800'
                      }
                      onClick={() => enableKeepArt(true)}
                    >
                      Art in marks
                    </Button>
                  </div>
                  {params.keepArt ? (
                    <p className="text-xs leading-relaxed text-zinc-500">
                      The original artwork stays visible inside every halftone mark —
                      paper shows between them. Zoom into the preview to see the art
                      pixels inside the shapes. A larger cell size shows more art per
                      mark.
                    </p>
                  ) : (
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-zinc-300">Ink color</Label>
                      <input
                        type="color"
                        value={params.inkColor}
                        onChange={(e) => set('inkColor', e.target.value)}
                        className="h-8 w-12 cursor-pointer rounded border border-zinc-700 bg-zinc-900"
                        aria-label="Ink color"
                      />
                    </div>
                  )}
                </Section>
              )}

              {/* background & transparency */}
              <Section title="Background">
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-zinc-300">Transparent background</Label>
                  <Switch
                    checked={params.transparent}
                    onCheckedChange={(v) => set('transparent', v)}
                    aria-label="Render marks on a transparent background"
                  />
                </div>
                {params.transparent && (
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-zinc-300">
                      Hard edges
                      <span className="block text-[10px] text-zinc-500">
                        no semi-transparent pixels
                      </span>
                    </Label>
                    <Switch
                      checked={params.hardAlpha}
                      onCheckedChange={(v) => set('hardAlpha', v)}
                      aria-label="Threshold alpha so no pixel is semi-transparent"
                    />
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-zinc-300">
                    Remove background color
                    <span className="block text-[10px] text-zinc-500">
                      knockout — no dots where it shows
                    </span>
                  </Label>
                  <Switch
                    checked={params.knockout}
                    onCheckedChange={(v) => set('knockout', v)}
                    aria-label="Remove background color before halftoning"
                  />
                </div>
                {params.knockout && (
                  <>
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-zinc-300">Knockout color</Label>
                      <input
                        type="color"
                        value={params.knockoutColor}
                        onChange={(e) => set('knockoutColor', e.target.value)}
                        className="h-8 w-12 cursor-pointer rounded border border-zinc-700 bg-zinc-900"
                        aria-label="Knockout color"
                      />
                    </div>
                    <SliderField
                      label="Tolerance"
                      value={params.knockoutTolerance}
                      min={0}
                      max={0.35}
                      step={0.01}
                      display={`${Math.round(params.knockoutTolerance * 100)}%`}
                      onChange={(v) => set('knockoutTolerance', v)}
                    />
                  </>
                )}
              </Section>

              {/* adjustments */}
              <Section title="Image adjustments">
                <div className="grid grid-cols-3 gap-1.5">
                  {(
                    [
                      ['color', 'Color'],
                      ['gray', 'Grayscale'],
                      ['bw', 'B&W'],
                    ] as [ToneMode, string][]
                  ).map(([t, label]) => (
                    <Button
                      key={t}
                      size="sm"
                      variant={params.tone === t ? 'default' : 'outline'}
                      className={
                        params.tone === t
                          ? 'bg-amber-500 font-medium text-zinc-950 hover:bg-amber-400'
                          : 'border-zinc-700 hover:bg-zinc-800'
                      }
                      onClick={() => set('tone', t)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
                <p className="text-xs leading-relaxed text-zinc-500">
                  {params.tone === 'bw'
                    ? 'True 1-bit black & white — every pixel is pushed to pure black or pure white at the threshold. No grays survive, even inside the marks.'
                    : params.tone === 'gray'
                      ? 'Continuous grayscale — smooth tones that drive the halftone shades.'
                      : 'Full color — saturation and contrast apply before screening.'}
                </p>
                {params.tone === 'bw' && (
                  <SliderField
                    label="Threshold"
                    value={params.threshold}
                    min={0}
                    max={1}
                    step={0.01}
                    display={`${Math.round(params.threshold * 100)}%`}
                    onChange={(v) => set('threshold', v)}
                  />
                )}
                {params.tone === 'color' && (
                  <SliderField
                    label="Saturation"
                    value={params.saturation}
                    min={-1}
                    max={1}
                    step={0.05}
                    display={`${params.saturation > 0 ? '+' : ''}${Math.round(params.saturation * 100)}`}
                    onChange={(v) => set('saturation', v)}
                  />
                )}
                <SliderField
                  label="Contrast"
                  value={params.contrast}
                  min={-1}
                  max={1}
                  step={0.05}
                  display={`${params.contrast > 0 ? '+' : ''}${Math.round(params.contrast * 100)}`}
                  onChange={(v) => set('contrast', v)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                  onClick={() => setParams(DEFAULT_PARAMS)}
                >
                  <RotateCcw className="h-4 w-4" /> Reset all settings
                </Button>
              </Section>
          </div>
        </aside>
      </main>
    </div>
  )
}

/** labeled slider row */
function SliderField({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-zinc-300">{label}</Label>
        <span className="font-mono text-xs text-amber-400">{display}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(v[0])}
        aria-label={label}
      />
    </div>
  )
}
