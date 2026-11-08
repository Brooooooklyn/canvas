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

import { spawnSync } from 'node:child_process'
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
  // The old path matches Chrome here by another route than Chrome's, and the
  // shaper reaches Chrome only from this stage: with the switch on the row is
  // not checked before it.
  blinkFrom?: string
  // The row differs from Chrome for a reason outside the shaper that is
  // handed off (DESIGN-SHAPER.md 1.2: q5 S1 system-ui CJK font choice, q5 S3
  // Hiragino Sans face choice); not checked with the switch on (the old path
  // is still checked to differ, as for any row before its flip stage).
  handoff?: string
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
const LANDED = 'S8'
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
      if (BLINK && row.blinkFrom && STAGES.indexOf(row.blinkFrom) > STAGES.indexOf(LANDED)) {
        continue
      }
      if (BLINK && row.handoff) {
        continue
      }
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
    'han-kerning',
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
    'lang',
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

// A first cluster of more than 32768 glyphs (Blink's kMaxGlyphs): Blink cuts
// the run at kMaxGlyphs and skips the rest of it, so the "b" after the marks
// is not drawn. Chrome 157, 10px EB Garamond, LTR and RTL: 9.139984130859375
// with 16000 marks, 3.989990234375 (the width of "a") with 16385. The old
// path keeps the "b".
test.serial('a cluster longer than kMaxGlyphs is cut as in Chrome', (t) => {
  if (!BLINK) {
    t.pass('the new path only')
    return
  }
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'EBGaramond-Regular.ttf'), 'KMaxGaramond')
  const widths = (['system', 'portable'] as const).flatMap((renderer) => {
    setTextRenderer(renderer)
    try {
      return (['ltr', 'rtl'] as const).flatMap((direction) =>
        [16000, 16385].map((marks) => {
          const ctx = createCanvas(10, 10).getContext('2d')
          ctx.font = '10px KMaxGaramond'
          ctx.direction = direction
          return ctx.measureText(`a${'̈́'.repeat(marks)}b`).width
        }),
      )
    } finally {
      setTextRenderer('system')
    }
  })
  t.deepEqual(
    widths,
    [9.139984130859375, 3.989990234375, 9.139984130859375, 3.989990234375].concat([
      9.139984130859375, 3.989990234375, 9.139984130859375, 3.989990234375,
    ]),
  )
})

