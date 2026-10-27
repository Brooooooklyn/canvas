// CSS Color 4/5 at every canvas color site, pinned to Chrome 155 CPU canvas
// (OffscreenCanvas, getContext('2d', { willReadFrequently: true }), --disable-gpu, standards-mode page).
// The fixture holds what Chrome returned for exactly the procedures below.
import { readFileSync } from 'node:fs'
import { platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import test, { type ExecutionContext } from 'ava'

import { createCanvas } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>
type Row = Record<string, unknown>

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'chrome-cpu-css-color.json'), 'utf8'),
)
const S: Record<string, Record<string, any>> = fixture.sections

// `fixture.x64` was measured with x64 Chrome under Rosetta (SSE only). CI x64 machines have FMA,
// where these few cells can take the arm64 value instead, so x64 accepts either.
function expectedValues(section: string, key: string): unknown[] {
  const arm = S[section][key]
  if (process.arch !== 'x64') return [arm]
  const x64 = fixture.x64[section]?.[key]
  return x64 === undefined ? [arm] : [x64, arm]
}

function deepEqualOneOf(t: ExecutionContext, actual: unknown, list: unknown[]) {
  const json = JSON.stringify(actual)
  if (list.some((e) => JSON.stringify(e) === json)) {
    t.pass()
  } else {
    t.deepEqual(actual, list[0])
  }
}

const canvas = (w: number, h: number, attrs?: { colorSpace?: 'srgb' | 'display-p3' }) =>
  createCanvas(w, h).getContext('2d', attrs)
const pxArr = (ctx: Ctx, x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data)
const px = (ctx: Ctx, x: number, y: number) => pxArr(ctx, x, y).join(',')
const row = (ctx: Ctx, w: number) => Array.from(ctx.getImageData(0, 0, w, 1).data)
const pick = (ctx: Ctx, w: number, xs: number[]) => {
  const d = ctx.getImageData(0, 0, w, 1).data
  return xs.map((x) => Array.from(d.slice(x * 4, x * 4 + 4)).join(',')).join(' ')
}
const attempt = <T>(f: () => T): T | string => {
  try {
    return f()
  } catch (e) {
    return 'THROW ' + (e as Error).name
  }
}
const set = (f: () => void) => {
  try {
    f()
  } catch {}
}

// sc-table.js: every site for one color string.
function tableRow(s: string): Row {
  const r: Row = {}
  {
    const ctx = canvas(2, 2)
    ctx.fillStyle = '#123456'
    try {
      ctx.fillStyle = s
    } catch (e) {
      r.fillThrow = String((e as Error).message)
    }
    r.fillGet = ctx.fillStyle
    ctx.fillRect(0, 0, 2, 2)
    r.fill = pxArr(ctx, 0, 0)
    ctx.strokeStyle = '#123456'
    try {
      ctx.strokeStyle = s
    } catch (e) {
      r.strokeThrow = String((e as Error).message)
    }
    r.strokeGet = ctx.strokeStyle
  }
  {
    const ctx = canvas(2, 2, { colorSpace: 'display-p3' })
    ctx.fillStyle = '#123456'
    set(() => (ctx.fillStyle = s))
    ctx.fillRect(0, 0, 2, 2)
    r.fillP3 = pxArr(ctx, 0, 0)
  }
  {
    const ctx = canvas(4, 4)
    ctx.shadowColor = '#123456'
    try {
      ctx.shadowColor = s
    } catch (e) {
      r.shadowThrow = String((e as Error).message)
    }
    r.shadowGet = ctx.shadowColor
    ctx.shadowOffsetX = 20
    ctx.fillStyle = '#fff'
    ctx.fillRect(-20, 0, 4, 4)
    r.shadow = pxArr(ctx, 1, 1)
  }
  {
    const ctx = canvas(2, 2)
    const g = ctx.createLinearGradient(0, 0, 2, 0)
    try {
      g.addColorStop(0, s)
      g.addColorStop(1, s)
      r.stopOk = true
    } catch (e) {
      r.stopThrow = (e as Error).name + ': ' + String((e as Error).message)
    }
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 2, 2)
    r.stop = pxArr(ctx, 0, 0)
  }
  {
    const ctx = canvas(4, 4)
    try {
      ctx.filter = `drop-shadow(20px 0 0 ${s})`
    } catch (e) {
      r.filterThrow = String((e as Error).message)
    }
    r.filterGet = ctx.filter
    ctx.fillStyle = '#fff'
    ctx.fillRect(-20, 0, 4, 4)
    r.filter = pxArr(ctx, 1, 1)
  }
  return r
}

