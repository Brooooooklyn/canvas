// The text-raster scenes, shared by text-raster.spec.ts (Chrome's pixels per
// OS, system font renderer) and portable-text.spec.ts (the same pixels on
// every OS, default renderer). Each scene draws with the fonts registered
// under one family prefix (registerTextFonts).
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCanvas, GlobalFonts, type SKRSContext2D } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

// The text-raster fonts, by family name without the prefix.
export const TEXT_FONTS: Record<string, string> = {
  Lato: 'Lato-Regular.ttf',
  Serif: 'SourceSerifPro-Regular.ttf',
  Cff: 'osrs-font-compact.otf',
  RoboMono: 'RobotoMono-VariableFont_wght.ttf',
  Virgil: 'Virgil.woff2',
  Colr: 'COLR-v1.ttf',
  Arabic: 'Harmattan-Regular.ttf',
  Iosevka: 'iosevka-slab-regular.ttf',
}

export function registerTextFonts(prefix: string) {
  for (const [family, file] of Object.entries(TEXT_FONTS)) {
    GlobalFonts.registerFromPath(join(__dirname, 'fonts', file), prefix + family)
  }
}

export const T = 'Hamburgefonstiv 0123'

type Draw = (ctx: SKRSContext2D) => void

export interface Scene {
  width: number
  height: number
  opaque?: boolean
  draw: Draw
}

function white(width: number, height: number): Draw {
  return (ctx) => {
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#000'
  }
}

