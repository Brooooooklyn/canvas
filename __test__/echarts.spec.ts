import test from 'ava'
import { init, setPlatformAPI } from 'echarts'

import { createCanvas } from '../index.js'
import { snapshotImage } from './image-snapshot'

test('echarts-start', async (t) => {
  if (process.platform !== 'darwin') {
    t.pass()
    return
  }
  const canvas = createCanvas(800, 600)
  setPlatformAPI({
    // @ts-expect-error
    createCanvas: () => canvas,
  })
  // @ts-expect-error
  const chart = init(canvas)
  chart.setOption({
    title: {
      text: 'ECharts 入门示例',
    },
    tooltip: {},
    legend: {
      data: ['销量'],
    },
    xAxis: {
      data: ['衬衫', '羊毛衫', '雪纺衫', '裤子', '高跟鞋', '袜子'],
    },
    yAxis: {},
    series: [
      {
        name: '销量',
        type: 'bar',
        data: [5, 20, 36, 10, 10, 20],
      },
    ],
  })

  await snapshotImage(t, { canvas, ctx: canvas.getContext('2d') })
})