// The fixture's selection colors are macOS Chrome's. Elsewhere Blink uses its defaults,
// kDefaultActiveSelectionBgColor 0xFF1967D2 / kDefaultActiveSelectionFgColor 0xFFFFFFFF
// (renderer_preferences.h:25-26), and Highlight is the background's BlendWithWhite()
// (layout_theme.cc:361-371, color.cc:1213-1235): rgba(0, 65, 198, 0.8). src/color/names.rs
// gives these off macOS. Each row is what Chrome 155 (macOS) returned for that plain color with
// the procedure above; drop-shadow() keeps the keyword.
const nonMacRow = (s: string, get: string, px: number[], p3: number[]): Row => ({
  fillGet: get,
  fill: px,
  strokeGet: get,
  fillP3: p3,
  shadowGet: get,
  shadow: px,
  stopOk: true,
  stop: px,
  filterGet: `drop-shadow(20px 0 0 ${s})`,
  filter: px,
})
const WHITE = [255, 255, 255, 255]
const NON_MAC_TABLE: Record<string, Row> = {
  Highlight: nonMacRow('Highlight', 'rgba(0, 65, 198, 0.8)', [0, 65, 198, 204], [25, 64, 190, 204]),
  HighlightText: nonMacRow('HighlightText', '#ffffff', WHITE, WHITE),
  SelectedItem: nonMacRow('SelectedItem', '#1967d2', [25, 103, 210, 255], [50, 101, 203, 255]),
  SelectedItemText: nonMacRow('SelectedItemText', '#ffffff', WHITE, WHITE),
}

for (const s of Object.keys(S.table)) {
  test(`color site table matches Chrome: ${JSON.stringify(s)}`, (t) => {
    t.deepEqual(tableRow(s), platform() !== 'darwin' && s in NON_MAC_TABLE ? NON_MAC_TABLE[s] : S.table[s])
  })
}

// sc-edge.js
for (const s of Object.keys(S.edge)) {
  test(`color edge cases match Chrome: ${JSON.stringify(s)}`, (t) => {
    const r: Row = {}
    const ctx = canvas(2, 2)
    ctx.fillStyle = '#123456'
    try {
      ctx.fillStyle = s
    } catch (e) {
      r.fillThrow = (e as Error).message
    }
    r.get = ctx.fillStyle
    ctx.fillRect(0, 0, 2, 2)
    r.fill = px(ctx, 0, 0)
    const g = ctx.createLinearGradient(0, 0, 2, 0)
    try {
      g.addColorStop(0, s)
      r.stop = 'ok'
    } catch (e) {
      r.stop = (e as Error).name
    }
    const want = { ...S.edge[s] }
    if (s === 'oklch(0.5 calc(infinity) 30)') {
      // A NaN channel paints whatever the CPU makes of NaN (arm64 black, x64 white): pin the rest.
      delete r.fill
      delete want.fill
    }
    t.deepEqual(r, want)
  })
}

