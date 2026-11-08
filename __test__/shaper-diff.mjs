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
const STAGE = 'S5'
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
  // A run holds at most 32768 glyphs (Blink's kMaxGlyphs): 40000 glyphs
  // are shaped as two runs. Chrome 157 gives the new width.
  'max-glyphs',
  // The trailing spaces' glyphs are drawn (no ink), as Chrome draws them;
  // skparagraph's visit() leaves them out.
  'trailing-space',
  // S3, the system fallback on Apple (CoreText from the primary font at
  // ComputedPixelSize, no language, Blink's stages and hint rule, the range
  // shaped with the whole item as context). Chrome 157 (blink-shaper.json):
  // "fallback: 这们 ja" (L -2.44, the no-language value) and
  // "spacing: ls0.he_niqqud" (90.80078125).
  'system-fallback',
  // S3, emoji presentation (VS16, or an emoji segment) from Apple Color
  // Emoji. Chrome 157: "emoji: \"☺️\"" and "emoji: \"☃️\"" (40, color),
  // "spacing: ls0.vs16" and "emoji: \"a©️b\"" (82.64).
  'vs16',
  // S3, text presentation (VS15) of an emoji from Apple Symbols, drawn
  // without color. Chrome 157: "emoji: \"⌚︎\"" (23.125) and
  // "emoji: \"⭐︎\"" (32.52), both without color.
  'vs15',
  // S3, a selector after a character it makes no variation sequence with
  // is not looked at (Character::IsVariationSequence) and stays in its
  // base's cluster (HarfBuzz's default cluster level, D8). Chrome 157, 40px
  // Lato: "a\uFE0Fb" 42.64 (stages/S3/vs-chrome.json).
  'vs-ignored',
  // S3, a private use or non-character has no fallback font: the first
  // font's .notdef. Chrome 157: "pua: 16px \"g_d0_f1\", sans-serif" rows
  // (10.140625 for U+E000, U+F8FF, U+100000, U+FFFE).
  'pua',
  // S4, letter spacing once per cluster, on its last glyph in HarfBuzz order
  // (ShapeResult::ApplySpacingOrExpansion), none between the letters of a
  // cursive script or after a zero width character. Chrome 157
  // (blink-shaper.json): "spacing: ls.q0301" (59.32, two spacings for
  // "q\u0301x"), "spacing: ls.deva_word" (116.48), "spacing: ls.vs16"
  // (106.64).
  'ls-cluster',
  // S4, word spacing on the TreatAsSpace characters (space, tab, NBSP) but a
  // space at the string's start; none on U+2002, U+3000, U+2028. Chrome 157
  // (blink-shaper.json): "spacing: ws.lead2" (68.08), "spacing: ws.nbspLead"
  // (60.36), "spacing: ws.en2002" (62.64), "spacing: han.ws.3000" (120),
  // "spacing: ws.ls2028" (50.36).
  'ws-rule',
  // S4, spacing below 0: the widths are not clamped, and an item narrower
  // than nothing has its ink box outset to the left. Chrome 157
  // (blink-shaper.json): "spacing: neg.ls_big" (-58.68, left 58.68),
  // "spacing: neg.ws_big" (-9.64, left 28.96).
  'negative-spacing',
  // S4, spacing as TextRunLayoutUnit (truncated to 1/65536 px). Chrome 157
  // (blink-shaper.json): "spacing: tiny.ls" (0.0002px: 181.20192).
  'ls-quantize',
  // S5, font-variant-caps per font in the fallback loop: each font uses its
  // own caps features for the segment's script, or synthesizes small caps
  // (uppercase at 70% of the size) when it has none; the old path asked the
  // primary font only. Chrome 157, system renderer (stages/S5/caps-chrome.json),
  // small-caps: 40px "BSLato, BSSerif" "Hello αβγ q\u0301x" 223.7999 (old
  // path 200.6879), 40px "BSGothic, BSHan" "Hello αβγ Ωμέγα" 348.9197
  // (365.2615), 40px "BSLato, BSSerif" lang el "άλφα Ωμέγα" 228.7999
  // (185.4639).
  'caps-per-font',
  // S5, a run of combining marks only (SmallCapsIterator's
  // kSmallCapsInvalid) is not synthesized: no case change and the font's own
  // size. Chrome 157 (stages/S5/caps-chrome.json): 30px BSOswald
  // all-small-caps "\u0301\u0308" ink 4.2 4.2 31.26 -18.78 (old path drew
  // it at 21px: 2.94 2.94 21.882 -13.146).
  'caps-marks',
  // S5 (detected, not tagged): a case map that changes the UTF-8 length
  // (ß to SS, Turkish i to İ, ı to I) moves only the clusters: the new
  // path's index the fillText string, as Blink's
  // CaseMappingHarfBuzzBufferFiller keeps the original indices, the old
  // path's index its case-mapped copy. The same glyphs at the same places,
  // the same pixels, and the same metrics up to a long line's rounding.
  // Chrome 157 (stages/S5/caps-chrome.json) gives the new metrics for each:
  // 40px BSOswald lang tr small-caps "İstanbul ılık iI" 177.1799.
  'caps-clusters',
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
  BSArA: 'ArA.ttf',
  BSArB: 'ArB.ttf',
  BSGothic: 'ScienceGothic-VariableFont.ttf',
}

