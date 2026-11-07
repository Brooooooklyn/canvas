// Differential harness of the Blink-style shaper (DESIGN-SHAPER.md 3.1 and
// 3.3): the same .node lays out a fixed corpus with
// NAPI_RS_CANVAS_SHAPER=skparagraph and =blink, one child process each, and
// the glyph dumps, the TextMetrics and the drawn pixels are compared bit for
// bit. A case may differ only when one of its tags is in the stage's
// allow-list (the arithmetic classes the stage changes on purpose); any other
// difference fails, and so does a case that must be laid out by the new path
// but was turned down.
//
//   node __test__/shaper-diff.mjs [--limit N] [--out DIR]   both modes, compare
//   node __test__/shaper-diff.mjs --run FILE [--limit N]    one mode (child)
//
// The output (both JSONL files and the differences) goes to DIR, by default
// __test__/failure/shaper-diff, which CI uploads when a step fails. Removed
// with the old path (stage S10).

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// The stage this branch has landed, and the classes it may change.
const STAGE = 'S2'
const ALLOWED = new Set([
  // PR-D10: no forced liga 0 (letter spacing is still turned down in S2).
  'd10',
  // Q6: 8-bit text is Latin; digits and punctuation alone were Common.
  'digits8',
  // U+2028 / U+2029 stay in the text (space glyph, ubidi sees them).
  'separator',
  // SHY, LRM and the bidi controls are U+200B in the shaped text.
  'zw',
  // HarfBuzz's cmap: a (3,0) symbol cmap on FreeType.
  'symcmap',
  // 16.16 run sums against skparagraph's float sums past 256 px.
  'long',
  // ScriptRunIterator: extensions and brackets for 16-bit text.
  'script',
  // SymbolsIterator splits at emoji.
  'emoji',
  // Ink grouped by bidi run, and Blink's placement of mixed bidi text.
  'bidi',
  // RTL base, LTR text with y offsets: words placed in reverse (D43).
  'rtl-yoffset',
  // HarfBuzz scale trunc(size * 65536) against skshaper's round.
  'fractional',
  // Fallback inside a word: Blink adds the range with the item as context.
  'family-fallback',
  // The trailing spaces' glyphs are drawn (no ink), as Chrome draws them;
  // skparagraph's visit() leaves them out.
  'trailing-space',
])

const FONTS = {
  BSLato: 'Lato-Regular.ttf',
  BSSerif: 'SourceSerifPro-Regular.ttf',
  BSGar: 'EBGaramond-Regular.ttf',
  BSHarm: 'Harmattan-Regular.ttf',
  BSNKo: 'NotoSansNKo-Regular.ttf',
  BSHan: 'SourceHanSerifCN-Bold.ttf',
  BSDeva: 'NotoSansDevanagari-subset.ttf',
  BSSym: 'SymCmapProbe.ttf',
  BSScript: 'ScriptProbe.ttf',
  BSMong: 'NotoSansMongolian-Regular.ttf',
  BSColr: 'COLR-v1.ttf',
  BSMono: 'RobotoMono-VariableFont_wght.ttf',
  BSOswald: 'Oswald.ttf',
  BSNews: 'Newsreader-opsz-only.ttf',
}