// More than 100 system fallback faces in one line (DESIGN-SHAPER.md 2.9: an
// entry keeps its HarfBuzz font alive past the LRU of 100). One letter of
// each of 137 scripts in 40px Lato: 120 fonts on macOS 27.2. Chrome 157:
// 3995.6025390625 (the old path: 4605.10693359375).
test.serial('a line with more than 100 fallback faces is laid out like Chrome', (t) => {
  if (!BLINK || !CAPTURE_DARWIN) {
    t.pass('the new path with the macOS system fonts of the capture')
    return
  }
  const text = [
    0x0531, 0x05d0, 0x0710, 0x0780, 0x07ca, 0x0800, 0x0840, 0x0905, 0x0985, 0x0a05, 0x0a85, 0x0b05, 0x0b85, 0x0c05,
    0x0c85, 0x0d05, 0x0d85, 0x0e01, 0x0e81, 0x0f40, 0x1000, 0x10d0, 0x1100, 0x1200, 0x13a0, 0x1401, 0x1681, 0x16a0,
    0x1700, 0x1720, 0x1740, 0x1760, 0x1780, 0x1820, 0x1900, 0x1950, 0x1980, 0x1a00, 0x1a20, 0x1b05, 0x1b83, 0x1bc0,
    0x1c00, 0x1c5a, 0x2c00, 0x2c80, 0x2d30, 0x3041, 0x30a1, 0x3105, 0x4e00, 0xa000, 0xa4d0, 0xa500, 0xa6a0, 0xa800,
    0xa840, 0xa882, 0xa8f2, 0xa90a, 0xa930, 0xa984, 0xaa00, 0xaa80, 0xabc0, 0xac00, 0x10000, 0x10280, 0x102a0, 0x10300,
    0x10330, 0x10380, 0x103a0, 0x10400, 0x10450, 0x10480, 0x10500, 0x10530, 0x10600, 0x10800, 0x10840, 0x10900, 0x10920,
    0x10980, 0x109a0, 0x10a00, 0x10a60, 0x10b00, 0x10b40, 0x10b60, 0x10c00, 0x11003, 0x11083, 0x110d0, 0x11103, 0x11183,
    0x11680, 0x12000, 0x13000, 0x16800, 0x16a40, 0x16f00, 0x1b001, 0x1e800, 0x1e900, 0x10860, 0x10880, 0x108e0, 0x10a80,
    0x10ac0, 0x10b80, 0x10c80, 0x10d00, 0x10f30, 0x11150, 0x11200, 0x11280, 0x112b0, 0x11305, 0x11400, 0x11480, 0x11580,
    0x11600, 0x11700, 0x11800, 0x118a0, 0x11a00, 0x11ac0, 0x11c00, 0x11d00, 0x14400, 0x16ad0, 0x16b00, 0x16e40, 0x1bc00,
    0x1e100, 0x1e2c0,
  ]
    .map((c) => String.fromCodePoint(c))
    .join('')
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = '40px BSLato'
  t.is(ctx.measureText(text).width, 3995.6025390625)
  const line = JSON.parse((ctx as unknown as { __debugTextLine(text: string): string }).__debugTextLine(text))
  t.true(new Set(line.runs.map((run: { family: string }) => run.family)).size > 100)
})

// A private use character picked as the hint (ChooseHintIndex: the first
// hint after the first with a likely script; PUA's script is Unknown) gets
// no system font (FontCache::FallbackFontForCharacter returns none for
// private use), so the iterator goes on to the last resort font and then the
// first candidate: the ∅ next to it is drawn with Lato's .notdef too, though
// ∅ alone gets Apple Symbols. Chrome 157, 40px Lato, [width,
// actualBoundingBoxRight]; the old path keeps the Apple Symbols ∅.
test.serial('a private use hint makes its neighbours .notdef as in Chrome', (t) => {
  if (!BLINK || !CAPTURE_DARWIN) {
    t.pass('the new path with the macOS system fonts of the capture')
    return
  }
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = '40px BSLato'
  t.deepEqual(
    ['∅', '∅', '∅', '∅∅', 'a∅b', ''].map((text) => {
      const metrics = ctx.measureText(text)
      return [metrics.width, metrics.actualBoundingBoxRight]
    }),
    [
      [28.69140625, 25.8984375],
      [42.519989013671875, 41.63999557495117],
      [42.519989013671875, 41.63999557495117],
      [63.77998352050781, 62.899993896484375],
      [92.59140014648438, 91.15140533447266],
      [21.259994506835938, 20.380001068115234],
    ],
  )
})

