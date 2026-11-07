// Chrome 157 rows for the Blink-style shaper (DESIGN-SHAPER.md, stage S0).
// The fixture holds every row the shaper stages must reach. A row the old
// (skparagraph) path does not match yet carries `flip` (system renderer,
// all fields on macOS) or `flipPortable` (portable renderer, width): the
// stage that is expected to fix it. Such a row is checked only from that
// stage on; before it, the spec checks that it still differs (like
// test.failing), so a row that moves is seen.
//
// S0a runs on the old path. From S1 to S8 the new path is behind
// NAPI_RS_CANVAS_SHAPER=blink, so a flipped row is checked only with the
// switch on, until S9 makes it the default.
import './use-system-text-renderer'

import { readFileSync } from 'node:fs'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts, setTextRenderer } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

type Props = Partial<Record<string, string>>
type Value = number[] | boolean | 'blank' | { ink: boolean; color: boolean }
interface Draw {
  text: string
  direction: string
  textAlign?: string
}
interface Row {
  group: string
  kind?: 'same' | 'color'
  font: string
  text?: string
  ctx?: Props
  css?: Props
  canvas?: [number, number]
  at?: [number, number]
  draws?: Draw[]
  // Needs macOS system fonts: pinned on the capture's Darwin major only.
  system?: true
  lowEnd?: true
  // false: the portable renderer's own glyph metrics differ from the macOS
  // Chrome capture (not a shaping difference; also when a row with `flip`
  // already differs between the two renderers on the old path); not checked.
  portable?: false
  chrome: Value
  flip?: string
  flipPortable?: string
}
const FIXTURE: { darwin: string; fonts: Record<string, string>; cases: Record<string, Row> } = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'text-fonts', 'blink-shaper.json'), 'utf8'),
)

// A probe font that does not register would leave its rows drawn with a
// fallback font, and rows still to flip would hide that.
const UNREGISTERED = Object.entries(FIXTURE.fonts).flatMap(([family, file]) =>
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', file), family) ? [] : [`${family}: ${file}`],
)

// The last shaper stage on this branch.
const LANDED = 'S0'
const STAGES = ['S0', 'S0a', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10']
const BLINK = process.env.NAPI_RS_CANVAS_SHAPER === 'blink'

// Whether a row with this flip stage must match Chrome now.
function landed(flip: string | undefined) {
  if (!flip) {
    return true
  }
  const at = STAGES.indexOf(flip)
  const now = STAGES.indexOf(LANDED)
  if (at < 0) {
    throw new Error(`unknown stage ${flip}`)
  }
  if (at > now) {
    return false
  }
  return flip === 'S0a' || BLINK || now >= STAGES.indexOf('S9')
}

const DARWIN = process.platform === 'darwin'
const CAPTURE_DARWIN = DARWIN && release().split('.')[0] === FIXTURE.darwin

function context(row: Row, width = 10, height = 10) {
  const ctx = createCanvas(width, height).getContext('2d')
  Object.assign(ctx, row.css)
  ctx.font = row.font
  Object.assign(ctx, row.ctx)
  return ctx
}

function draw(row: Row, d: Draw) {
  const [w, h] = row.canvas!
  const ctx = context(row, w, h)
  ctx.direction = d.direction as CanvasDirection
  if (d.textAlign) {
    ctx.textAlign = d.textAlign as CanvasTextAlign
  }
  ctx.fillStyle = '#000'
  ctx.fillText(d.text, row.at![0], row.at![1])
  return ctx.getImageData(0, 0, w, h).data
}

// Same computation as the capture script (stages/S0/run-case.js).
function ours(row: Row): Value {
  if (!row.kind) {
    const m = context(row).measureText(row.text!)
    return [
      m.width,
      m.actualBoundingBoxLeft,
      m.actualBoundingBoxRight,
      m.actualBoundingBoxAscent,
      m.actualBoundingBoxDescent,
    ]
  }
  if (row.kind === 'same') {
    const a = draw(row, row.draws![0])
    const b = draw(row, row.draws![1])
    // A blank draw is no text drawing at all: every 'same' row in the capture
    // has ink in both draws, so check() fails a blank one at every stage.
    const blank = (data: Uint8ClampedArray) => data.every((v, i) => i % 4 !== 3 || v === 0)
    if (blank(a) || blank(b)) {
      return 'blank'
    }
    return a.every((v, i) => v === b[i])
  }
  const d = draw(row, { text: row.text!, direction: 'inherit' })
  let ink = false
  let color = false
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) {
      continue
    }
    ink = true
    if (d[i + 3] >= 64 && Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 8) {
      color = true
    }
  }
  return { ink, color }
}

const FIELDS = ['width', 'inkLeft', 'inkRight', 'inkAscent', 'inkDescent']

// Differences between our value and Chrome's; empty when they match.
function differences(row: Row, value: Value, widthOnly: boolean) {
  if (Array.isArray(value)) {
    const chrome = row.chrome as number[]
    return (widthOnly ? [0] : [0, 1, 2, 3, 4]).flatMap((i) => {
      // Long lines add up float error (about 1e-6 of the width).
      const tolerance = i === 0 ? Math.max(1e-3, 1e-6 * Math.abs(chrome[i])) : 1e-3
      return Math.abs(value[i] - chrome[i]) <= tolerance ? [] : [`${FIELDS[i]} ${value[i]} (Chrome ${chrome[i]})`]
    })
  }
  return JSON.stringify(value) === JSON.stringify(row.chrome)
    ? []
    : [`${JSON.stringify(value)} (Chrome ${JSON.stringify(row.chrome)})`]
}