export function textScenes(prefix: string): Record<string, Scene> {
  return {
    'lato-9': { width: 108, height: 15, draw: (c) => ((c.font = `9px ${prefix}Lato`), c.fillText(T, 2, 10)) },
    'lato-13': { width: 156, height: 21, draw: (c) => ((c.font = `13px ${prefix}Lato`), c.fillText(T, 2, 15)) },
    'lato-24': { width: 288, height: 39, draw: (c) => ((c.font = `24px ${prefix}Lato`), c.fillText(T, 2, 28)) },
    'white-13': {
      width: 160,
      height: 22,
      draw: (c) => {
        c.fillStyle = '#fff'
        c.font = `13px ${prefix}Lato`
        c.fillText(T, 2, 15)
      },
    },
    'subpx-x-0.25': {
      width: 80,
      height: 20,
      draw: (c) => ((c.font = `13px ${prefix}Lato`), c.fillText('illi', 4.25, 15)),
    },
    'subpx-y-0.5': {
      width: 80,
      height: 24,
      draw: (c) => ((c.font = `13px ${prefix}Lato`), c.fillText('Hxe', 4, 15.5)),
    },
    'lato-300': { width: 400, height: 360, draw: (c) => ((c.font = `300px ${prefix}Lato`), c.fillText('Hg', 2, 290)) },
    'fakebold-24': {
      width: 300,
      height: 40,
      draw: (c) => ((c.font = `bold 24px ${prefix}Lato`), c.fillText(T, 2, 28)),
    },
    'stroke-24': {
      width: 300,
      height: 40,
      draw: (c) => {
        c.font = `24px ${prefix}Lato`
        c.lineWidth = 1
        c.strokeText(T, 2, 28)
      },
    },
    'shadow-13': {
      width: 170,
      height: 30,
      draw: (c) => {
        c.font = `13px ${prefix}Lato`
        c.shadowColor = 'rgba(0,0,0,0.8)'
        c.shadowBlur = 2
        c.shadowOffsetX = 2
        c.shadowOffsetY = 2
        c.fillText(T, 2, 15)
      },
    },
    'opaque-black-on-white-13': {
      width: 160,
      height: 22,
      opaque: true,
      draw: (c) => {
        white(160, 22)(c)
        c.font = `13px ${prefix}Lato`
        c.fillText(T, 2, 15)
      },
    },
    'tr-geometricPrecision-13': {
      width: 170,
      height: 22,
      draw: (c) => {
        c.textRendering = 'geometricPrecision'
        c.font = `13px ${prefix}Lato`
        c.fillText(T, 2.3, 15.4)
      },
    },
    'tr-auto-13': {
      width: 170,
      height: 22,
      draw: (c) => {
        c.textRendering = 'auto'
        c.font = `13px ${prefix}Lato`
        c.fillText(T, 2.3, 15.4)
      },
    },
    'gp-white-on-black-13': {
      width: 170,
      height: 22,
      draw: (c) => {
        c.textRendering = 'geometricPrecision'
        c.fillStyle = '#000'
        c.fillRect(0, 0, 170, 22)
        c.fillStyle = '#fff'
        c.font = `13px ${prefix}Lato`
        c.fillText(T, 2, 15)
      },
    },
    'align-right-13': {
      width: 300,
      height: 22,
      draw: (c) => {
        c.textAlign = 'right'
        c.font = `13px ${prefix}Lato`
        c.fillText(T, 150.3, 15)
      },
    },
    'woff2-virgil-24': {
      width: 300,
      height: 40,
      draw: (c) => ((c.font = `24px ${prefix}Virgil`), c.fillText(T, 2, 28)),
    },
    'colrv1-48': { width: 200, height: 70, draw: (c) => ((c.font = `48px ${prefix}Colr`), c.fillText('abc', 2, 55)) },
    'arabic-24': {
      width: 300,
      height: 50,
      draw: (c) => {
        c.font = `24px ${prefix}Arabic`
        c.direction = 'rtl'
        c.fillText('مرحبا بالعالم', 290, 35)
      },
    },
    // geometricPrecision on an alpha:false canvas: Chrome's macOS canvas gets
    // LCD text there, and CoreText draws LCD text hinted.
    'gp-bw-opaque': {
      width: 170,
      height: 22,
      opaque: true,
      draw: (c) => {
        c.textRendering = 'geometricPrecision'
        white(170, 22)(c)
        c.font = `13px ${prefix}Lato`
        c.fillText(T, 2.3, 15.4)
      },
    },
    'gp-bw-transparent': {
      width: 170,
      height: 22,
      draw: (c) => {
        c.textRendering = 'geometricPrecision'
        white(170, 22)(c)
        c.font = `13px ${prefix}Lato`
        c.fillText(T, 2.3, 15.4)
      },
    },
    'auto-bw-opaque': {
      width: 170,
      height: 22,
      opaque: true,
      draw: (c) => {
        white(170, 22)(c)
        c.font = `13px ${prefix}Lato`
        c.fillText(T, 2.3, 15.4)
      },
    },
    'gp-opaque-46': {
      width: 200,
      height: 80,
      opaque: true,
      draw: (c) => {
        white(200, 80)(c)
        c.textRendering = 'geometricPrecision'
        c.font = `46px ${prefix}Lato`
        c.fillText('Hg', 2.3, 60.4)
      },
    },
    'gp-opaque-60': {
      width: 200,
      height: 80,
      opaque: true,
      draw: (c) => {
        white(200, 80)(c)
        c.textRendering = 'geometricPrecision'
        c.font = `60px ${prefix}Lato`
        c.fillText('Hg', 2.3, 60.4)
      },
    },
    'gp-opaque-atop-13': {
      width: 170,
      height: 30,
      opaque: true,
      draw: (c) => {
        white(170, 30)(c)
        c.textRendering = 'geometricPrecision'
        c.globalCompositeOperation = 'source-atop'
        c.font = `13px ${prefix}Lato`
        c.fillText('Hamburgefonstiv', 2.3, 15.4)
      },
    },
    'gp-opaque-scale4-13': {
      width: 200,
      height: 80,
      opaque: true,
      draw: (c) => {
        white(200, 80)(c)
        c.scale(4, 4)
        c.textRendering = 'geometricPrecision'
        c.font = `13px ${prefix}Lato`
        c.fillText('Hg', 0.6, 15.1)
      },
    },
    'gp-opaque-filter-13': {
      width: 170,
      height: 30,
      opaque: true,
      draw: (c) => {
        white(170, 30)(c)
        c.textRendering = 'geometricPrecision'
        c.filter = 'blur(0px)'
        c.font = `13px ${prefix}Lato`
        c.fillText('Hamburgefonstiv', 2.3, 15.4)
      },
    },
    'gp-opaque-shadow-13': {
      width: 170,
      height: 30,
      opaque: true,
      draw: (c) => {
        white(170, 30)(c)
        c.textRendering = 'geometricPrecision'
        c.shadowColor = 'red'
        c.shadowOffsetY = 4
        c.font = `13px ${prefix}Lato`
        c.fillText('Hamburgefonstiv', 2.3, 15.4)
      },
    },
    'gp-opaque-alpha-13': {
      width: 170,
      height: 22,
      opaque: true,
      draw: (c) => {
        white(170, 22)(c)
        c.textRendering = 'geometricPrecision'
        c.globalAlpha = 0.6
        c.font = `13px ${prefix}Lato`
        c.fillText(T, 2.3, 15.4)
      },
    },
    'gp-opaque-rotate-13': {
      width: 170,
      height: 60,
      opaque: true,
      draw: (c) => {
        white(170, 60)(c)
        c.textRendering = 'geometricPrecision'
        c.translate(4, 15)
        c.rotate(0.2)
        c.font = `13px ${prefix}Lato`
        c.fillText('Hamburgefonstiv', 0, 0)
      },
    },
    'gp-opaque-multiply-13': {
      width: 170,
      height: 22,
      opaque: true,
      draw: (c) => {
        white(170, 22)(c)
        c.textRendering = 'geometricPrecision'
        c.globalCompositeOperation = 'multiply'
        c.font = `13px ${prefix}Lato`
        c.fillText(T, 2.3, 15.4)
      },
    },
    // One context draws geometricPrecision, auto, geometricPrecision.
    'tr-leak': {
      width: 170,
      height: 66,
      draw: (c) => {
        c.font = `13px ${prefix}Lato`
        c.textRendering = 'geometricPrecision'
        c.fillText(T, 2.3, 15.4)
        c.textRendering = 'auto'
        c.fillText(T, 2.3, 37.4)
        c.textRendering = 'geometricPrecision'
        c.fillText(T, 2.3, 59.4)
      },
    },
  }
}

// The scene's own canvas, with its own alpha option.
export function drawScene({ width, height, opaque, draw }: Scene) {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d', opaque ? { alpha: false } : undefined)
  draw(ctx)
  return ctx.getImageData(0, 0, width, height)
}

// [sum of alpha, sum of R+G+B, first 16 hex of sha1(RGBA)]
export function sceneRow(scene: Scene): [number, number, string] {
  const { data } = drawScene(scene)
  let alpha = 0
  let rgb = 0
  for (let i = 0; i < data.length; i += 4) {
    alpha += data[i + 3]
    rgb += data[i] + data[i + 1] + data[i + 2]
  }
  const sha = createHash('sha1').update(data).digest('hex').slice(0, 16)
  return [alpha, rgb, sha]
}

// A context set up for a measure key: "<font>|<text>", or
// "textRendering <value>|<font>" for the text T.
export function measureContext(key: string) {
  const ctx = createCanvas(10, 10).getContext('2d')
  let [font, text] = key.split('|')
  if (font.startsWith('textRendering ')) {
    ctx.textRendering = font.slice('textRendering '.length) as CanvasTextRendering
    font = text
    text = T
  }
  ctx.font = font
  return { ctx, text }
}
