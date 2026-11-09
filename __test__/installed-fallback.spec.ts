// A character no family of the font list has is taken from an installed
// font (loadSystemFonts, loadFontsFromDir), as Chrome's font cache takes it
// from the platform's fonts: on the portable renderer on every OS, and with
// the system renderer off Apple or where CoreText gives none. A FontFace
// (register / registerFromPath) is never a fallback font (Chrome 157: an
// unnamed FontFace with the character is not used,
// followups2/portable-loaded-fallback/chrome.json).
//
// Each case runs in a child process with DISABLE_SYSTEM_FONTS_LOAD, so the
// only installed fonts are the ones a temp dir gives loadFontsFromDir. A host
// whose font manager still finds a font with the character (macOS portable
// reads /System/Library/Fonts; a Linux desktop's /usr/share/fonts) is not
// "bare": there only "a real glyph, not .notdef" is checked.
import { spawnSync } from 'node:child_process'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

const __dirname = dirname(fileURLToPath(import.meta.url))

type Box = [number, number, number, number, number]

const PROBE = `
const fs = require('fs'), os = require('os'), path = require('path')
const { createCanvas, GlobalFonts, setTextRenderer } = require('./index.js')
if (process.env.RENDERER === 'system') setTextRenderer('system')
const F = path.join('__test__', 'fonts')
const m = (font, text, lang) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  if (lang) ctx.lang = lang
  ctx.font = font
  const t = ctx.measureText(text)
  return [t.width, t.actualBoundingBoxLeft, t.actualBoundingBoxRight, t.actualBoundingBoxAscent, t.actualBoundingBoxDescent]
}
const dirOf = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-fallback-'))
  for (const file of files) fs.copyFileSync(path.join(F, file), path.join(dir, file))
  return dir
}
GlobalFonts.registerFromPath(path.join(F, 'Lato-Regular.ttf'), 'MyLatoOnly')
const out = {
  notdef: m('700 32px MyLatoOnly', '\\uE000'),
  before: m('700 32px MyLatoOnly', '中'),
  before水: m('400 32px MyLatoOnly', '水'),
}
const SHS = 'SourceHanSerifCN-Bold.ttf'
const NOTO = 'NotoSansCJKjp-Regular-subset-halt.otf'
const HY = 'HYXiXingKaiW.ttf'
switch (process.env.CASE) {
  case 'A': {
    const dir = dirOf([SHS])
    GlobalFonts.loadFontsFromDir(dir)
    out.l700 = m('700 32px MyLatoOnly', '中')
    out.s700 = m('700 32px "Source Han Serif CN"', '中')
    out.lAHan = m('700 32px MyLatoOnly', 'A中')[0]
    out.lA = m('700 32px MyLatoOnly', 'A')[0]
    out.l400 = m('400 32px MyLatoOnly', '中')
    out.s400 = m('400 32px "Source Han Serif CN"', '中')
    out.pua = m('700 32px MyLatoOnly', '\\uE000')
    // A FontFace name for the same file (S18's web twin) is not a fallback
    // font: the installed face stays the one taken.
    GlobalFonts.registerFromPath(path.join(dir, SHS), 'SHSWeb')
    out.twin = m('700 32px MyLatoOnly', '中')
    // removeAll drops the installed faces with the index.
    GlobalFonts.removeAll()
    GlobalFonts.registerFromPath(path.join(F, 'Lato-Regular.ttf'), 'MyLatoOnly')
    out.removed = m('700 32px MyLatoOnly', '中')
    fs.rmSync(dir, { recursive: true, force: true })
    break
  }
  case 'C': {
    GlobalFonts.registerFromPath(path.join(F, SHS), 'SHSWeb')
    out.c = m('700 32px MyLatoOnly', '中')
    out.web = m('700 32px SHSWeb', '中')
    break
  }
  case 'D': {
    const dir = dirOf([NOTO])
    GlobalFonts.loadFontsFromDir(dir)
    out.d = m('700 32px MyLatoOnly', '水')
    out.n700 = m('700 32px "Noto Sans CJK JP"', '水')
    out.n400 = m('400 32px "Noto Sans CJK JP"', '水')
    fs.rmSync(dir, { recursive: true, force: true })
    break
  }
  case 'E': {
    const dir = dirOf([HY, SHS, NOTO])
    GlobalFonts.loadFontsFromDir(dir)
    out.e = m('400 32px MyLatoOnly', '水')
    out.hy = m('400 32px HYXiXingKaiW', '水')
    out.ja = m('400 32px MyLatoOnly', '水', 'ja')
    out.noto = m('400 32px "Noto Sans CJK JP"', '水', 'ja')
    fs.rmSync(dir, { recursive: true, force: true })
    break
  }
  case 'W': {
    // A WOFF2 file: its characters are read through the typeface's tables
    // (HarfBuzz reads no WOFF2 data).
    out.wBefore = m('400 32px MyLatoOnly', '\u2500')
    const dir = dirOf(['Cascadia.woff2'])
    GlobalFonts.loadFontsFromDir(dir)
    out.w = m('400 32px MyLatoOnly', '\u2500')
    out.cascadia = m('400 32px "Cascadia Code"', '\u2500')
    fs.rmSync(dir, { recursive: true, force: true })
    break
  }
  case 'mac': {
    const ctx = createCanvas(10, 10).getContext('2d')
    ctx.font = '700 32px MyLatoOnly'
    out.family = JSON.parse(ctx.__debugTextLine('中')).runs[0].family
    out.l700 = m('700 32px MyLatoOnly', '中')
    out.named700 = m('700 32px "' + out.family + '"', '中')
    out.l400 = m('400 32px MyLatoOnly', '中')
    out.named400 = m('400 32px "' + out.family + '"', '中')
    out.lAHan = m('700 32px MyLatoOnly', 'A中')[0]
    break
  }
}
console.log(JSON.stringify(out))
`