// One letter of each of these scripts, most of which no font in the
// corpus has: on macOS each falls back to its own system font.
const FACES = [
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
  ['ā'.repeat(20000), 'BSGar', ['long', 'max-glyphs']],
  ['NoSuchFamily text', 'NoSuchFamily, BSLato', []],
  // Arabic joining across two families (the S2 flip, fixture "arabic:
  // split none").
  ['بلبل', 'BSArA, BSArB', ['script', 'family-fallback']],
  ['ببلبب', 'BSArA, BSArB', ['script', 'family-fallback']],
  // Turkish dotted and dotless i (and with lang tr in SETTINGS).
  ['İstanbul ılık şğü', 'BSLato', []],
  // Variation selectors the family fonts shape: none makes a variation
  // sequence with its base, so it is not looked at.
  ['a\uFE0Fb', 'BSLato', ['vs-ignored']],
  // "1" is an emoji: "1\uFE0F" is drawn from Apple Color Emoji. Chrome 157,
  // 40px Lato: 90.36 for the whole text, 40 for "1\uFE0F" alone.
  ['a\uFE0Eb 1\uFE0F', 'BSLato', ['vs-ignored', 'vs16']],
  // S3: characters no family has (system fallback on macOS with the system
  // renderer; elsewhere the old path lays them out).
  ['שָׁלוֹם', 'BSLato', ['system-fallback']],
  ['这们', 'BSLato', ['system-fallback']],
  ['漢字かな', 'BSLato', ['system-fallback']],
  // A run that starts with Common punctuation (the hint rule).
  ['「漢字」', 'BSLato', ['system-fallback']],
  ['abc سلام def', 'BSLato', ['script', 'bidi', 'system-fallback']],
  ['Hamburgefonstiv\u0E2A\u0E27\u0E31\u0E2A\u0E14\u0E35Hamburgefonstiv', 'BSLato', ['system-fallback']],
  ['AV漢AV To', 'BSLato', ['system-fallback']],
  ['News 漢字', 'BSNews', ['system-fallback']],
  ['x\u3000y', 'BSLato', ['system-fallback']],
  ['😀', 'BSLato', ['emoji', 'vs16']],
  ['a☺️b', 'BSLato', ['emoji', 'vs16']],
  ['a©️b', 'BSLato', ['emoji', 'vs16']],
  ['☃️', 'BSLato', ['emoji', 'vs16']],
  ['⌚︎', 'BSLato', ['emoji', 'vs15']],
  ['⭐︎', 'BSLato', ['emoji', 'vs15']],
  ['\u2205\uFE00', 'BSLato', ['system-fallback']],
  ['\uE000', '"g_d0_f1", sans-serif', ['pua']],
  ['\uFFFE', '"g_d0_f1", sans-serif', ['pua']],
  ['\u{100000}', '"g_d0_f2", serif', ['pua']],
  // More than 100 system fallback faces in one line (HbFont lifetime): one
  // letter of each script below.
  [FACES, 'BSLato', ['script', 'system-fallback', 'faces100']],
]

