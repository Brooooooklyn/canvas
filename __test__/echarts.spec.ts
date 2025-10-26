import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts } from '../index.js'
import { snapshotImage } from './image-snapshot'

test('echarts-start', async (t) => {
  t.truthy(
    GlobalFonts.registerFromPath(join(fileURLToPath(import.meta.url), '..', 'fonts', 'iosevka-slab-regular.ttf')),
    'Register Iosevka font failed',
  )
  if (process.platform !== 'darwin') {
    t.pass()
    return
  }
  const { init, setPlatformAPI } = await import('echarts')
  const canvas = createCanvas(800, 600)
  setPlatformAPI({
    createCanvas: () => canvas,
  })
  const chart = init(canvas)
  chart.setOption({
    textStyle: {
      fontFamily: 'Iosevka Slab',
    },
    title: {
      text: 'ECharts Demo',
    },
    tooltip: {},
    legend: {
      data: ['Sales'],
    },
    xAxis: {
      data: ['Shirt', 'Sweater', 'Chiffon Shirt', 'Pants', 'High Heels', 'Socks'],
    },
    yAxis: {},
    series: [
      {
        name: 'Sales',
        type: 'bar',
        data: [5, 20, 36, 10, 10, 20],
      },
    ],
  })

  await snapshotImage(t, { canvas, ctx: canvas.getContext('2d') }, 'png', 0.6)
})