// D19: with ctx.lang "inherit" the shaper takes the host's UI language
// (LayoutLocale::GetDefault) for the HarfBuzz language, the case map locale
// and HanKerning's locale. Each child process sets the language through the
// Linux rule (l10n_util.cc: LANGUAGE, LC_ALL, LC_MESSAGES, LANG; C and POSIX
// are en-US); NAPI_RS_CANVAS_TEST_POSIX_LANGUAGE=1 makes the resolver use
// that rule on every OS (test only; macOS and Windows read the OS settings).
// Chrome 157 with -AppleLanguages (en-US / tr / ja / zh-Hant-TW), widths of
// [100px LoclProbe "a", 40px BSHalt "水。、水", 40px BSChws "水。、水",
// 40px BSHalt "（水）。", 40px BSLato small-caps "i", all-small-caps "iI"].
test.serial('"inherit" follows the host language like Chrome', (t) => {
  const HOSTS: [Record<string, string>, number[]][] = [
    [{ LANG: 'C' }, [82.09999084472656, 140, 120, 140, 8.595993041992188, 17.191986083984375]],
    [{ LANGUAGE: 'tr' }, [46.19999694824219, 140, 120, 140, 9.32421875, 17.920211791992188]],
    [{ LANG: 'ja_JP.UTF-8' }, [92, 140, 120, 140, 8.595993041992188, 17.191986083984375]],
    [{ LANG: 'zh_TW.UTF-8' }, [50.69999694824219, 160, 120, 140, 8.595993041992188, 17.191986083984375]],
    // GLib also lists the name without its modifier, which Chrome takes ("de";
    // Chrome 157 with -AppleLanguages (de): LoclProbe 76.6, DEU).
    [{ LANG: 'de_DE@euro' }, [76.59999084472656, 140, 120, 140, 8.595993041992188, 17.191986083984375]],
  ]
  // The old path does not read the host language (dflt, no HanKerning).
  const OLD = [50.69999694824219, 160, 160, 160, 8.595993041992188, 17.191986083984375]
  const fonts = Object.fromEntries(
    Object.entries(FIXTURE.fonts).map(([family, file]) => [family, join(__dirname, 'fonts', file)]),
  )
  const script = `
    const { createCanvas, GlobalFonts, setTextRenderer } = require(${JSON.stringify(join(__dirname, '..', 'index.js'))})
    for (const [family, file] of Object.entries(${JSON.stringify(fonts)})) GlobalFonts.registerFromPath(file, family)
    const out = {}
    for (const renderer of ['system', 'portable']) {
      setTextRenderer(renderer)
      out[renderer] = [
        ['100px BSLocl', 'a', {}],
        ['40px BSHalt', '水。、水', {}],
        ['40px BSChws', '水。、水', {}],
        ['40px BSHalt', '（水）。', {}],
        ['40px BSLato', 'i', { fontVariantCaps: 'small-caps' }],
        ['40px BSLato', 'iI', { fontVariantCaps: 'all-small-caps' }],
      ].map(([font, text, props]) => {
        const ctx = createCanvas(10, 10).getContext('2d')
        ctx.font = font
        Object.assign(ctx, props)
        return ctx.measureText(text).width
      })
    }
    console.log(JSON.stringify(out))`
  const run = (shaper: string, host: Record<string, string>) => {
    const child = spawnSync(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        LANGUAGE: '',
        LC_ALL: '',
        LC_MESSAGES: '',
        LANG: '',
        ...host,
        NAPI_RS_CANVAS_SHAPER: shaper,
        NAPI_RS_CANVAS_TEST_POSIX_LANGUAGE: '1',
      },
      encoding: 'utf8',
    })
    t.is(child.status, 0, child.stderr)
    return JSON.parse(child.stdout) as Record<string, number[]>
  }
  const close = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 1e-3)
  for (const [host, chrome] of HOSTS) {
    const blink = run('blink', host)
    for (const renderer of ['system', 'portable']) {
      t.true(
        close(blink[renderer], chrome),
        `${JSON.stringify(host)} ${renderer}: ${blink[renderer]} (Chrome ${chrome})`,
      )
    }
  }
  const old = run('skparagraph', { LANGUAGE: 'tr' })
  t.true(close(old.system, OLD), `old path: ${old.system}`)
})