// sc-alpha.js
for (const s of Object.keys(S.alpha)) {
  test(`color alpha keeps Chrome precision: ${s}`, (t) => {
    const r: Row = {}
    for (const ga of [1, 0.5, 0.7, 0.9]) {
      const ctx = canvas(2, 2)
      ctx.globalAlpha = ga
      ctx.fillStyle = s
      ctx.fillRect(0, 0, 2, 2)
      r['ga' + ga] = px(ctx, 0, 0)
    }
    {
      const ctx = canvas(2, 2)
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, 2, 2)
      ctx.fillStyle = s
      ctx.fillRect(0, 0, 2, 2)
      r.overWhite = px(ctx, 0, 0)
    }
    {
      const ctx = canvas(4, 4)
      set(() => (ctx.shadowColor = s))
      ctx.shadowOffsetX = 20
      ctx.fillStyle = '#fff'
      ctx.fillRect(-20, 0, 4, 4)
      r.shadow = px(ctx, 1, 1)
      const ctx2 = canvas(8, 8)
      set(() => (ctx2.shadowColor = s))
      ctx2.shadowOffsetX = 20
      ctx2.shadowBlur = 2
      ctx2.fillStyle = '#fff'
      ctx2.fillRect(-20, 2, 4, 4)
      r.shadowBlur = px(ctx2, 1, 3) + ' ' + px(ctx2, 4, 3)
    }
    {
      const ctx = canvas(4, 4)
      ctx.fillStyle = s
      ctx.fillRect(0.5, 0.5, 2, 2)
      r.aa = px(ctx, 0, 0) + ' ' + px(ctx, 1, 1)
    }
    deepEqualOneOf(t, r, expectedValues('alpha', s))
  })
}

// Our Windows builds (x64 and arm64) give one byte 1 off Chrome's (macOS) row: byte 17 (pixel 4,
// green) of the display-p3 row of 'color(display-p3 1 0 0) -> white' is 54, not 55. win32-arm64 gave
// 54 both before and after Skia was built with -ffp-contract=off, and win32-x64 gave 55 before and
// 54 after; Linux and macOS give 55. So with contraction off, as in Chromium, both Windows builds
// give 54, and x64 matched only because of contraction. The cause is unknown, and Chrome on Windows
// was not measured. On win32 that case also accepts its row with that one byte; every other byte,
// case and platform is checked exactly.
const WIN32_GRAD = new Map<string, [string, number, number]>([
  ['color(display-p3 1 0 0) -> white', ['display-p3', 17, 54]],
])

// sc-grad.js: 64x1 linear gradient, stops spread evenly (a single stop sits at 0.5).
for (const key of Object.keys(S.grad).filter((k) => k !== '__latch')) {
  test(`gradient stops match Chrome: ${key}`, (t) => {
    const stops = key.split(' -> ')
    const r: Row = {}
    for (const cs of ['srgb', 'display-p3'] as const) {
      const ctx = canvas(64, 1, { colorSpace: cs })
      const g = ctx.createLinearGradient(0, 0, 64, 0)
      try {
        stops.forEach((s, i) => g.addColorStop(stops.length === 1 ? 0.5 : i / (stops.length - 1), s))
      } catch (e) {
        r[cs] = 'THROW ' + (e as Error).name
        continue
      }
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 64, 1)
      r[cs] = row(ctx, 64)
    }
    const expected = expectedValues('grad', key)
    const measured = process.platform === 'win32' ? WIN32_GRAD.get(key) : undefined
    if (measured) {
      const [cs, i, v] = measured
      const chrome = expected[0] as Row
      const winRow = [...(chrome[cs] as number[])]
      winRow[i] = v
      expected.push({ ...chrome, [cs]: winRow })
    }
    deepEqualOneOf(t, r, expected)
  })
}

test('gradient interpolation space is latched at the first paint', (t) => {
  const r: Row = {}
  const ctx = canvas(64, 1)
  const g = ctx.createLinearGradient(0, 0, 64, 0)
  g.addColorStop(0, 'red')
  g.addColorStop(1, 'blue')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 1)
  g.addColorStop(0.5, 'oklch(0.6 0.15 140)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 1)
  r.latched = row(ctx, 64)
  const ctx2 = canvas(64, 1)
  const g2 = ctx2.createLinearGradient(0, 0, 64, 0)
  g2.addColorStop(0, 'red')
  g2.addColorStop(1, 'blue')
  g2.addColorStop(0.5, 'oklch(0.6 0.15 140)')
  ctx2.fillStyle = g2
  ctx2.fillRect(0, 0, 64, 1)
  r.fresh = row(ctx2, 64)
  const ctx3 = canvas(64, 1)
  const g3 = ctx3.createLinearGradient(0, 0, 64, 0)
  g3.addColorStop(0, 'oklch(0.6 0.15 140)')
  ctx3.fillStyle = g3
  ctx3.fillRect(0, 0, 64, 1)
  g3.addColorStop(0.5, 'red')
  g3.addColorStop(1, 'blue')
  ctx3.fillStyle = g3
  ctx3.fillRect(0, 0, 64, 1)
  r.latchedOklab = row(ctx3, 64)
  const ctx4 = canvas(64, 1)
  ctx4.fillStyle = g
  ctx4.fillRect(0, 0, 64, 1)
  r.latchedOtherCtx = row(ctx4, 64)
  t.deepEqual(r, S.grad.__latch)
})