// S4: letter and word spacing on the texts they change: multi-glyph
// clusters, cursive scripts, zero width characters, runs of spaces, NBSP,
// U+2002, U+3000, the separators, negative and tiny values. ("liga" with a
// letter spacing makes a ligature of two clusters, which broken() rejects:
// font-features-chrome.spec.ts pins it; and spacing that puts a glyph more
// than a font size left of the text is pinned by blink-shaper-chrome.spec.ts
// and text-bbox-chrome.spec.ts.) [text, font families, settings, tags]
const SPACED = [
  ['q\u0301x', 'BSSerif', { letterSpacing: '8px' }, ['ls-cluster', 'script']],
  ['q\u0301\u0308x', 'BSSerif', { letterSpacing: '8px' }, ['ls-cluster', 'script']],
  ['q\u0301x', 'BSGar', { letterSpacing: '8px' }, ['ls-cluster', 'script']],
  ['कि नमस्ते र्क', 'BSDeva', { letterSpacing: '8px' }, ['ls-cluster', 'script']],
  ['fi ffi office', 'BSSerif', { letterSpacing: '8px' }, ['ls-cluster']],
  ['سلام عليكم', 'BSHarm', { letterSpacing: '8px' }, ['ls-cluster', 'script', 'bidi']],
  ['ߒߞߏ ߞߊ߲', 'BSNKo', { letterSpacing: '8px' }, ['ls-cluster', 'script']],
  ['ᠮᠣᠩᠭᠣᠯ', 'BSMong', { letterSpacing: '8px' }, ['ls-cluster', 'script']],
  ['ab\u00adcd a\u200bb a\u200db', 'BSLato', { letterSpacing: '8px' }, ['ls-cluster', 'zw']],
  ['שָׁלוֹם', 'BSLato', { letterSpacing: '8px' }, ['ls-cluster', 'system-fallback']],
  ['a☺️b', 'BSLato', { letterSpacing: '8px' }, ['ls-cluster', 'emoji', 'vs16']],
  ['a🐈\u200d🍕b', 'BSLato', { letterSpacing: '8px' }, ['ls-cluster', 'emoji', 'vs16']],
  ['  ab', 'BSLato', { wordSpacing: '10px' }, ['ws-rule']],
  ['ab  ', 'BSLato', { wordSpacing: '10px' }, ['ws-rule']],
  ['a   b', 'BSLato', { wordSpacing: '10px' }, ['ws-rule']],
  ['   ', 'BSLato', { wordSpacing: '10px' }, ['ws-rule']],
  ['   ', 'BSSerif', { wordSpacing: '10px' }, ['ws-rule']],
  ['a\u00a0b \u00a0ab ab\u00a0', 'BSLato', { wordSpacing: '10px' }, ['ws-rule']],
  ['\u00a0ab', 'BSLato', { wordSpacing: '10px' }, ['ws-rule']],
  ['a\u2002b', 'BSLato', { wordSpacing: '10px' }, ['ws-rule']],
  ['一\u3000一', 'BSHan', { wordSpacing: '10px' }, ['ws-rule', 'script']],
  ['a\u2028b c\u2029d', 'BSLato', { wordSpacing: '10px', letterSpacing: '10px' }, ['ws-rule', 'separator', 'bidi']],
  ['بسم الله ', 'BSHarm', { wordSpacing: '10px' }, ['ws-rule', 'script', 'bidi']],
  [' a  b ', 'BSLato', { letterSpacing: '3px', wordSpacing: '7px' }, ['ws-rule', 'ls-cluster']],
  ['abc', 'BSLato', { letterSpacing: '-40px' }, ['negative-spacing']],
  ['a b', 'BSLato', { wordSpacing: '-60px' }, ['negative-spacing']],
  ['a b', 'BSLato', { letterSpacing: '-10px', wordSpacing: '-10px' }, ['negative-spacing']],
  ['Hello world', 'BSLato', { letterSpacing: '-8px' }, ['negative-spacing']],
  ['   ', 'BSLato', { wordSpacing: '-5px' }, ['negative-spacing', 'ws-rule']],
  ['abcdefghij', 'BSLato', { letterSpacing: '0.0002px' }, ['ls-quantize']],
  ['abcdefghij', 'BSLato', { letterSpacing: '0.00001px' }, ['ls-quantize']],
  ['Hello world', 'BSLato', { letterSpacing: '1.3333px', wordSpacing: '0.7px' }, ['ls-quantize']],
  // The trailing space takes word spacing too.
  ['Hamburgefonstiv '.repeat(40), 'BSLato', { letterSpacing: '1px', wordSpacing: '2px' }, ['long', 'ws-rule']],
]