// Missing text or broken metrics, not a shaping difference: fails before and
// after the row's flip stage. Every Chrome row has ink and finite metrics.
function invalidOutput(row: Row, value: Value): string | false {
  if (value === 'blank') {
    return 'blank drawing'
  }
  if (Array.isArray(value)) {
    const chrome = row.chrome as number[]
    if (value.some((v) => !Number.isFinite(v))) {
      return `non-finite metrics ${JSON.stringify(value)}`
    }
    // A layout that failed gives all zeros. Rows whose Chrome metrics are all
    // zero (no glyph at all) are kept.
    if (value.every((v) => v === 0) && chrome.some((v) => v !== 0)) {
      return 'all-zero metrics'
    }
    // Ink bounds are fields 1-4. Whitespace-only rows have no ink in Chrome
    // either, so only a row with Chrome ink needs ours.
    const ink = (m: number[]) => m.slice(1).some((v) => v !== 0)
    if (ink(chrome) && !ink(value)) {
      return `no ink bounds ${JSON.stringify(value)}`
    }
    return false
  }
  if (typeof value === 'object' && !value.ink) {
    return 'no ink'
  }
  return false
}

interface Check {
  renderer: 'system' | 'portable'
  rows: [string, Row][]
  flip: (row: Row) => string | undefined
  widthOnly: boolean
}

function check({ renderer, rows, flip, widthOnly }: Check) {
  const mismatches: string[] = []
  const early: string[] = []
  let pinned = 0
  setTextRenderer(renderer)
  try {
    for (const [name, row] of rows) {
      const value = ours(row)
      const invalid = invalidOutput(row, value)
      if (invalid) {
        mismatches.push(`${name}: ${invalid}`)
        continue
      }
      const diff = differences(row, value, widthOnly)
      if (landed(flip(row))) {
        pinned++
        if (diff.length) {
          mismatches.push(`${name}: ${diff.join(', ')}`)
        }
      } else if (!diff.length && (DARWIN || renderer === 'portable')) {
        // The system renderer is checked on the capture OS only: another OS
        // may differ for its own reasons. The portable renderer draws the
        // registered fonts the same on every OS, so it is checked everywhere.
        early.push(`${name} (flip ${flip(row)}) already matches Chrome`)
      }
    }
  } finally {
    setTextRenderer('system')
  }
  return { mismatches, early, pinned }
}

const ROWS = Object.entries(FIXTURE.cases)

test.serial('the fixture covers every group of the shaper stages', (t) => {
  t.deepEqual(UNREGISTERED, [], 'every probe font registers')
  const groups = new Set(ROWS.map(([, row]) => row.group))
  for (const group of [
    'q1',
    'q6',
    'q6-han',
    'q11',
    'q11-order',
    'q5',
    'q7',
    'cjk-punct',
    'q9',
    'trak',
    'spacing',
    'liga-spacing',
    'arabic',
    'kerning',
    'nosuch-fsa',
    'size-floor',
    'long',
    'script',
    'fallback',
    'emoji',
    'pua',
    'symcmap',
    'rtl-yoffset',
  ]) {
    t.true(groups.has(group), group)
  }
  t.true(ROWS.length >= 900)
})

test.serial('rows match Chrome with the system renderer on macOS', (t) => {
  if (!DARWIN) {
    t.pass('pinned on macOS')
    return
  }
  const rows = ROWS.filter(([, row]) => !row.system || CAPTURE_DARWIN)
  const { mismatches, pinned } = check({ renderer: 'system', rows, flip: (row) => row.flip, widthOnly: false })
  // Off the capture's Darwin major the system-font rows are left out (521
  // pinned rows at S0 on macOS 26, 651 on macOS 27).
  t.true(pinned > (CAPTURE_DARWIN ? 600 : 450), `${pinned} pinned rows`)
  t.deepEqual(mismatches, [])
})

test.serial('rows still to flip differ from Chrome with the system renderer', (t) => {
  if (!DARWIN) {
    t.pass('pinned on macOS')
    return
  }
  const rows = ROWS.filter(([, row]) => !row.system || CAPTURE_DARWIN)
  t.deepEqual(check({ renderer: 'system', rows, flip: (row) => row.flip, widthOnly: false }).early, [])
})

// Rows with registered fonts only. Their widths and pixel relations do not
// depend on the OS.
const PORTABLE_ROWS = ROWS.filter(([, row]) => !row.system && row.kind !== 'color' && row.portable !== false)

test.serial('widths and draw order match Chrome with the portable renderer', (t) => {
  const { mismatches, pinned } = check({
    renderer: 'portable',
    rows: PORTABLE_ROWS,
    flip: (row) => row.flipPortable,
    widthOnly: true,
  })
  t.true(pinned > 450, `${pinned} pinned rows`)
  t.deepEqual(mismatches, [])
})

test.serial('rows still to flip differ from Chrome with the portable renderer', (t) => {
  t.deepEqual(
    check({ renderer: 'portable', rows: PORTABLE_ROWS, flip: (row) => row.flipPortable, widthOnly: true }).early,
    [],
  )
})