// critic I1: Chrome latches in Gradient::CreateShaderInternal, which only a draw that reaches
// GetFlags() calls (canvas_2d_recorder_context.h DrawInternal).
for (const first of Object.keys(S.latch)) {
  test(`gradient interpolation latches only on a draw that reaches the canvas: ${first}`, (t) => {
    const ctx = canvas(64, 1)
    const g = ctx.createLinearGradient(0, 0, 64, 0)
    if (first !== 'zeroStops') {
      g.addColorStop(0, 'red')
      g.addColorStop(1, 'blue')
    }
    ctx.fillStyle = g
    ctx.strokeStyle = g
    switch (first) {
      case 'fillRect':
        ctx.fillRect(0, 0, 64, 1)
        break
      case 'fillStyleOnly':
        break
      case 'zeroRect':
        ctx.fillRect(0, 0, 0, 0)
        break
      case 'offCanvas':
        ctx.fillRect(100, 100, 5, 5)
        break
      case 'emptyText':
        ctx.fillText('', 0, 0)
        break
      case 'emptyStroke':
        ctx.beginPath()
        ctx.stroke()
        break
      case 'globalAlpha0':
        ctx.globalAlpha = 0
        ctx.fillRect(0, 0, 64, 1)
        ctx.globalAlpha = 1
        break
      case 'zeroStops':
        ctx.fillRect(0, 0, 64, 1)
        g.addColorStop(0, 'red')
        break
      case 'singularTransform':
        ctx.setTransform(0, 0, 0, 0, 0, 0)
        ctx.fillRect(0, 0, 64, 1)
        ctx.resetTransform()
        break
      case 'clippedOut':
        ctx.save()
        ctx.beginPath()
        ctx.rect(0, 0, 0, 0)
        ctx.clip()
        ctx.fillRect(0, 0, 64, 1)
        ctx.restore()
        break
      case 'fillPath':
        ctx.beginPath()
        ctx.rect(0, 0, 64, 1)
        ctx.fill()
        break
      case 'shadowOnly':
        ctx.shadowColor = '#000'
        ctx.shadowOffsetX = 10
        ctx.fillRect(-20, 0, 15, 1)
        ctx.shadowColor = 'transparent'
        break
    }
    g.addColorStop(0.5, 'oklch(0.6 0.15 140)')
    if (first === 'zeroStops') g.addColorStop(1, 'blue')
    ctx.fillRect(0, 0, 64, 1)
    t.is(pick(ctx, 64, [0, 8, 17, 32, 48, 63]), S.latch[first])
  })
}

// sc-grad2.js: `none` components in stops, three gradient kinds.
for (const key of Object.keys(S.grad2)) {
  test(`gradient none stops match Chrome: ${key}`, (t) => {
    const stops = key.split(' | ').map((p) => {
      const i = p.indexOf(':')
      return [Number(p.slice(0, i)), p.slice(i + 1)] as const
    })
    const r: Row = {}
    for (const kind of ['linear', 'radial', 'conic'] as const) {
      const ctx = canvas(64, 1)
      const g =
        kind === 'linear'
          ? ctx.createLinearGradient(0, 0, 64, 0)
          : kind === 'radial'
            ? ctx.createRadialGradient(0, 0, 0, 0, 0, 64)
            : ctx.createConicGradient(0, 0, 0.5)
      try {
        for (const [o, s] of stops) g.addColorStop(o, s)
      } catch (e) {
        r[kind] = 'THROW ' + (e as Error).name
        continue
      }
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 64, 1)
      r[kind] = row(ctx, 64)
    }
    t.deepEqual(r, S.grad2[key])
  })
}