// [text, font families, tags]
const TEXTS = [
  ['Hello world', 'BSLato', []],
  ['AVATAR Ta To We', 'BSLato', []],
  ['office affine fi fl ffi', 'BSGar', []],
  ['The quick brown fox jumps over the lazy dog', 'BSSerif', []],
  ['a', 'BSLato', []],
  [' ', 'BSLato', []],
  ['   ', 'BSLato', []],
  ['a  b', 'BSLato', []],
  [' lead', 'BSLato', []],
  ['trail ', 'BSLato', []],
  ['x.y,z;', 'BSLato', []],
  ['Wörld Ünïcödé', 'BSLato', []],
  ['1234567890', 'BSLato', ['digits8']],
  ['1', 'BSScript', ['digits8']],
  ['111', 'BSScript', ['digits8']],
  ['1 a', 'BSScript', ['digits8']],
  ['1.', 'BSScript', ['digits8']],
  ['áb', 'BSSerif', ['script']],
  ['b́c de', 'BSSerif', ['script', 'rtl-yoffset']],
  ['ẹ̈ x', 'BSSerif', ['script']],
  ['ab­cd', 'BSLato', ['zw']],
  ['a‎b', 'BSLato', ['zw']],
  ['a‫b‬c', 'BSLato', ['zw', 'bidi']],
  ['x﻿y', 'BSLato', ['zw']],
  ['a b', 'BSLato', ['separator']],
  ['a b c', 'BSLato', ['separator', 'bidi']],
  ['a\tb', 'BSLato', ['bidi']],
  ['a\nb', 'BSLato', ['bidi']],
  ['ab\ncd ef', 'BSLato', ['bidi']],
  ['سلام', 'BSHarm', ['script']],
  ['abc سلام def', 'BSHarm, BSLato', ['script', 'bidi', 'family-fallback']],
  ['١٢٣ ٤٥', 'BSHarm', ['script', 'bidi']],
  ['ߒߞߏ ߞߊ߲', 'BSNKo', ['script']],
  ['ᠮᠣᠩᠭᠣᠯ', 'BSMong', ['script']],
  ['नमस्ते दुनिया', 'BSDeva', ['script']],
  ['漢字', 'BSHan', ['script']],
  ['カタカナと漢字ひらがな', 'BSHan', ['script']],
  ['「漢字」', 'BSHan', ['script']],
  ['水 water', 'BSLato, BSHan', ['script', 'family-fallback']],
  ['Hamburgefonstiv水Hamburgefonstiv', 'BSLato, BSHan', ['script', 'family-fallback']],
  ['a　b', 'BSHan', ['script']],
  ['😀', 'BSColr', ['emoji', 'script']],
  ['a😀b', 'BSLato, BSColr', ['emoji', 'script', 'family-fallback']],
  [' ', 'BSSym', ['symcmap']],
  ['a', 'BSSym', ['symcmap']],
  ['ABC', 'BSSym', ['symcmap']],
  ['Mono 0123', 'BSMono', []],
  ['Oswald Title', 'BSOswald', []],
  ['Newsreader', 'BSNews', []],
  ['Hamburgefonstiv '.repeat(40), 'BSLato', ['long']],
  ['Hamburgefonstiv水'.repeat(40), 'BSLato, BSHan', ['long', 'script', 'family-fallback']],
  ['Hello world, fidelity '.repeat(100), 'BSLato', ['long']],
  // Two glyphs per character: one run holds at most kMaxGlyphs (32768)
  // glyphs (ShapeResultRun::LimitNumGlyphs).
  ['ā'.repeat(20000), 'BSGar', ['long']],
  ['NoSuchFamily text', 'NoSuchFamily, BSLato', []],
]

// One property changed at a time on a few texts.
const SETTINGS = [
  [{ fontKerning: 'none' }, []],
  [{ textRendering: 'optimizeSpeed' }, []],
  [{ textRendering: 'optimizeLegibility' }, []],
  [{ textRendering: 'geometricPrecision' }, []],
  [{ lang: 'tr' }, []],
  [{ lang: 'ja' }, []],
  [{ fontVariantLigatures: 'none' }, []],
  [{ fontVariantLigatures: 'discretionary-ligatures' }, []],
  [{ fontVariantNumeric: 'tabular-nums' }, []],
  [{ fontVariantPosition: 'super' }, []],
  [{ fontFeatureSettings: '"liga" 0, "kern" 0' }, []],
  [{ letterSpacing: '2px' }, ['d10']],
  [{ wordSpacing: '3px' }, []],
  [{ fontVariantCaps: 'small-caps' }, []],
  [{ fontSizeAdjust: '0.5' }, []],
]
const SETTING_TEXTS = ['Hello world', 'AVATAR Ta To We', 'office affine fi fl ffi', 'سلام', '水 water']

// Font shorthands: weight, style and size; fractional sizes floor to 1/100 px.
const SIZES = [
  ['40px', []],
  ['13px', []],
  ['bold 24px', []],
  ['italic 30px', []],
  ['14.6666667px', ['fractional']],
]

function cases() {
  const out = []
  for (const renderer of ['portable', 'system']) {
    for (const [text, families, tags] of TEXTS) {
      for (const direction of ['ltr', 'rtl']) {
        out.push({ renderer, text, font: `40px ${families}`, ctx: { direction }, tags, draw: false })
      }
      for (const [size, sizeTags] of SIZES.slice(1)) {
        if (text.length > 60) {
          continue
        }
        out.push({ renderer, text, font: `${size} ${families}`, ctx: {}, tags: [...tags, ...sizeTags], draw: false })
      }
      if (text.length <= 60) {
        out.push({ renderer, text, font: `40px ${families}`, ctx: {}, tags, draw: true })
        out.push({ renderer, text, font: `40px ${families}`, ctx: { direction: 'rtl' }, tags, draw: true })
      }
    }
    for (const [settings, settingTags] of SETTINGS) {
      for (const text of SETTING_TEXTS) {
        const families = TEXTS.find(([t]) => t === text)[1]
        const tags = [...TEXTS.find(([t]) => t === text)[2], ...settingTags]
        out.push({ renderer, text, font: `40px ${families}`, ctx: settings, tags, draw: false })
      }
    }
  }
  return out.map((c, i) => ({ id: i, ...c }))
}