// S5: font-variant-caps per font. Lato and Oswald have no caps features
// (synthesized small caps), Source Serif has smcp and c2sc, Roboto Mono
// smcp only, Science Gothic smcp and c2sc but no Greek. Each value on a
// font with and without the features, a fallback font with and without
// them, mixed case, Turkish, Azeri and Greek case mapping, sharp s, marks
// (also marks alone), letter spacing and RTL. [text, font families,
// settings, tags]
const CAPS_VALUES = ['small-caps', 'all-small-caps', 'petite-caps', 'all-petite-caps', 'unicase', 'titling-caps']
const CAPS = [
  ...CAPS_VALUES.flatMap((caps) => [
    ['Hello World ß fi 123 Éé', 'BSLato', { fontVariantCaps: caps }, []],
    ['Hello World ß fi 123 Éé', 'BSSerif', { fontVariantCaps: caps }, []],
    ['Hello World ß fi 123 Éé', 'BSMono', { fontVariantCaps: caps }, []],
    ['aBcDeF GhIj', 'BSOswald', { fontVariantCaps: caps }, []],
    // The fallback font has the caps features the primary lacks, and the
    // other way round.
    [
      'Hello αβγ q\u0301x',
      'BSLato, BSSerif',
      { fontVariantCaps: caps },
      ['script', 'family-fallback', 'caps-per-font'],
    ],
    ['Hello αβγ Ωμέγα', 'BSGothic, BSHan', { fontVariantCaps: caps }, ['script', 'family-fallback', 'caps-per-font']],
    ['Hello 水 world', 'BSLato, BSHan', { fontVariantCaps: caps }, ['script', 'family-fallback']],
    ['İstanbul ılık iI', 'BSOswald', { fontVariantCaps: caps, lang: 'tr' }, []],
  ]),
  ['Iiİı', 'BSOswald', { fontVariantCaps: 'all-small-caps', lang: 'az' }, []],
  ['Iiİı', 'BSOswald', { fontVariantCaps: 'unicase', lang: 'tr-TR' }, []],
  ['iıIİ fi', 'BSOswald', { fontVariantCaps: 'small-caps', lang: 'en' }, []],
  ['άλφα Ωμέγα', 'BSSerif', { fontVariantCaps: 'all-small-caps', lang: 'el' }, ['script']],
  ['άλφα Ωμέγα', 'BSSerif', { fontVariantCaps: 'all-small-caps', lang: 'en' }, ['script']],
  [
    'άλφα Ωμέγα',
    'BSLato, BSSerif',
    { fontVariantCaps: 'small-caps', lang: 'el' },
    ['script', 'family-fallback', 'caps-per-font'],
  ],
  ['office', 'BSLato', { fontVariantCaps: 'small-caps', lang: 'el' }, []],
  ['Straße STRASSE', 'BSOswald', { fontVariantCaps: 'small-caps', lang: 'de' }, []],
  ['Straße', 'BSSerif', { fontVariantCaps: 'all-small-caps' }, []],
  ['éàB Ab', 'BSOswald', { fontVariantCaps: 'small-caps' }, []],
  ['q\u0301x Q\u0301X', 'BSSerif', { fontVariantCaps: 'small-caps' }, ['script']],
  ['q\u0301x Q\u0301X', 'BSGar', { fontVariantCaps: 'all-small-caps' }, ['script']],
  ['\u0301\u0308', 'BSOswald', { fontVariantCaps: 'all-small-caps' }, ['script', 'caps-marks']],
  // RTL base: the words are placed in reverse for the marks' y offsets.
  ['a \u0301\u0308b', 'BSOswald', { fontVariantCaps: 'small-caps' }, ['script', 'rtl-yoffset']],
  ['Hello World', 'BSLato', { fontVariantCaps: 'small-caps', letterSpacing: '5px' }, ['ls-cluster']],
  ['Hello World', 'BSLato', { fontVariantCaps: 'all-small-caps', wordSpacing: '7px' }, ['ws-rule']],
  ['abc سلام def', 'BSHarm, BSLato', { fontVariantCaps: 'small-caps' }, ['script', 'bidi', 'family-fallback']],
  ['ab中cd Ef', 'BSLato, BSHan', { fontVariantCaps: 'small-caps' }, ['script', 'family-fallback']],
  ['Hello World', 'BSLato', { fontVariantCaps: 'small-caps', fontFeatureSettings: '"smcp" 0' }, []],
  ['Hello World', 'BSSerif', { fontVariantCaps: 'small-caps', fontFeatureSettings: '"smcp" 0' }, []],
  ['AVATAR Hello', 'BSLato', { fontVariantCaps: 'small-caps', fontKerning: 'none' }, []],
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
  [{ letterSpacing: '2px' }, []],
  [{ wordSpacing: '3px' }, []],
  [{ fontVariantCaps: 'small-caps' }, []],
  [{ fontSizeAdjust: '0.5' }, []],
]
const SETTING_TEXTS = [
  'Hello world',
  'AVATAR Ta To We',
  'office affine fi fl ffi',
  'سلام',
  '水 water',
  'İstanbul ılık şğü',
  '这们',
]

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
      // paint_y = y + baseline_y: small fractional y, top and alphabetic.
      if (text.length <= 20) {
        for (const [y, baseline] of [
          [0.3, 'top'],
          [0.5, 'top'],
          [40.3, 'alphabetic'],
        ]) {
          out.push({ renderer, text, font: `40px ${families}`, ctx: {}, tags, draw: true, y, baseline })
        }
      }
    }
    for (const [text, families, settings, tags] of SPACED) {
      for (const direction of ['ltr', 'rtl']) {
        out.push({ renderer, text, font: `40px ${families}`, ctx: { ...settings, direction }, tags, draw: false })
      }
      if (text.length <= 60) {
        out.push({ renderer, text, font: `40px ${families}`, ctx: settings, tags, draw: true })
      }
    }
    for (const [text, families, settings, tags] of CAPS) {
      for (const direction of ['ltr', 'rtl']) {
        out.push({ renderer, text, font: `40px ${families}`, ctx: { ...settings, direction }, tags, draw: false })
      }
      out.push({ renderer, text, font: `30px ${families}`, ctx: settings, tags, draw: true })
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
// registered fonts, no caps or font-size-adjust, and every character in a
// family (no fallback tag). Letter and word spacing are laid out since S4,
// font-variant-caps since S5.
function mustAccept(c) {
  const blocked = ['fontSizeAdjust']
  if (blocked.some((p) => p in c.ctx)) {
    return false
  }
  // S3: with the system renderer on macOS, a character no family has (and
  // a private use one) is laid out by the shaper.
  const fallback = ['system-fallback', 'vs16', 'vs15', 'pua']
  if (process.platform === 'darwin' && c.renderer === 'system' && c.tags.some((t) => fallback.includes(t))) {
    return !c.font.includes('NoSuchFamily')
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
      draw.textBaseline = c.baseline ?? 'top'
      draw.fillText(c.text, 20, c.y ?? 10.3)
      const data = draw.getImageData(0, 0, w, 80).data
      row.pixels = createHash('sha1').update(data).digest('hex')
      row.inked = data.some((v, i) => i % 4 === 3 && v !== 0)
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

// Lost or misplaced text rather than a changed sum: fails whatever the
// case's tags.
function broken(c, a, b) {
  if (!b.metrics.every(Number.isFinite)) {
    return 'non-finite metrics'
  }
  // Every grapheme that starts a cluster of the old path still starts one.
  // A cluster that starts inside a grapheme (a mark) may merge into its base.
  const bytes = Buffer.from(c.text, 'utf8')
  const clusters = (row) =>
    new Set(
      JSON.parse(row.dump).runs.flatMap((run) =>
        run.clusters.filter((cluster) => !/\s/.test(String.fromCharCode(bytes[cluster]))),
      ),
    )
  const graphemes = new Set(
    [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(c.text)].map((g) =>
      Buffer.byteLength(c.text.slice(0, g.index), 'utf8'),
    ),
  )
  const kept = clusters(b)
  const lost = [...clusters(a)].filter((cluster) => graphemes.has(cluster) && !kept.has(cluster))
  if (lost.length) {
    return `no glyph for the clusters at bytes ${lost.slice(0, 5).join(',')}`
  }
  // Every glyph stays on the line, with a margin of one font size.
  const size = parseFloat(c.font.match(/([\d.]+)px/)[1])
  const width = Math.abs(b.metrics[0])
  const off = JSON.parse(b.dump).runs.some(
    (run) => run.x.some((x) => x < -size || x > width + size) || run.y.some((y) => Math.abs(y) > 2 * size),
  )
  if (off) {
    return 'a glyph off the line'
  }
  const glyphs = (row) => JSON.parse(row.dump).runs.reduce((n, run) => n + run.glyphs.length, 0)
  if (glyphs(a) && !glyphs(b)) {
    return 'no glyphs'
  }
  const ink = (m) => m.slice(1, 5).some((v) => v !== 0)
  if (ink(a.metrics) && !ink(b.metrics)) {
    return 'no ink bounds'
  }
  if (a.inked && !b.inked) {
    return 'blank drawing'
  }
  return false
}

// The largest move of a glyph that is not white space, between two dumps
// that draw the same such glyphs (font, glyph and cluster) in the same
// order; Infinity when they do not.
function moved(text, oldDump, newDump) {
  const bytes = Buffer.from(text, 'utf8')
  const ink = (dump) =>
    JSON.parse(dump).runs.flatMap((run) =>
      run.glyphs.flatMap((glyph, i) =>
        /\s/.test(String.fromCharCode(bytes[run.clusters[i]]))
          ? []
          : [{ key: `${run.family}/${run.size}/${glyph}/${run.clusters[i]}`, x: run.x[i], y: run.y[i] }],
      ),
    )
  const a = ink(oldDump)
  const b = ink(newDump)
  if (a.length !== b.length || a.some((g, i) => g.key !== b[i].key)) {
    return Infinity
  }
  return Math.max(0, ...a.map((g, i) => Math.max(Math.abs(g.x - b[i].x), Math.abs(g.y - b[i].y))))
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
    const at = c.y === undefined ? '' : ` y ${c.y} ${c.baseline}`
    const label = `#${c.id} ${c.renderer} ${c.font} ${JSON.stringify(c.ctx)}${at} ${JSON.stringify(c.text.slice(0, 40))}`
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
    const lost = broken(c, a, b)
    if (lost) {
      failures.push(`${label}: ${lost}; ${diffs.join('; ')}`)
      continue
    }
    // 'long' and 'trailing-space' allow only what they are about, also when
    // the case names them: the same glyphs and clusters but the spaces'
    // (drawn as Chrome draws them), and for a long line (past 256 px
    // skparagraph's float sums lose bits that 16.16 keeps) the same runs
    // with rounding-sized moves of the metrics and of every glyph.
    const tags = c.tags.filter((t) => t !== 'long')
    const width = Math.abs(a.metrics[0])
    const shift = Math.max(...a.metrics.map((v, i) => Math.abs(v - b.metrics[i])))
    if (/\s$/.test(c.text) && sameInk(c.text, a.dump, b.dump) && !shift && a.pixels === b.pixels) {
      tags.push('trailing-space')
    }
    if (width > 256 && Math.max(shift, moved(c.text, a.dump, b.dump)) <= 1e-5 * width) {
      tags.push('long')
    }
    // The runs but their clusters, and how far their glyphs moved.
    const runs = (row) => JSON.parse(row.dump).runs
    const unclustered = (row) => JSON.stringify(runs(row).map(({ clusters: _clusters, x, ...run }) => [run, x.length]))
    const xs = (row) => runs(row).flatMap((run) => run.x)
    const rounding = width > 256 ? 1e-5 * width : 0
    if (
      'fontVariantCaps' in c.ctx &&
      a.pixels === b.pixels &&
      unclustered(a) === unclustered(b) &&
      Math.max(shift, ...xs(a).map((x, i) => Math.abs(x - xs(b)[i]))) <= rounding
    ) {
      tags.push('caps-clusters')
    }
    const why = tags.filter((t) => ALLOWED.has(t))
    ;(why.length ? allowed : failures).push(`${label} [${tags.join(',')}]: ${diffs.join('; ')}`)
  }
  return { cases: all.length, identical, accepted, allowed, failures }
}

// Breaks one row of the new path's output in each way the comparator must
// catch, also in a case whose tags allow a difference. Returns the breaks
// that compared without a failure.
function selfTest(oldFile, newFile, file, limit) {
  const all = cases().slice(0, limit)
  const find = (text, tag) => all.find((c) => c.text === text || (tag && c.tags.includes(tag) && c.draw))
  const han = find('漢字')
  const long = find(null, 'long')
  const breaks = {
    'a deleted glyph': [han, (run) => ['x', 'y', 'glyphs', 'clusters'].forEach((k) => run[k].shift())],
    'a glyph moved 1e6 px': [han, (run) => (run.x[0] += 1e6)],
    'no glyphs and zero metrics': [
      han,
      (run, row) => {
        row.metrics = row.metrics.map(() => 0)
        ;['x', 'y', 'glyphs', 'clusters'].forEach((k) => (run[k] = []))
      },
    ],
    'a word glyph moved 5 px on a long line': [long, (run) => (run.x[0] += 5)],
  }
  const rows = readFileSync(newFile, 'utf8').trim().split('\n')
  const missed = []
  for (const [name, [c, change]] of Object.entries(breaks)) {
    if (!c) {
      continue
    }
    const broke = rows.map((line) => {
      const row = JSON.parse(line)
      if (row.id !== c.id) {
        return line
      }
      const dump = JSON.parse(row.dump)
      change(
        dump.runs.find((run) => run.glyphs.length),
        row,
      )
      row.dump = JSON.stringify(dump)
      return JSON.stringify(row)
    })
    writeFileSync(file, broke.join('\n') + '\n')
    if (!compare(oldFile, file, limit).failures.some((f) => f.startsWith(`#${c.id} `))) {
      missed.push(`${name} (#${c.id})`)
    }
  }
  return missed
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
  const missed = selfTest(files.skparagraph, files.blink, join(out, 'self-test.jsonl'), limit)
  for (const name of missed) {
    console.log(`FAIL self-test: the comparator passes ${name}`)
  }
  process.exit(result.failures.length || missed.length ? 1 : 0)
}