// A line the shaper turns down (a character no family draws, with the
// portable renderer: ShaperReject::kFallback) goes to the old path with the
// host language the shaper gives "inherit", as an explicit lang does: the
// rest of the line keeps the host language's glyphs and case map. [text
// width, width of U+E000 alone] per lang; the letter is the difference.
// LoclProbe "a" is 46.2 with tr (TRK locl), 82.1 with en (ENG), 50.7 with
// none; Turkish small-caps "i" (dotted capital I) is 9.324, else 8.596.
test.serial('a line the shaper turns down keeps the host language', (t) => {
  const fonts = Object.fromEntries(
    Object.entries(FIXTURE.fonts).map(([family, file]) => [family, join(__dirname, 'fonts', file)]),
  )
  const script = `
    const { createCanvas, GlobalFonts, setTextRenderer } = require(${JSON.stringify(join(__dirname, '..', 'index.js'))})
    const binding = require(${JSON.stringify(join(__dirname, '..', 'js-binding.js'))})
    for (const [family, file] of Object.entries(${JSON.stringify(fonts)})) GlobalFonts.registerFromPath(file, family)
    setTextRenderer('portable')
    const width = (font, text, lang, props) => {
      const ctx = createCanvas(10, 10).getContext('2d')
      ctx.font = font
      Object.assign(ctx, props)
      ctx.lang = lang
      return ctx.measureText(text).width
    }
    const out = {}
    for (const [name, font, text, props] of [
      ['locl', '100px BSLocl', 'a', {}],
      ['caps', '40px BSLato', 'i', { fontVariantCaps: 'small-caps' }],
    ]) {
      out[name] = {}
      for (const lang of ['inherit', 'tr', 'en']) {
        binding.__shaperStats(true)
        const alone = width(font, text, lang, props)
        const accepted = JSON.parse(binding.__shaperStats(true)).rejected[5] === 0
        const line = width(font, text + '\\uE000', lang, props)
        const rejected = JSON.parse(binding.__shaperStats(true)).rejected[5] > 0
        out[name][lang] = { alone, letter: line - width(font, '\\uE000', lang, props), accepted, rejected }
      }
    }
    console.log(JSON.stringify(out))`
  const run = (shaper: string) => {
    const child = spawnSync(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        LANGUAGE: 'tr',
        LC_ALL: '',
        LC_MESSAGES: '',
        LANG: '',
        NAPI_RS_CANVAS_SHAPER: shaper,
        NAPI_RS_CANVAS_TEST_POSIX_LANGUAGE: '1',
      },
      encoding: 'utf8',
    })
    t.is(child.status, 0, child.stderr)
    return JSON.parse(child.stdout) as Record<
      string,
      Record<string, { alone: number; letter: number; accepted: boolean; rejected: boolean }>
    >
  }
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-3
  const EXPECTED: Record<string, { tr: number; en: number; none: number }> = {
    locl: { tr: 46.19999694824219, en: 82.09999084472656, none: 50.69999694824219 },
    caps: { tr: 9.32421875, en: 8.595993041992188, none: 8.595993041992188 },
  }
  const blink = run('blink')
  for (const [name, expected] of Object.entries(EXPECTED)) {
    for (const lang of ['inherit', 'tr', 'en']) {
      const got = blink[name][lang]
      t.true(got.accepted && got.rejected, `${name} ${lang}: the shaper lays out the letter and turns the line down`)
      const want = lang === 'en' ? expected.en : expected.tr
      t.true(near(got.alone, want), `${name} ${lang} alone: ${got.alone} (${want})`)
      t.true(near(got.letter, want), `${name} ${lang} in the turned-down line: ${got.letter} (${want})`)
    }
  }
  // The old path does not read the host language ("inherit" is no lang).
  const old = run('skparagraph')
  for (const [name, expected] of Object.entries(EXPECTED)) {
    t.true(near(old[name].inherit.letter, expected.none), `old path ${name}: ${old[name].inherit.letter}`)
    t.true(near(old[name].tr.letter, expected.tr), `old path ${name} tr: ${old[name].tr.letter}`)
  }
})

