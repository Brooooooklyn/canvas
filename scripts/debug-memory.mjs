import { join } from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout } from 'node:timers/promises'

import { whiteBright, red, green, gray } from 'colorette'
import prettyBytes from 'pretty-bytes'
import { table } from 'table'

import { createCanvas, Path2D, clearAllCache } from '../index.js'

function paint() {
  const require = createRequire(import.meta.url)
  const tiger = require('../example/tiger.json')
  const canvas = createCanvas(6016, 3384)
  const ctx = canvas.getContext('2d')
  for (const pathObject of tiger) {
    const p = new Path2D(pathObject.d)
    ctx.fillStyle = pathObject.fillStyle
    ctx.strokeStyle = pathObject.strokeStyle
    if (pathObject.lineWidth) {
      ctx.lineWidth = parseInt(pathObject.lineWidth, 10)
    }
    ctx.stroke(p)
    ctx.fill(p)
  }
}

const initial = process.memoryUsage()

async function main() {
  for (const [index, _] of Array.from({ length: 100 }).entries()) {
    displayMemoryUsageFromNode(initial)
    await setTimeout(100)
    global?.gc?.()
    await paint()
  }
}

main().then(() => {
  displayMemoryUsageFromNode(initial)
  clearAllCache()
  global?.gc?.()
  setInterval(() => {
    displayMemoryUsageFromNode(initial)
  }, 2000)
})

function displayMemoryUsageFromNode(initialMemoryUsage) {
  const finalMemoryUsage = process.memoryUsage()
  const titles = Object.keys(initialMemoryUsage).map((k) => whiteBright(k))
  const tableData = [titles]
  const diffColumn = []
  for (const [key, value] of Object.entries(initialMemoryUsage)) {
    const diff = finalMemoryUsage[key] - value
    const prettyDiff = prettyBytes(diff, { signed: true })
    if (diff > 0) {
      diffColumn.push(red(prettyDiff))
    } else if (diff < 0) {
      diffColumn.push(green(prettyDiff))
    } else {
      diffColumn.push(gray(prettyDiff))
    }
  }
  tableData.push(diffColumn)
  console.info(table(tableData))
}