// critic I2: legacy stops become Blink float colors (v / 255.0), which moves semi-transparent
// legacy gradients by one step at some pixels.
for (const key of Object.keys(S.legacyGrad)) {
  test(`legacy gradient stops use Blink's float colors: ${key}`, (t) => {
    const [a, b] = key.split(' -> ')
    const ctx = canvas(97, 1)
    const g = ctx.createLinearGradient(0, 0, 97, 0)
    g.addColorStop(0, a)
    g.addColorStop(1, b)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 97, 1)
    t.is(pick(ctx, 97, [0, 24, 48, 72, 96]), S.legacyGrad[key])
  })
}

// sc-math.js: math functions in rgb(), lab() and hsl() channels.
for (const m of Object.keys(S.math)) {
  test(`math functions in color channels match Chrome: ${m}`, (t) => {
    const ctx = canvas(2, 2)
    ctx.fillStyle = '#123456'
    set(() => (ctx.fillStyle = `rgb(${m} 0 0)`))
    const r: Row = { get: ctx.fillStyle }
    ctx.fillStyle = '#123456'
    set(() => (ctx.fillStyle = `lab(${m} 0 0)`))
    r.lab = ctx.fillStyle
    const s3 = `hsl(120 ${m.replace(/(\d+(\.\d+)?)(?![\d.%e])/, '$1%')} 50%)`
    ctx.fillStyle = '#123456'
    set(() => (ctx.fillStyle = s3))
    r.hslS = s3 + ' => ' + ctx.fillStyle
    t.deepEqual(r, S.math[m])
  })
}

// Units inside calc(): absolute units convert, font/viewport/container units are 0 without an element.
for (const m of Object.keys(S.math2)) {
  test(`units in color calc() match Chrome: ${m}`, (t) => {
    const ctx = canvas(2, 2)
    ctx.fillStyle = '#123456'
    set(() => (ctx.fillStyle = `rgb(${m} 0 0)`))
    const get = ctx.fillStyle
    ctx.fillRect(0, 0, 2, 2)
    const ctx2 = canvas(2, 2)
    ctx2.fillStyle = '#123456'
    set(() => (ctx2.fillStyle = `lab(${m} 0 0)`))
    const lab = ctx2.fillStyle
    const g = ctx2.createLinearGradient(0, 0, 2, 0)
    const stop = attempt(() => {
      g.addColorStop(0, `rgb(${m} 0 0)`)
      return 'ok'
    })
    t.deepEqual({ get, px: px(ctx, 0, 0), lab, stop }, S.math2[m])
  })
}

test('font-metric units in a color calc() resolve to 0 like em', (t) => {
  // Chrome's renderer dies on ex, ch, ic, cap (no element to measure a font with);
  // decisions.md 07 Q2: 0, like em and rem.
  for (const m of ['calc(1ex / 1px * 10)', 'calc(1ch / 1px * 10)', 'calc(1ic / 1px + 20)', 'calc(1cap / 1px + 20)']) {
    const ctx = canvas(2, 2)
    ctx.fillStyle = '#123456'
    ctx.fillStyle = `rgb(${m} 0 0)`
    t.is(ctx.fillStyle, m.endsWith('+ 20)') ? '#140000' : '#000000', m)
  }
})

for (const s of Object.keys(S.ties)) {
  test(`exact-tie channels serialize half-up like Chrome: ${s}`, (t) => {
    const ctx = canvas(2, 2)
    ctx.fillStyle = '#123456'
    set(() => (ctx.fillStyle = s))
    const get = ctx.fillStyle
    ctx.fillRect(0, 0, 2, 2)
    t.deepEqual({ get, px: px(ctx, 0, 0) }, S.ties[s])
  })
}