// A line the shaper turns down picks its fonts as the shaper does
// (ResolveFontRequest): the families with the locale's font settings and
// their sizes under font-size-adjust. Under -webkit-body as the
// description's generic family an installed family is the standard font, a
// generic family sized at its own aspect; a -webkit-body that is not the
// description's generic family is an installed family at the primary's
// size. Portable renderer, so U+E000 (no family has it) turns the line down.
// "Times New Roman" (the portable standard font) is registered in case no
// such font is installed; where one is (macOS, Windows) it takes the name.
test.serial('a line the shaper turns down keeps the font sizes of the shaper', (t) => {
  const script = `
    const { createCanvas, GlobalFonts, setTextRenderer } = require(${JSON.stringify(join(__dirname, '..', 'index.js'))})
    const binding = require(${JSON.stringify(join(__dirname, '..', 'js-binding.js'))})
    GlobalFonts.registerFromPath(${JSON.stringify(join(__dirname, 'fonts', 'Lato-Regular.ttf'))}, 'BSLato')
    GlobalFonts.registerFromPath(${JSON.stringify(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf'))}, 'Times New Roman')
    setTextRenderer('portable')
    const out = []
    for (const font of ['40px BSLato, Times New Roman, -webkit-body', '40px BSLato, -webkit-body, serif', '40px BSLato, -webkit-body']) {
      for (const fontSizeAdjust of ['0.5', 'none']) {
        const ctx = createCanvas(10, 10).getContext('2d')
        ctx.font = font
        ctx.fontSizeAdjust = fontSizeAdjust
        const width = (text) => ctx.measureText(text).width
        binding.__shaperStats(true)
        const alone = width('\u2192')
        const accepted = JSON.parse(binding.__shaperStats(true)).rejected[5] === 0
        const letter = width('\u2192\u2192\uE000') - width('\u2192\uE000')
        const rejected = JSON.parse(binding.__shaperStats(true)).rejected[5] > 0
        out.push({ font, fontSizeAdjust, alone, letter, accepted, rejected })
      }
    }
    console.log(JSON.stringify(out))`
  const child = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, NAPI_RS_CANVAS_SHAPER: 'blink' },
    encoding: 'utf8',
  })
  t.is(child.status, 0, child.stderr)
  const rows = JSON.parse(child.stdout) as {
    font: string
    fontSizeAdjust: string
    alone: number
    letter: number
    accepted: boolean
    rejected: boolean
  }[]
  for (const { font, fontSizeAdjust, alone, letter, accepted, rejected } of rows) {
    const name = `${font} fontSizeAdjust ${fontSizeAdjust}`
    t.true(accepted && rejected, `${name}: the shaper lays out the arrow and turns the line down`)
    t.true(Math.abs(alone - letter) <= 1e-3, `${name}: alone ${alone}, in the turned-down line ${letter}`)
  }
})

