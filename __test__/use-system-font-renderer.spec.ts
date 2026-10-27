// useSystemFontRenderer() switches a running process between the default font
// renderer (the same text on every OS) and the system one (Chrome's per-OS
// text). A switched process must draw and measure like a process that started
// in that mode. The tests switch this process, so they run one at a time and
// each switches back to the default at the end.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test, { type ExecutionContext } from 'ava'

import { createCanvas, GlobalFonts, Image, useSystemFontRenderer, type SKRSContext2D } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// Where the system renderer draws with another gamma than the default one.
const GAMMA_OS = process.platform === 'darwin' || process.platform === 'linux'
const macTest = process.platform === 'darwin' ? test.serial : test.serial.skip

GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Lato-Regular.ttf'), 'UsLato')
GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf'), 'UsIosevka')

function backToDefault(t: ExecutionContext) {
  t.teardown(() => useSystemFontRenderer(false))
}

function measure(api: { createCanvas: typeof createCanvas } = { createCanvas }) {
  const ctx = api.createCanvas(10, 10).getContext('2d')
  ctx.font = '50px UsIosevka'
  const m = ctx.measureText('@napi-rs/canvas')
  return [
    m.width,
    m.actualBoundingBoxLeft,
    m.actualBoundingBoxRight,
    m.actualBoundingBoxAscent,
    m.actualBoundingBoxDescent,
    m.fontBoundingBoxAscent,
    m.fontBoundingBoxDescent,
  ]
}

function pixels(ctx: SKRSContext2D) {
  return Array.from(ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data)
}

// Gray text on a transparent canvas: the text gamma shows in its edges.
function drawText(canvas: ReturnType<typeof createCanvas>) {
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#888'
  ctx.font = '13px UsLato'
  ctx.fillText('Hamburgefonstiv', 2, 18)
  return pixels(ctx)
}

test.serial('useSystemFontRenderer returns nothing, and the same mode again changes nothing', (t) => {
  backToDefault(t)
  t.is(typeof useSystemFontRenderer, 'function')
  const portable = measure()
  t.is(useSystemFontRenderer(false), undefined)
  t.deepEqual(measure(), portable)
  t.is(useSystemFontRenderer(), undefined)
  const system = measure()
  t.is(useSystemFontRenderer(true), undefined)
  t.deepEqual(measure(), system)
  useSystemFontRenderer(false)
  t.deepEqual(measure(), portable)
})

// __test__/font-renderer-probe.ts in a new process, with the steps it lists.
function probe(steps: string[], env: Record<string, string>) {
  const { stdout, stderr, status } = spawnSync(
    process.execPath,
    [...process.execArgv, join(__dirname, 'font-renderer-probe.ts'), ...steps],
    {
      cwd: join(__dirname, '..'),
      env: { ...process.env, ...env },
      encoding: 'utf8',
    },
  )
  if (status !== 0) throw new Error(stderr)
  return JSON.parse(stdout)
}

for (const [label, env] of [
  ['', {}],
  [' with DISABLE_SYSTEM_FONTS_LOAD', { DISABLE_SYSTEM_FONTS_LOAD: '1' }],
] as const) {
  test.serial(`a process switched after drawing equals one started with the system renderer${label}`, (t) => {
    const fresh = probe(['switch:true', 'register', 'probe'], env)
    const switched = probe(['register', 'warm', 'switch:true', 'probe'], env)
    t.deepEqual(switched, fresh)
  })

  test.serial(`a process switched back equals one that never switched${label}`, (t) => {
    const fresh = probe(['register', 'probe'], env)
    const switched = probe(['switch:true', 'register', 'warm', 'switch:false', 'probe'], env)
    t.deepEqual(switched, fresh)
  })
}

test.serial('a FontKey and a setAlias name survive switching', (t) => {
  backToDefault(t)
  const width = (font: string) => {
    const ctx = createCanvas(10, 10).getContext('2d')
    ctx.font = font
    return ctx.measureText('Hamburgefonstiv').width
  }
  const key = GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf'), 'SwSerif')
  t.truthy(key)
  t.true(GlobalFonts.setAlias('SwSerif', 'SwAlias'))
  const before = width('20px SwAlias')
  t.is(before, width('20px SwSerif'))
  t.true(GlobalFonts.has('SwAlias'))
  useSystemFontRenderer()
  t.true(GlobalFonts.has('SwSerif'))
  t.true(GlobalFonts.has('SwAlias'))
  t.is(width('20px SwAlias'), width('20px SwSerif'))
  useSystemFontRenderer(false)
  t.is(width('20px SwAlias'), before)
  t.true(GlobalFonts.remove(key!))
  t.false(GlobalFonts.has('SwSerif'))
})