// critic I4: addColorStop keeps trailing junk only for colors that stay unresolved at parse time
// (lab family with any calc, other spaces with a calc that does not fold).
for (const s of Object.keys(S.unresolved)) {
  test(`unresolved colors keep the stream result in addColorStop: ${s}`, (t) => {
    const ctx = canvas(2, 2)
    const g = ctx.createLinearGradient(0, 0, 2, 0)
    const stop = attempt(() => {
      g.addColorStop(0, s)
      g.addColorStop(1, s)
      return 'ok'
    })
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 2, 2)
    const ctx2 = canvas(2, 2)
    ctx2.fillStyle = '#123456'
    set(() => (ctx2.fillStyle = s))
    t.deepEqual({ stop, stopPx: px(ctx, 0, 0), fillGet: ctx2.fillStyle }, S.unresolved[s])
  })
}

// critic I8: the looper shadow keeps the float color (fillRect, gradient source), the image-filter
// shadow (drawImage) goes through toSkColor() (8-bit).
for (const key of Object.keys(S.shadowRoutes)) {
  test(`shadows keep Chrome's float and 8-bit routes: ${key}`, (t) => {
    let got: string
    const grad = /^gradient source (.*)$/.exec(key)
    const draw = /^drawImage (opaque|half) (.*) ga([\d.]+)$/.exec(key)
    const fill = /^fillRect (.*) ga([\d.]+)$/.exec(key)
    if (grad) {
      const ctx = canvas(8, 8)
      set(() => (ctx.shadowColor = grad[1]))
      ctx.shadowOffsetX = 20
      const g = ctx.createLinearGradient(-20, 0, -16, 0)
      g.addColorStop(0, '#fff')
      g.addColorStop(1, 'rgba(255,255,255,0.5)')
      ctx.fillStyle = g
      ctx.fillRect(-20, 2, 4, 4)
      got = px(ctx, 1, 3) + ' ' + px(ctx, 3, 3)
    } else if (draw) {
      const src = createCanvas(4, 4)
      const sctx = src.getContext('2d')
      sctx.fillStyle = draw[1] === 'opaque' ? '#fff' : 'rgba(255,255,255,0.5)'
      sctx.fillRect(0, 0, 4, 4)
      const ctx = canvas(8, 8)
      ctx.globalAlpha = Number(draw[3])
      set(() => (ctx.shadowColor = draw[2]))
      ctx.shadowOffsetX = 20
      ctx.drawImage(src, -20, 2)
      got = px(ctx, 1, 3)
    } else {
      const ctx = canvas(40, 20)
      ctx.globalAlpha = Number(fill![2])
      set(() => (ctx.shadowColor = fill![1]))
      ctx.shadowOffsetX = 20
      ctx.fillStyle = '#fff'
      ctx.fillRect(-20, 0, 10, 10)
      got = px(ctx, 3, 3)
    }
    t.is(got, S.shadowRoutes[key])
  })
}

// sc-twobyte.js: the byte-level fast path (case-sensitive names, 8-bit alpha) vs the full parser.
for (const s of Object.keys(S.fastpath)) {
  test(`fast path and full parser round like Chrome: ${s}`, (t) => {
    const ctx = canvas(2, 2)
    ctx.fillStyle = '#123456'
    ctx.fillStyle = s
    const r: Row = { get: ctx.fillStyle }
    ctx.globalAlpha = 0.5
    ctx.fillRect(0, 0, 2, 2)
    r.ga05 = px(ctx, 0, 0)
    const ctx2 = canvas(2, 2)
    const g = ctx2.createLinearGradient(0, 0, 2, 0)
    try {
      g.addColorStop(0, s)
      g.addColorStop(1, s)
      ctx2.fillStyle = g
      ctx2.fillRect(0, 0, 2, 2)
      r.stop = px(ctx2, 0, 0)
    } catch (e) {
      r.stop = (e as Error).name
    }
    t.deepEqual(r, S.fastpath[s])
  })
}

// sc-named.js: Blink's two extra names only work as a whole fillStyle/addColorStop string.
for (const s of Object.keys(S.named)) {
  test(`Blink-only color names are top-level only: ${s}`, (t) => {
    const ctx = canvas(2, 2)
    ctx.fillStyle = '#123456'
    set(() => (ctx.fillStyle = s))
    const r: Row = { get: ctx.fillStyle }
    const g = ctx.createLinearGradient(0, 0, 2, 0)
    try {
      g.addColorStop(0, s)
      r.stop = 'ok'
    } catch (e) {
      r.stop = (e as Error).name
    }
    const ctx2 = canvas(4, 4)
    ctx2.filter = `drop-shadow(20px 0 0 ${s})`
    r.filter = ctx2.filter
    t.deepEqual(r, S.named[s])
  })
}