// Whether the new path must lay a case out in this stage: plain text in the
// registered fonts, no spacing, caps or font-size-adjust, and every
// character in a family (no fallback tag).
function mustAccept(c) {
  const blocked = ['letterSpacing', 'wordSpacing', 'fontVariantCaps', 'fontSizeAdjust']
  if (blocked.some((p) => p in c.ctx)) {
    return false
  }
  if (c.tags.some((t) => ['emoji', 'family-fallback'].includes(t))) {
    return false
  }
  return /^[ -~]*$/.test(c.text) && !c.font.includes('NoSuchFamily')
}

const FIELDS = [
  'width',
  'actualBoundingBoxLeft',
  'actualBoundingBoxRight',
  'actualBoundingBoxAscent',
  'actualBoundingBoxDescent',
  'fontBoundingBoxAscent',
  'fontBoundingBoxDescent',
  'emHeightAscent',
  'emHeightDescent',
  'hangingBaseline',
  'alphabeticBaseline',
  'ideographicBaseline',
]

async function run(file, limit) {
  const { createCanvas, GlobalFonts, setTextRenderer } = require('../index.js')
  const binding = require('../js-binding.js')
  for (const [family, name] of Object.entries(FONTS)) {
    GlobalFonts.registerFromPath(join(__dirname, 'fonts', name), family)
  }
  const lines = []
  const all = cases().slice(0, limit)
  binding.__shaperStats(true)
  let renderer = null
  for (const c of all) {
    if (c.renderer !== renderer) {
      setTextRenderer(c.renderer)
      renderer = c.renderer
    }
    const before = JSON.parse(binding.__shaperStats(true))
    const ctx = createCanvas(10, 10).getContext('2d')
    ctx.font = c.font
    Object.assign(ctx, c.ctx)
    const m = ctx.measureText(c.text)
    const stats = JSON.parse(binding.__shaperStats(true))
    const laidOut = stats.accepted + stats.rejected.reduce((a, b) => a + b, 0) > 0
    const row = {
      id: c.id,
      metrics: FIELDS.map((f) => m[f]),
      dump: ctx.__debugTextLine(c.text),
      // null: the line came from the line cache (an earlier case).
      accepted: laidOut ? stats.accepted > 0 : null,
      rejected: stats.rejected.flatMap((n, i) => (n ? [i] : [])),
      cacheChanges: stats.cacheChanges + before.cacheChanges,
    }
    if (c.draw) {
      const w = Math.min(4096, Math.ceil(Math.abs(m.width)) + 40)
      const canvas = createCanvas(w, 80)
      const draw = canvas.getContext('2d')
      draw.font = c.font
      Object.assign(draw, c.ctx)
      draw.textBaseline = 'top'
      draw.fillText(c.text, 20, 10.3)
      row.pixels = createHash('sha1')
        .update(draw.getImageData(0, 0, w, 80).data)
        .digest('hex')
    }
    lines.push(JSON.stringify(row))
    // One case at a time: let the event loop run (machine rule).
    await new Promise(setImmediate)
  }
  writeFileSync(file, lines.join('\n') + '\n')
  process.stdout.write(JSON.stringify({ cases: all.length, maxRssKb: process.resourceUsage().maxRSS }) + '\n')
}

// Whether two line dumps draw the same glyphs for the same clusters, in the
// same order, once the glyphs of white space are left out.
function sameInk(text, oldDump, newDump) {
  const bytes = Buffer.from(text, 'utf8')
  const ink = (dump) =>
    JSON.stringify(
      JSON.parse(dump).runs.flatMap((run) =>
        run.glyphs.flatMap((glyph, i) =>
          /\s/.test(String.fromCharCode(bytes[run.clusters[i]])) ? [] : [[glyph, run.clusters[i]]],
        ),
      ),
    )
  return ink(oldDump) === ink(newDump)
}