test.serial('a canvas made before a switch draws like a new one once its size is set', (t) => {
  backToDefault(t)
  for (const [from, to] of [
    [true, false],
    [false, true],
  ]) {
    useSystemFontRenderer(from)
    const old = createCanvas(160, 24)
    drawText(old)
    useSystemFontRenderer(to)
    const fresh = drawText(createCanvas(160, 24))
    if (from && GAMMA_OS) {
      // The old canvas keeps the system renderer's text gamma.
      t.notDeepEqual(drawText(old), fresh)
    }
    old.width = 160
    t.deepEqual(drawText(old), fresh, `${from} -> ${to}`)
  }
})

test.serial('an SVG image draws its text with the current renderer', async (t) => {
  backToDefault(t)
  const image = new Image()
  await new Promise((resolve, reject) => {
    image.onload = resolve
    image.onerror = reject
    image.src = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="24"><text x="2" y="18" font-family="UsLato" font-size="13">Hamburgefonstiv</text></svg>',
    )
  })
  const draw = () => {
    const ctx = createCanvas(160, 24).getContext('2d')
    ctx.drawImage(image, 0, 0)
    return pixels(ctx)
  }
  const portable = draw()
  t.true(portable.some((value) => value !== 0))
  useSystemFontRenderer()
  if (GAMMA_OS) {
    t.notDeepEqual(draw(), portable)
  }
  useSystemFontRenderer(false)
  t.deepEqual(draw(), portable)
})

// Jest runs index.js again for each test file (module-reload.spec.ts). The
// mode belongs to the native binding, so it stays.
test.serial('loading index.js again keeps the mode', (t) => {
  backToDefault(t)
  const portable = measure()
  useSystemFontRenderer()
  const system = measure()
  for (const file of ['../index.js', '../js-binding.js', '../geometry.js', '../load-image.js', '../node-canvas.js']) {
    delete require.cache[require.resolve(file)]
  }
  const reloaded = require('../index.js') as typeof import('../index')
  t.deepEqual(measure(reloaded), system)
  if (process.platform === 'darwin') {
    // CoreText's descent: 10, FreeType's: 14.
    t.notDeepEqual(system, portable)
  }
  reloaded.useSystemFontRenderer(false)
  t.deepEqual(measure(reloaded), portable)
})

// A new process with HOME at a temp folder whose Library/Fonts holds Lato
// with an upper-case extension. By default the per-user folder is loaded with
// FreeType; the system renderer lists CoreText's fonts instead (CoreText does
// not read HOME, so Lato is not checked there).
const HOME_PROBE = `
const { GlobalFonts, useSystemFontRenderer } = require('./index.js')
const list = () => GlobalFonts.families.map(({ family, styles }) => family + ':' + styles.length).sort()
const out = { first: list() }
useSystemFontRenderer()
out.loaded = GlobalFonts.loadSystemFonts()
out.loadedAgain = GlobalFonts.loadSystemFonts()
out.faces = GlobalFonts.families.reduce((n, family) => n + family.styles.length, 0)
useSystemFontRenderer(false)
out.back = list()
console.log(JSON.stringify(out))
`

macTest('the per-user font folder comes back after a switch on macOS', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'canvas-home-'))
  t.teardown(() => rmSync(home, { recursive: true, force: true }))
  mkdirSync(join(home, 'Library', 'Fonts'), { recursive: true })
  copyFileSync(join(__dirname, 'fonts', 'Lato-Regular.ttf'), join(home, 'Library', 'Fonts', 'UPPER.TTF'))
  const { stdout, stderr, status } = spawnSync(process.execPath, ['-e', HOME_PROBE], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  })
  if (status !== 0) throw new Error(stderr)
  const out = JSON.parse(stdout)
  t.true(out.first.includes('Lato:1'))
  t.true(out.first.some((family: string) => family.startsWith('Helvetica:')))
  // No FreeType face is left among CoreText's.
  t.true(out.loaded > 0)
  t.is(out.loadedAgain, out.loaded)
  t.is(out.faces, out.loaded)
  t.deepEqual(out.back, out.first)
})