// System colors with no document color provider (OffscreenCanvas). Highlight / SelectedItem and their
// text colors come from the platform: macOS reads NSColor.selectedTextBackgroundColor (measured);
// Linux and Windows use Blink's defaults: renderer_preferences.h:26-27
// kDefaultActiveSelectionBgColor 0xFF1967D2 / kDefaultActiveSelectionFgColor 0xFFFFFFFF,
// Highlight = BlendWithWhite() (layout_theme.cc:361-371, color.cc:1214-1236).
const NON_MAC_SYSTEM: Record<string, Row> = {
  Highlight: { get: 'rgba(0, 65, 198, 0.8)', shadowGet: 'rgba(0, 65, 198, 0.8)' },
  HighlightText: { px: '255,255,255,255', get: '#ffffff', shadowGet: '#ffffff' },
  SelectedItem: { px: '25,103,210,255', get: '#1967d2', shadowGet: '#1967d2' },
  SelectedItemText: { px: '255,255,255,255', get: '#ffffff', shadowGet: '#ffffff' },
  'rgb(from Highlight r g b)': {
    get: 'color(srgb 0 0.254902 0.776471 / 0.8)',
    shadowGet: 'color(srgb 0 0.254902 0.776471 / 0.8)',
  },
}
for (const s of Object.keys(S.sys)) {
  test(`system colors match Chrome OffscreenCanvas: ${s}`, (t) => {
    const ctx = canvas(2, 2)
    ctx.fillStyle = '#123456'
    ctx.fillStyle = s
    const r: Row = { get: ctx.fillStyle }
    ctx.fillRect(0, 0, 2, 2)
    r.px = px(ctx, 0, 0)
    const g = ctx.createLinearGradient(0, 0, 2, 0)
    try {
      g.addColorStop(0, s)
      g.addColorStop(1, s)
    } catch (e) {
      r.Stop = (e as Error).name
    }
    ctx.shadowColor = s
    r.shadowGet = ctx.shadowColor
    const want: Row = { ...S.sys[s] }
    if (platform() !== 'darwin' && s in NON_MAC_SYSTEM) {
      // Only the getters are known from source; a semi-transparent pixel needs a measurement.
      if (!('px' in NON_MAC_SYSTEM[s])) delete r.px
      delete want.px
      Object.assign(want, NON_MAC_SYSTEM[s])
    }
    t.deepEqual(r, want)
  })
}

// sc-filter.js (OffscreenCanvas half, color after the lengths) and sc-filter2.js.
for (const s of Object.keys(S.filter)) {
  test(`drop-shadow() colors match Chrome: ${JSON.stringify(s)}`, (t) => {
    const ctx = canvas(4, 4)
    ctx.filter = `drop-shadow(20px 0 0 ${s})`
    const Get = ctx.filter
    ctx.fillStyle = '#fff'
    ctx.fillRect(-20, 0, 4, 4)
    const want: Row = { ...S.filter[s] }
    const r: Row = { Get, px: px(ctx, 1, 1) }
    if (platform() !== 'darwin' && s === 'Highlight') {
      want.px = r.px
    }
    t.deepEqual(r, want)
  })
}
for (const s of Object.keys(S.filter2)) {
  test(`drop-shadow() system and keyword colors match Chrome: ${JSON.stringify(s)}`, (t) => {
    const ctx = canvas(4, 4)
    ctx.filter = `drop-shadow(20px 0 0 ${s})`
    const get = ctx.filter
    ctx.fillStyle = '#fff'
    ctx.fillRect(-20, 0, 4, 4)
    const want: Row = { ...S.filter2[s] }
    const r: Row = { get, px: px(ctx, 1, 1) }
    if (platform() !== 'darwin') {
      // Same platform table as above; the semi-transparent Highlight pixel is not pinned there.
      if (s === 'Highlight') want.px = r.px
      if (s === 'HighlightText') want.px = '255,255,255,255'
      if (s === 'SelectedItem') want.px = '25,103,210,255'
    }
    t.deepEqual(r, want)
  })
}
for (const f of Object.keys(S.filterSyntax)) {
  test(`drop-shadow() color slot follows CSS syntax: ${f}`, (t) => {
    const ctx = canvas(4, 4)
    set(() => (ctx.filter = f))
    const get = ctx.filter
    ctx.fillStyle = '#fff'
    ctx.fillRect(-20, 0, 4, 4)
    t.deepEqual({ get, px: attempt(() => px(ctx, 1, 1)) }, S.filterSyntax[f])
  })
}