// The font-metric units of ctx.filter read the canvas font with its locale
// (the canvas state's font: SetFontForFilter, FontSizes::Ex / Ch / Cap /
// Ic), so a generic family takes the setting of the lang's script, or of the
// host's UI language for "inherit", as the text does. Chrome 157
// OffscreenCanvas (as filter-parse-chrome.spec.ts): 5 units as the red of a
// drop-shadow() color; the "ja" host rows are from desktop Chrome with
// -AppleLanguages (ja), the others from an en-GB host
// (stages/S8/review-r2/chrome-units-*.json). [lang (none: "inherit"), font,
// unit, red].
test.serial('filter font units follow the lang like the text', (t) => {
  if (!CAPTURE_DARWIN) {
    t.pass('the macOS system fonts of the capture')
    return
  }
  const HOSTS: [Record<string, string>, [string | null, string, string, number][]][] = [
    [
      { LANG: 'ja_JP.UTF-8' },
      [
        [null, '40px serif', 'ic', 200],
        [null, '40px serif', 'ex', 108],
        [null, '40px serif', 'ch', 118],
        [null, '40px serif', 'cap', 149],
        [null, '20px serif', 'ic', 100],
        [null, 'bold 40px serif', 'ic', 200],
        [null, '40px NoSuchFamily', 'ic', 200],
        [null, '40px Times', 'ic', 80],
        ['en', '40px sans-serif', 'ic', 200],
      ],
    ],
    [
      { LANG: 'en_US.UTF-8' },
      [
        [null, '40px serif', 'ic', 80],
        [null, '40px serif', 'ex', 90],
        ['ja', '40px serif', 'ic', 200],
        ['ja', '40px serif', 'ex', 108],
        ['ja', '40px NoSuchFamily', 'ic', 200],
        ['zh-CN', '40px serif', 'ic', 200],
        ['zh-CN', '40px serif', 'ch', 94],
        ['zh-CN', '40px serif', 'cap', 139],
        ['ko', '40px sans-serif', 'ic', 173],
        ['en', '40px serif', 'ic', 80],
      ],
    ],
  ]
  for (const [host, rows] of HOSTS) {
    const script = `
      const { createCanvas, setTextRenderer } = require(${JSON.stringify(join(__dirname, '..', 'index.js'))})
      setTextRenderer('system')
      console.log(JSON.stringify(${JSON.stringify(rows)}.map(([lang, font, unit]) => {
        const ctx = createCanvas(60, 20).getContext('2d')
        if (lang) ctx.lang = lang
        ctx.font = font
        ctx.filter = 'drop-shadow(20px 0 0 rgb(calc(5' + unit + ' / 1px) 0 0))'
        ctx.fillStyle = 'blue'
        ctx.fillRect(0, 0, 20, 20)
        return ctx.getImageData(30, 10, 1, 1).data[0]
      })))`
    const child = spawnSync(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        LANGUAGE: '',
        LC_ALL: '',
        LC_MESSAGES: '',
        LANG: '',
        ...host,
        NAPI_RS_CANVAS_SHAPER: 'blink',
        NAPI_RS_CANVAS_TEST_POSIX_LANGUAGE: '1',
      },
      encoding: 'utf8',
    })
    t.is(child.status, 0, child.stderr)
    const reds = JSON.parse(child.stdout) as number[]
    rows.forEach(([lang, font, unit, chrome], i) => {
      t.is(reds[i], chrome, `${JSON.stringify(host)} ${lang} ${font} 5${unit}`)
    })
  }
})

// The generic families follow the host's UI language too: Chrome registers
// no per-script default for the UI locale's own script, and the common
// defaults come from that locale's locale_settings_mac_<ui>.xtb (ja, ko,
// zh-CN, zh-TW, ar, he, fa). Desktop Chrome 157 with -AppleLanguages (ja /
// zh-TW / ar / ko), "Ag" widths; headless Chrome does not apply the common
// defaults, so these are headed captures. [lang (none: "inherit"), font,
// width].
test.serial('generic families follow the host language like Chrome', (t) => {
  if (!BLINK || !CAPTURE_DARWIN) {
    t.pass('the new path with the macOS system fonts of the capture')
    return
  }
  const HOSTS: [Record<string, string>, [string | null, string, number][]][] = [
    [
      { LANG: 'ja_JP.UTF-8' },
      [
        [null, '40px serif', 50.83998107910156],
        [null, '40px sans-serif', 55.63999938964844],
        [null, '40px -webkit-body', 55.63999938964844],
        ['en', '40px serif', 50.83998107910156],
        ['ja', '40px serif', 50.83998107910156],
        ['zh-CN', '40px serif', 45.91998291015625],
        ['ar', '40px sans-serif', 55.63999938964844],
      ],
    ],
    [
      { LANG: 'zh_TW.UTF-8' },
      [
        [null, '40px serif', 45.91998291015625],
        [null, '40px cursive', 47.15998840332031],
        [null, '40px BSNo', 49.91999816894531],
        ['ja', '40px serif', 50.83998107910156],
        ['ja', '40px cursive', 47.15998840332031],
        ['ko', '40px sans-serif', 44.43998718261719],
        ['zh-TW', '40px serif', 45.91998291015625],
      ],
    ],
    [
      { LANG: 'ar_EG.UTF-8' },
      [
        [null, '40px monospace', 48.0078125],
        ['en', '40px monospace', 48.0078125],
        ['ja', '40px serif', 50.83998107910156],
        ['zh-TW', '40px monospace', 48.0078125],
      ],
    ],
    [
      { LANG: 'ko_KR.UTF-8' },
      [
        [null, '40px serif', 48.9755859375],
        [null, '40px BSNo', 44.43998718261719],
        ['en', '40px -webkit-body', 44.43998718261719],
        ['ko', '40px serif', 48.9755859375],
      ],
    ],
  ]
  for (const [host, rows] of HOSTS) {
    const script = `
      const { createCanvas, setTextRenderer } = require(${JSON.stringify(join(__dirname, '..', 'index.js'))})
      setTextRenderer('system')
      console.log(JSON.stringify(${JSON.stringify(rows)}.map(([lang, font]) => {
        const ctx = createCanvas(10, 10).getContext('2d')
        ctx.font = font
        if (lang) ctx.lang = lang
        return ctx.measureText('Ag').width
      })))`
    const child = spawnSync(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        LANGUAGE: '',
        LC_ALL: '',
        LC_MESSAGES: '',
        LANG: '',
        ...host,
        NAPI_RS_CANVAS_SHAPER: 'blink',
        NAPI_RS_CANVAS_TEST_POSIX_LANGUAGE: '1',
      },
      encoding: 'utf8',
    })
    t.is(child.status, 0, child.stderr)
    const widths = JSON.parse(child.stdout) as number[]
    rows.forEach(([lang, font, chrome], i) => {
      t.true(
        Math.abs(widths[i] - chrome) <= 1e-3,
        `${JSON.stringify(host)} ${lang} ${font}: ${widths[i]} (Chrome ${chrome})`,
      )
    })
  }
})

