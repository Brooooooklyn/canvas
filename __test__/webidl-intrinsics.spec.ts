// WebIDL conversions use the intrinsics of their realm (Symbol.toPrimitive,
// Symbol.iterator, Proxy), as Chrome does: replacing globalThis.Symbol or
// globalThis.Proxy after the addon is loaded changes no conversion.
// Expected values were measured in Chrome 155 on arm64 macOS (--disable-gpu).
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import test from 'ava'

import { createCanvas } from '../index'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Runs the conversions with the real globals, then with globalThis.Symbol and
// globalThis.Proxy replaced in several ways, and restores them. Plain
// JavaScript: a worker runs its source text too.
function convertWithReplacedGlobals(ctx: any) {
  const RealSymbol = Symbol
  const RealProxy = Proxy
  const tp = RealSymbol.toPrimitive
  const it = RealSymbol.iterator
  const fmt = (f: () => unknown) => {
    try {
      return 'ok ' + JSON.stringify(f())
    } catch (e: any) {
      return `${e.constructor.name}: ${e.message}`
    }
  }
  const convert = () => ({
    lineWidthTP: fmt(() => {
      ctx.lineWidth = 1
      ctx.lineWidth = { [tp]: () => 7, valueOf: () => 2 }
      return ctx.lineWidth
    }),
    fontTP: fmt(() => {
      ctx.font = '12px serif'
      ctx.font = { [tp]: () => '20px serif', toString: () => '30px serif' }
      return ctx.font
    }),
    lineWidthNonCallable: fmt(() => {
      ctx.lineWidth = 1
      let error = null
      try {
        ctx.lineWidth = { [tp]: 5, valueOf: () => 2 }
      } catch (e) {
        error = e
      }
      if (ctx.lineWidth !== 1) throw new Error('lineWidth changed to ' + ctx.lineWidth)
      if (error) throw error
      return ctx.lineWidth
    }),
    dashSet: fmt(() => {
      ctx.setLineDash([])
      ctx.setLineDash(new Set([3, 4]))
      return ctx.getLineDash()
    }),
    dashCustom: fmt(() => {
      ctx.setLineDash([])
      ctx.setLineDash({
        *[it]() {
          yield 5
          yield 6
        },
      })
      return ctx.getLineDash()
    }),
  })
  const g = globalThis as any
  const out: Record<string, any> = { baseline: convert() }
  try {
    const fakeSymbol = { toPrimitive: RealSymbol('fake toPrimitive'), iterator: RealSymbol('fake iterator') }
    g.Symbol = fakeSymbol
    out.symbolReplaced = convert()
    out.symbolReplaced.dashFakeKey = fmt(() => {
      ctx.setLineDash([])
      ctx.setLineDash({
        *[fakeSymbol.iterator]() {
          yield 5
        },
      })
      return ctx.getLineDash()
    })
  } finally {
    g.Symbol = RealSymbol
  }
  try {
    Object.defineProperty(g, 'Symbol', {
      get() {
        throw new Error('Symbol getter')
      },
      configurable: true,
    })
    out.symbolGetterThrows = convert()
  } finally {
    Object.defineProperty(g, 'Symbol', { value: RealSymbol, writable: true, configurable: true })
  }
  let calls = 0
  try {
    g.Proxy = function () {
      calls++
      return { valueOf: () => 7 }
    }
    out.proxyFunction = convert()
    out.proxyFunction.calls = calls
    g.Proxy = 5
    out.proxyNumber = convert()
    Object.defineProperty(g, 'Proxy', {
      get() {
        throw new Error('Proxy getter')
      },
      configurable: true,
    })
    out.proxyGetterThrows = convert()
  } finally {
    Object.defineProperty(g, 'Proxy', { value: RealProxy, writable: true, configurable: true })
  }
  return out
}

// Chrome 155, a CanvasRenderingContext2D.
const unchanged = {
  lineWidthTP: 'ok 7',
  fontTP: 'ok "20px serif"',
  lineWidthNonCallable:
    "TypeError: Failed to set the 'lineWidth' property on 'CanvasRenderingContext2D': '5' returned for property 'Symbol(Symbol.toPrimitive)' of object '#<Object>' is not a function",
  dashSet: 'ok [3,4]',
  dashCustom: 'ok [5,6]',
}
const CHROME = {
  baseline: unchanged,
  symbolReplaced: {
    ...unchanged,
    dashFakeKey:
      "TypeError: Failed to execute 'setLineDash' on 'CanvasRenderingContext2D': The object must have a callable @@iterator property.",
  },
  symbolGetterThrows: unchanged,
  proxyFunction: { ...unchanged, calls: 0 },
  proxyNumber: unchanged,
  proxyGetterThrows: unchanged,
}

test('replacing globalThis.Symbol or globalThis.Proxy changes no conversion', (t) => {
  t.deepEqual(convertWithReplacedGlobals(createCanvas(10, 10).getContext('2d')), CHROME)
})

// Each worker has its own realm, read when the addon is registered in it.
const inWorker = () =>
  new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(
      `
        const { parentPort } = require('node:worker_threads')
        const { createCanvas } = require(${JSON.stringify(join(root, 'index.js'))})
        const convertWithReplacedGlobals = ${convertWithReplacedGlobals.toString()}
        parentPort.postMessage(convertWithReplacedGlobals(createCanvas(10, 10).getContext('2d')))
      `,
      { eval: true },
    )
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', (code) => code !== 0 && reject(new Error(`worker exit ${code}`)))
  })

test('conversions in a worker use the realm of the worker', async (t) => {
  t.deepEqual(await inWorker(), CHROME)
  // A second worker, after the first one is gone, and this thread again.
  t.deepEqual(await inWorker(), CHROME)
  t.deepEqual(convertWithReplacedGlobals(createCanvas(10, 10).getContext('2d')), CHROME)
})