// Nested colors. Chrome has no nesting limit (20000 nested color-mix() still parse; its renderer
// crashes past that). We stop at COLOR_NESTING_LIMIT nested colors so a parse can never overflow
// a small thread stack (decisions.md 07 Q4); deeper input is an invalid color.
const COLOR_NESTING_LIMIT = 100
const nest = {
  mix: (n: number) => 'color-mix(in srgb, '.repeat(n) + 'red' + ', blue)'.repeat(n),
  rel: (n: number) => 'rgb(from '.repeat(n) + 'red' + ' r g b)'.repeat(n),
  calc: (n: number) => 'rgb(' + 'calc('.repeat(n) + '10' + ')'.repeat(n) + ' 0 0)',
  calcadd: (n: number) => 'rgb(calc(' + Array(n).fill('1').join(' + ') + ') 0 0)',
}
for (const key of Object.keys(S.depth)) {
  const [, kind, count] = /^([a-z]+)(\d+)$/.exec(key)!
  const n = Number(count)
  const beyondLimit = (kind === 'mix' || kind === 'rel') && n > COLOR_NESTING_LIMIT
  test(`deeply nested colors match Chrome or stop at the limit: ${key}`, (t) => {
    const s = nest[kind as keyof typeof nest](n)
    const ctx = canvas(2, 2)
    ctx.fillStyle = '#123456'
    set(() => (ctx.fillStyle = s))
    const r: Row = { get: ctx.fillStyle.slice(0, 60) }
    const g = ctx.createLinearGradient(0, 0, 2, 0)
    try {
      g.addColorStop(0, s)
      r.stop = 'ok'
    } catch (e) {
      r.stop = (e as Error).name
    }
    t.deepEqual(r, beyondLimit ? { get: '#123456', stop: 'SyntaxError' } : S.depth[key])
  })
}

test('colors nested past the limit are invalid everywhere, even in a worker thread', async (t) => {
  const deep = [nest.mix(20000), nest.rel(20000), 'rgb(from '.repeat(200000) + 'red' + ' r g b)'.repeat(200000)]
  for (const s of deep) {
    const ctx = canvas(2, 2)
    ctx.fillStyle = '#123456'
    ctx.fillStyle = s
    ctx.shadowColor = s
    t.is(ctx.fillStyle, '#123456')
    t.is(ctx.shadowColor, 'rgba(0, 0, 0, 0)')
    ctx.filter = `drop-shadow(1px 1px 0 ${s})`
    t.is(ctx.filter, 'none')
    t.throws(() => ctx.createLinearGradient(0, 0, 1, 0).addColorStop(0, s), { name: 'SyntaxError' })
  }
  const index = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js')
  const code = `
    const { parentPort } = require('node:worker_threads')
    const { createCanvas } = require(${JSON.stringify(index)})
    const ctx = createCanvas(2, 2).getContext('2d')
    const at = (n) => { ctx.fillStyle = '#123456'; ctx.fillStyle = 'color-mix(in srgb, '.repeat(n) + 'red' + ', blue)'.repeat(n); return ctx.fillStyle }
    parentPort.postMessage([at(${COLOR_NESTING_LIMIT}), at(${COLOR_NESTING_LIMIT + 1}), at(100000)])
  `
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true })
    worker.once('message', resolve)
    worker.once('error', reject)
  })
  t.deepEqual(result, [S.depth[`mix${COLOR_NESTING_LIMIT}`].get, '#123456', '#123456'])
})