// -webkit-body as the description's generic family gives Standard(script)
// to every family that is not a web font (FontSelector::
// FamilyNameFromSettings). CSSFontSelector::GetFontData asks FontFaceCache
// by family name first, and it takes the family's best face for any
// request, so a registered face of any style keeps the family, also when
// installed faces share its name. Chrome 157, "bold 40px AppleMyungjo,
// -webkit-body" "Ag": 59.99998 (Hiragino Kaku Gothic ProN W6) with lang ja
// and 48.887 (Times) with no lang (en-US host); with a bold FontFace
// "AppleMyungjo" (SourceHanSerifCN-Bold) 53.28125 for both. In a child
// process, as the face would replace AppleMyungjo for the other rows.
test.serial('a registered face keeps a family that is also installed under -webkit-body', (t) => {
  if (!BLINK || !CAPTURE_DARWIN) {
    t.pass('the new path with the macOS system fonts of the capture')
    return
  }
  const script = `
    const { createCanvas, GlobalFonts, setTextRenderer } = require(${JSON.stringify(join(__dirname, '..', 'index.js'))})
    setTextRenderer('system')
    const widths = () => ['ja', 'inherit'].map((lang) => {
      const ctx = createCanvas(10, 10).getContext('2d')
      ctx.font = 'bold 40px AppleMyungjo, -webkit-body'
      ctx.lang = lang
      return ctx.measureText('Ag').width
    })
    const installed = widths()
    GlobalFonts.registerFromPath(${JSON.stringify(join(__dirname, 'fonts', 'SourceHanSerifCN-Bold.ttf'))}, 'AppleMyungjo')
    console.log(JSON.stringify({ installed, registered: widths() }))`
  const child = spawnSync(process.execPath, ['-e', script], {
    env: {
      ...process.env,
      LANGUAGE: '',
      LC_ALL: '',
      LC_MESSAGES: '',
      LANG: 'C',
      NAPI_RS_CANVAS_SHAPER: 'blink',
      NAPI_RS_CANVAS_TEST_POSIX_LANGUAGE: '1',
    },
    encoding: 'utf8',
  })
  t.is(child.status, 0, child.stderr)
  const { installed, registered } = JSON.parse(child.stdout) as Record<string, number[]>
  const close = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 1e-3)
  t.true(close(installed, [59.99998474121094, 48.88671875]), `installed: ${installed}`)
  t.true(close(registered, [53.28125, 53.28125]), `registered: ${registered}`)
})
