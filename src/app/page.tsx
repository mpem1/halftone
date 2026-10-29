'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Download, RotateCcw, Upload, Image as ImageIcon } from 'lucide-react'
import {
  DEFAULT_PARAMS,
  PLATE_ANGLES,
  SHAPE_LABELS,
  renderHalftone,
  type HalftoneParams,
  type OutputMode,
  type PlateFilter,
  type ScreenShape,
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
  }
}

const SHAPES: ScreenShape[] = ['dot', 'square', 'diamond', 'ellipse', 'line']
const PLATES: PlateFilter[] = ['all', 'C', 'M', 'Y', 'K']

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
    })
    return () => cancelAnimationFrame(rafRef.current)
  }, [params, ready])

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
        a.download = `halftone-${params.mode}-${params.shape}.png`
        a.click()
        URL.revokeObjectURL(a.href)
      }
    } finally {
      setExporting(false)
    }
  }, [params])

  const set = <K extends keyof HalftoneParams>(k: K, v: HalftoneParams[K]) =>
    setParams((p) => ({ ...p, [k]: v }))

  const plateAngles = PLATE_ANGLES(params.angleDeg)
  const isCmyk = params.mode === 'cmyk'

  return (
    <div className="dark min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-950/90 px-4 py-3 lg:px-6">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-semibold tracking-tight">Halftone Studio</h1>
            <p className="hidden text-xs text-zinc-500 sm:block">
              dots · squares · diamonds · ellipses · lines — CMYK separation &amp; art-in-dot mode
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
              <div className="bg-checker flex min-h-[320px] items-center justify-center overflow-hidden rounded-md lg:min-h-[540px]">
                <canvas
                  ref={viewRef}
                  aria-label="Halftone preview"
                  className="max-h-[70vh] max-w-full object-contain shadow-2xl"
                />
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
                {isCmyk && (
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
                )}
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
                  max={90}
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
                {!isCmyk && (
                  <>
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-zinc-300">Art in dots</Label>
                      <Switch
                        checked={params.keepArt}
                        onCheckedChange={(v) => set('keepArt', v)}
                        aria-label="Fill dots with original artwork colors"
                      />
                    </div>
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
                  </>
                )}
              </Section>

              {/* adjustments */}
              <Section title="Image adjustments">
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-zinc-300">Black &amp; white</Label>
                  <Switch
                    checked={params.blackWhite}
                    onCheckedChange={(v) => set('blackWhite', v)}
                    aria-label="Convert to black and white"
                  />
                </div>
                <SliderField
                  label="Saturation"
                  value={params.saturation}
                  min={-1}
                  max={1}
                  step={0.05}
                  display={`${params.saturation > 0 ? '+' : ''}${Math.round(params.saturation * 100)}`}
                  onChange={(v) => set('saturation', v)}
                />
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
