// Child process of use-system-font-renderer.spec.ts. It runs the steps given
// as arguments and prints the last probe as JSON:
//
//   register        register the text-raster fonts as Sw*
//   warm            probe and drop the result (fills the caches)
//   switch:<bool>   useSystemFontRenderer(<bool>)
//   probe           probe, then loadSystemFonts()
import { createHash } from 'node:crypto'

import { createCanvas, GlobalFonts, SvgExportFlag, useSystemFontRenderer } from '../index'
import { registerTextFonts, sceneRow, textScenes } from './text-scenes'

const METRICS = [
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
] as const

const FAMILIES = [
  'SwLato',
  'SwSerif',
  'SwIosevka',
  'SwArabic',
  'Helvetica',
  'Arial',
  'Times',
  'system-ui',
  'sans-serif',
  'serif',
  'monospace',
  'NoSuchFamily',
]

const SCENES = [
  'lato-13',
  'stroke-24',
  'shadow-13',
  'opaque-black-on-white-13',
  'tr-geometricPrecision-13',
  'arabic-24',
]

function probe(loadSystemFonts: boolean) {
  const ctx = createCanvas(10, 10).getContext('2d')
  const measure: Record<string, number[]> = {}
  for (const family of FAMILIES) {
    for (const weight of ['', 'bold ']) {
      ctx.font = `${weight}20px ${family}`
      for (const text of ['Hamburgefonstiv', '永和']) {
        const metrics = ctx.measureText(text)
        measure[`${ctx.font}|${text}`] = METRICS.map((field) => metrics[field])
      }
    }
  }
  const scenes = textScenes('Sw')
  const pixels = Object.fromEntries(SCENES.map((name) => [name, sceneRow(scenes[name])]))
  const units: Record<string, string> = {}
  for (const unit of ['ex', 'ch', 'cap', 'ic', 'lh', 'rex']) {
    ctx.font = `10${unit} SwLato`
    units[unit] = ctx.font
  }
  const svg: Record<string, string> = {}
  for (const [name, flag] of [
    ['text', SvgExportFlag.NoPrettyXML],
    ['paths', SvgExportFlag.ConvertTextToPaths],
  ] as const) {
    const canvas = createCanvas(240, 40, flag)
    const svgCtx = canvas.getContext('2d')
    svgCtx.font = '24px SwLato'
    svgCtx.fillText('Hamburgefonstiv', 4, 30)
    svg[name] = createHash('sha1').update(canvas.getContent()).digest('hex')
  }
  const families = () =>
    GlobalFonts.families
      .map(({ family, styles }) => `${family}:${styles.length}`)
      .sort()
      .join('|')
  const out: Record<string, unknown> = { families: families(), measure, pixels, units, svg }
  if (loadSystemFonts) {
    out.loaded = GlobalFonts.loadSystemFonts()
    out.familiesAfterLoad = families()
  }
  return out
}

let result: unknown = null
for (const step of process.argv.slice(2)) {
  if (step === 'register') {
    registerTextFonts('Sw')
  } else if (step === 'warm') {
    probe(false)
  } else if (step.startsWith('switch:')) {
    useSystemFontRenderer(step === 'switch:true')
  } else if (step === 'probe') {
    result = probe(true)
  } else {
    throw new Error(`unknown step ${step}`)
  }
}
console.log(JSON.stringify(result))