function compare(oldFile, newFile, limit) {
  const all = cases().slice(0, limit)
  const read = (file) =>
    new Map(
      readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((l) => [JSON.parse(l).id, JSON.parse(l)]),
    )
  const before = read(oldFile)
  const after = read(newFile)
  const failures = []
  const allowed = []
  let accepted = 0
  let identical = 0
  for (const c of all) {
    const a = before.get(c.id)
    const b = after.get(c.id)
    const label = `#${c.id} ${c.renderer} ${c.font} ${JSON.stringify(c.ctx)} ${JSON.stringify(c.text.slice(0, 40))}`
    if (!a || !b) {
      failures.push(`${label}: missing`)
      continue
    }
    if (b.cacheChanges) {
      failures.push(`${label}: the text caches changed during a layout`)
    }
    if (b.accepted) {
      accepted++
    } else if (b.accepted === false && mustAccept(c)) {
      failures.push(`${label}: turned down (reasons ${b.rejected.join(',')})`)
    }
    const diffs = []
    if (JSON.stringify(a.metrics) !== JSON.stringify(b.metrics)) {
      diffs.push(`metrics ${JSON.stringify(a.metrics)} -> ${JSON.stringify(b.metrics)}`)
    }
    // The inkless box's word is read only when no glyph has ink.
    const inkless = (m) => m.slice(1, 5).every((v) => v === 0)
    const dump = (row) => {
      const parsed = JSON.parse(row.dump)
      if (!inkless(a.metrics)) {
        delete parsed.lastWordAdvance
      }
      return JSON.stringify(parsed)
    }
    if (dump(a) !== dump(b)) {
      diffs.push(`dump ${a.dump.slice(0, 400)} -> ${b.dump.slice(0, 400)}`)
    }
    if (a.pixels !== b.pixels) {
      diffs.push(`pixels ${a.pixels} -> ${b.pixels}`)
    }
    if (!diffs.length) {
      identical++
      continue
    }
    // Past 256 px skparagraph's float sums lose bits that 16.16 keeps.
    const tags = [...c.tags]
    const derived = []
    if (Math.abs(a.metrics[0]) > 256) {
      derived.push('long')
    }
    if (/\s$/.test(c.text)) {
      derived.push('trailing-space')
    }
    // A class found from the case rather than named in it allows only what
    // it is about: the same glyphs and clusters but the spaces' (drawn as
    // Chrome draws them), and for a long line rounding-sized moves.
    if (derived.length && sameInk(c.text, a.dump, b.dump)) {
      const width = Math.abs(a.metrics[0])
      const moved = Math.max(...a.metrics.map((v, i) => Math.abs(v - b.metrics[i])))
      if (derived.includes('trailing-space') && !moved && a.pixels === b.pixels) {
        tags.push('trailing-space')
      }
      if (derived.includes('long') && moved <= 1e-5 * width) {
        tags.push('long')
      }
    }
    const why = tags.filter((t) => ALLOWED.has(t))
    ;(why.length ? allowed : failures).push(`${label} [${tags.join(',')}]: ${diffs.join('; ')}`)
  }
  return { cases: all.length, identical, accepted, allowed, failures }
}

const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const limit = option('--limit') ? Number(option('--limit')) : undefined
if (option('--run')) {
  await run(option('--run'), limit)
} else {
  const out = option('--out') ?? join(__dirname, 'failure', 'shaper-diff')
  mkdirSync(out, { recursive: true })
  const files = {}
  for (const mode of ['skparagraph', 'blink']) {
    files[mode] = join(out, `${mode}.jsonl`)
    const extra = limit ? ['--limit', String(limit)] : []
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--run', files[mode], ...extra], {
      env: { ...process.env, NAPI_RS_CANVAS_SHAPER: mode },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    if (child.status !== 0) {
      console.error(`${mode} run failed: ${child.status} ${child.signal ?? ''}`)
      process.exit(1)
    }
    console.log(`${mode}: ${child.stdout.trim()}`)
  }
  const result = compare(files.skparagraph, files.blink, limit)
  writeFileSync(join(out, 'diff.json'), JSON.stringify(result, null, 2))
  console.log(
    `${STAGE}: ${result.cases} cases, ${result.identical} identical, ${result.allowed.length} allowed differences, ${result.accepted} laid out by the Blink shaper, ${result.failures.length} failures`,
  )
  for (const failure of result.failures) {
    console.log(`FAIL ${failure}`)
  }
  process.exit(result.failures.length ? 1 : 0)
}