function run(renderer: string, testCase: string, env: Record<string, string> = { DISABLE_SYSTEM_FONTS_LOAD: '1' }) {
  const { stdout, stderr, status } = spawnSync(process.execPath, ['-e', PROBE], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, ...env, RENDERER: renderer, CASE: testCase },
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (status !== 0) throw new Error(stderr)
  return JSON.parse(stdout) as Record<string, Box & number>
}

// No installed font has 中 before the dir is loaded: it draws Lato's
// .notdef, as the private use character does.
const bare = (out: Record<string, Box>) => JSON.stringify(out.before) === JSON.stringify(out.notdef)

for (const renderer of ['portable', 'system']) {
  test(`${renderer}: a character the list lacks comes from a font loadFontsFromDir loaded`, (t) => {
    const out = run(renderer, 'A')
    t.notDeepEqual(out.l700, out.notdef)
    t.true(Math.abs(out.l700[0] - 32) < 0.01, String(out.l700[0]))
    // Private use characters never fall back.
    t.deepEqual(out.pua, out.notdef)
    if (!bare(out)) {
      t.pass('the host has a font with 中')
      return
    }
    // The only installed CJK face: its box, bold (the face is bold).
    t.deepEqual(out.l700, out.s700)
    t.true(Math.abs(out.lAHan - (out.lA + 32)) < 1e-3)
    // 400: the bold face as it is, no synthesis either way.
    t.deepEqual(out.l400, out.s400)
    t.deepEqual(out.twin, out.l700)
    t.deepEqual(out.removed, out.before)
  })

  test(`${renderer}: a FontFace is never a fallback font`, (t) => {
    const out = run(renderer, 'C')
    t.is(out.web[0], 32)
    if (!bare(out)) {
      t.pass('the host has a font with 中')
      return
    }
    t.deepEqual(out.c, out.before)
  })

  test(`${renderer}: a regular installed face is made bold for bold text`, (t) => {
    const out = run(renderer, 'D')
    t.notDeepEqual(out.d, out.notdef)
    if (!bare(out)) {
      t.pass('the host has a font with 中')
      return
    }
    t.deepEqual(out.d, out.n700)
    t.notDeepEqual(out.d, out.n400)
  })

  test(`${renderer}: the scan goes by family name, and Han follows the language`, (t) => {
    const out = run(renderer, 'E')
    if (!bare(out)) {
      t.pass('the host has a font with 中')
      return
    }
    // No Han list name is installed: the first family by name, HYXiXingKaiW.
    t.deepEqual(out.e, out.hy)
    // lang ja: Windows' Japanese list names Noto Sans CJK JP.
    t.deepEqual(out.ja, out.noto)
    t.notDeepEqual(out.e, out.noto)
  })

  test(`${renderer}: a WOFF2 file loadFontsFromDir loaded is a fallback font`, (t) => {
    const out = run(renderer, 'W')
    t.notDeepEqual(out.w, out.notdef)
    if (JSON.stringify(out.wBefore) !== JSON.stringify(out.notdef)) {
      t.pass('the host has a font with U+2500')
      return
    }
    t.deepEqual(out.w, out.cascadia)
  })
}

// macOS 27 (the Chrome 157 capture's host), the installed fonts on.
const MEASURED_MACOS = process.platform === 'darwin' && Number.parseInt(release(), 10) === 27
const macTest = MEASURED_MACOS ? test : test.skip

// Portable: the font Chrome mac's CoreText cascade picks for Han, by name
// (Chrome 157: PingFang SC). PingFang is a MobileAsset font that
// loadSystemFonts does not read, so Hiragino Sans GB, the next Simplified
// Chinese font of the cascade, is taken where PingFang is not installed.
macTest('portable on macOS: Han comes from the font Chrome mac picks', (t) => {
  const out = run('portable', 'mac', {}) as unknown as Record<string, Box> & { family: string }
  t.true(['PingFang SC', 'Hiragino Sans GB'].includes(out.family), out.family)
  t.deepEqual(out.l700, out.named700)
  t.deepEqual(out.l400, out.named400)
})

// System renderer: CoreText first, as before (Chrome 157,
// followups2/portable-loaded-fallback/chrome.json).
macTest('system on macOS: CoreText still picks PingFang SC', (t) => {
  const out = run('system', 'mac', {})
  t.deepEqual(out.l700, [32, -2.944000005722046, 29.08799934387207, 26.43199920654297, 3.5840015411376953])
  t.deepEqual(out.l400, [32, -3.359999895095825, 28.672000885009766, 26.27199935913086, 3.424001693725586])
  t.is(out.lAHan, 53.75999450683594)
})
