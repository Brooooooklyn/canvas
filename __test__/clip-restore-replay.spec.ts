// restore() and a mid-frame pixel read must not change what the clip stack
// paints. Chrome's pixels never depend on a getImageData() in the middle of a
// frame: Blink restores the clip with canvas->restore() and, after a recording
// restart, replays each save level's own clips (canvas_2d_recorder_context.cc
// RestoreMatrixClipStack). Every expected value was measured in Chrome 155 CPU
// canvas (--disable-gpu, getContext('2d', { willReadFrequently: true })) in a
// standards-mode page; Chrome arm64 and x64 give the same values.
import test from 'ava'

import { createCanvas, Path2D } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>
type Read = (() => void) & { flag?: boolean }
type Scene = (ctx: Ctx, read: Read) => void

const W = 48
const H = 48

/** Runs `scene` on a new canvas; `read()` reads one pixel when `doRead`. */
function frame(scene: Scene, doRead: boolean, size = W) {
  const ctx = createCanvas(size, size).getContext('2d')
  const read: Read = () => {
    if (doRead) ctx.getImageData(0, 0, 1, 1)
  }
  read.flag = doRead
  scene(ctx, read)
  return ctx.getImageData(0, 0, size, size).data
}

/** Per-channel sums [R, G, B, A]. */
function sums(data: Uint8ClampedArray) {
  const s = [0, 0, 0, 0]
  for (let i = 0; i < data.length; i++) s[i & 3] += data[i]
  return s
}

function checkScene(t: any, scene: Scene, expected: number[], size = W) {
  const noRead = frame(scene, false, size)
  t.deepEqual(frame(scene, true, size), noRead, 'a mid-frame read changes the result')
  t.deepEqual(sums(noRead), expected)
}

test('clip replay: nested rotated clips are the same with and without a mid-frame read', (t) => {
  checkScene(
    t,
    (ctx, read) => {
      ctx.save()
      ctx.rotate(0.3)
      ctx.beginPath()
      ctx.ellipse(20, 15, 15, 10, 0.4, 0, 7)
      ctx.clip()
      ctx.save()
      ctx.beginPath()
      ctx.ellipse(18, 18, 12, 14, 0.1, 0, 7)
      ctx.clip()
      ctx.fillStyle = 'red'
      ctx.fillRect(-10, -10, 60, 60)
      read()
      ctx.restore()
      ctx.fillStyle = 'blue'
      ctx.fillRect(-10, -10, 60, 60)
      ctx.restore()
    },
    [2664, 0, 126621, 120535],
  )
})

test('clip replay: one clip level', (t) => {
  checkScene(
    t,
    (ctx, read) => {
      ctx.save()
      ctx.beginPath()
      ctx.arc(24, 24, 15, 0, 7)
      ctx.clip()
      ctx.fillStyle = 'red'
      ctx.fillRect(0, 0, W, H)
      read()
      ctx.restore()
      ctx.fillStyle = 'rgba(0,0,255,0.5)'
      ctx.fillRect(0, 0, W, H)
    },
    [90309, 0, 497211, 383992],
  )
})

test('clip replay: root clip, then a nested clip in save()', (t) => {
  checkScene(
    t,
    (ctx, read) => {
      ctx.beginPath()
      ctx.arc(24, 24, 18, 0, 7)
      ctx.clip()
      ctx.save()
      ctx.beginPath()
      ctx.rect(10, 10, 20, 20)
      ctx.clip()
      ctx.fillStyle = 'red'
      ctx.fillRect(0, 0, W, H)
      read()
      ctx.restore()
      ctx.fillStyle = 'blue'
      ctx.fillRect(0, 0, W, H)
    },
    [358, 0, 272492, 259400],
  )
})

test('clip replay: root clip, save() without a clip', (t) => {
  checkScene(
    t,
    (ctx, read) => {
      ctx.beginPath()
      ctx.arc(24, 24, 18, 0, 7)
      ctx.clip()
      ctx.save()
      ctx.fillStyle = 'red'
      ctx.fillRect(0, 0, W, H)
      read()
      ctx.restore()
      ctx.fillStyle = 'rgba(0,0,255,0.5)'
      ctx.fillRect(0, 0, W, H)
    },
    [138154, 0, 134705, 261444],
  )
})

test('clip replay: read between clip() and an empty save()/restore()', (t) => {
  // Before, restore() applied the restored clip a second time, so its
  // anti-aliased edge got darker, with or without the read.
  checkScene(
    t,
    (ctx, read) => {
      ctx.beginPath()
      ctx.arc(24, 24, 18, 0, 7)
      ctx.clip()
      read()
      ctx.save()
      ctx.restore()
      ctx.fillStyle = 'rgba(0,0,255,0.5)'
      ctx.fillRect(0, 0, W, H)
    },
    [0, 0, 272850, 130108],
  )
})

test('clip replay: three nested levels with transforms', (t) => {
  checkScene(
    t,
    (ctx, read) => {
      ctx.translate(24, 24)
      ctx.save()
      ctx.rotate(0.2)
      ctx.beginPath()
      ctx.ellipse(0, 0, 20, 12, 0, 0, 7)
      ctx.clip()
      ctx.save()
      ctx.rotate(0.5)
      ctx.beginPath()
      ctx.ellipse(0, 0, 18, 9, 0, 0, 7)
      ctx.clip()
      ctx.save()
      ctx.scale(1.2, 0.8)
      ctx.beginPath()
      ctx.arc(3, 2, 12, 0, 7)
      ctx.clip()
      ctx.fillStyle = 'red'
      ctx.fillRect(-30, -30, 60, 60)
      read()
      ctx.restore()
      ctx.fillStyle = 'rgba(0,255,0,0.6)'
      ctx.fillRect(-30, -30, 60, 60)
      ctx.restore()
      ctx.fillStyle = 'rgba(0,0,255,0.4)'
      ctx.fillRect(-30, -30, 60, 60)
      ctx.restore()
      ctx.fillStyle = 'rgba(0,0,0,0.3)'
      ctx.fillRect(-30, -30, 60, 60)
    },
    [15948, 32909, 69836, 277686],
  )
})

test('clip replay: two clips on one level', (t) => {
  checkScene(
    t,
    (ctx, read) => {
      ctx.save()
      ctx.beginPath()
      ctx.arc(20, 24, 16, 0, 7)
      ctx.clip()
      ctx.rotate(0.4)
      ctx.beginPath()
      ctx.ellipse(30, 10, 16, 10, 0, 0, 7)
      ctx.clip()
      ctx.fillStyle = 'red'
      ctx.fillRect(-50, -50, 150, 150)
      read()
      ctx.save()
      ctx.fillStyle = 'rgba(0,0,255,0.5)'
      ctx.fillRect(-50, -50, 150, 150)
      ctx.restore()
      ctx.fillStyle = 'rgba(0,255,0,0.5)'
      ctx.fillRect(-50, -50, 150, 150)
      ctx.restore()
      ctx.fillStyle = 'rgba(0,0,0,0.25)'
      ctx.fillRect(0, 0, W, H)
    },
    [24270, 45407, 23460, 238246],
  )
})

test('clip replay: read inside a level, then another clip', (t) => {
  checkScene(
    t,
    (ctx, read) => {
      ctx.save()
      ctx.beginPath()
      ctx.arc(24, 24, 18, 0, 7)
      ctx.clip()
      read()
      ctx.rotate(0.3)
      ctx.beginPath()
      ctx.rect(10, 0, 20, 20)
      ctx.clip()
      ctx.fillStyle = 'red'
      ctx.fillRect(-50, -50, 150, 150)
      ctx.restore()
      ctx.fillStyle = 'rgba(0,0,255,0.5)'
      ctx.fillRect(0, 0, W, H)
    },
    [41049, 0, 546471, 334967],
  )
})

test('clip replay: restore() brings back the transform after a read', (t) => {
  checkScene(
    t,
    (ctx, read) => {
      ctx.translate(5, 5)
      ctx.save()
      ctx.rotate(0.5)
      ctx.beginPath()
      ctx.rect(5, 5, 20, 20)
      ctx.clip()
      ctx.fillStyle = 'red'
      ctx.fillRect(0, 0, 40, 40)
      read()
      ctx.restore()
      ctx.fillStyle = 'rgba(0,0,255,0.5)'
      ctx.fillRect(0, 0, 20, 20)
    },
    [85998, 0, 80262, 130185],
  )
})

test('clip replay: putImageData between nested clips', (t) => {
  // putImageData restarts the recording too.
  checkScene(
    t,
    (ctx, read) => {
      ctx.save()
      ctx.rotate(0.2)
      ctx.beginPath()
      ctx.ellipse(24, 20, 16, 10, 0.3, 0, 7)
      ctx.clip()
      ctx.save()
      ctx.beginPath()
      ctx.arc(24, 24, 12, 0, 7)
      ctx.clip()
      ctx.fillStyle = 'red'
      ctx.fillRect(-10, -10, 70, 70)
      if (read.flag) ctx.putImageData(ctx.createImageData(1, 1), 47, 47)
      ctx.restore()
      ctx.fillStyle = 'blue'
      ctx.fillRect(-10, -10, 70, 70)
      ctx.restore()
    },
    [1731, 0, 136734, 128603],
  )
})

test('clip replay: a read at every level of a four-deep stack', (t) => {
  checkScene(
    t,
    (ctx, read) => {
      for (let i = 0; i < 4; i++) {
        ctx.save()
        ctx.translate(2, 1)
        ctx.rotate(0.15)
        ctx.beginPath()
        ctx.ellipse(22, 20, 20 - i * 3, 14 - i * 2, 0.2 * i, 0, 7)
        ctx.clip()
        ctx.fillStyle = `rgba(${60 * i},${255 - 60 * i},80,0.5)`
        ctx.fillRect(-20, -20, 90, 90)
        read()
      }
      for (let i = 0; i < 4; i++) {
        ctx.restore()
        ctx.fillStyle = 'rgba(0,0,255,0.2)'
        ctx.fillRect(-20, -20, 90, 90)
        read()
      }
    },
    [18587, 79068, 518546, 261162],
  )
})

test('clip replay: nested clipped strokes with reads', (t) => {
  checkScene(
    t,
    (ctx, read) => {
      ctx.fillStyle = '#ffee00'
      ctx.fillRect(0, 0, 64, 64)
      for (let i = 0; i < 4; i++) {
        ctx.save()
        ctx.translate(3, 2)
        ctx.rotate(0.1)
        ctx.beginPath()
        ctx.rect(0, 0, 50 - i * 8, 44 - i * 8)
        ctx.clip()
        ctx.fillStyle = `hsl(${i * 80}, 80%, 50%)`
        ctx.fillRect(-10, -10, 80, 80)
        read()
      }
      for (let i = 0; i < 4; i++) {
        ctx.restore()
        ctx.strokeStyle = `rgba(0, 0, 0, ${0.3 + i * 0.1})`
        ctx.lineWidth = 3
        ctx.strokeRect(4 + i * 6, 4 + i * 6, 30, 30)
        read()
      }
    },
    [694730, 647522, 171124, 1044480],
    64,
  )
})

test('clip replay: evenodd Path2D clip, read, then a second clip on the same level', (t) => {
  checkScene(
    t,
    (ctx, read) => {
      const p = new Path2D()
      p.arc(24, 24, 20, 0, 7)
      p.arc(24, 24, 9, 0, 7)
      ctx.save()
      ctx.clip(p, 'evenodd')
      ctx.fillStyle = 'red'
      ctx.fillRect(0, 0, W, H)
      read()
      ctx.setTransform(1, 0.2, -0.3, 1, 5, 0)
      ctx.beginPath()
      ctx.rect(5, 5, 30, 30)
      ctx.clip()
      ctx.fillStyle = 'rgba(0,255,0,0.5)'
      ctx.fillRect(-20, -20, 90, 90)
      ctx.restore()
      ctx.fillStyle = 'rgba(0,0,255,0.5)'
      ctx.fillRect(0, 0, W, H)
    },
    [90563, 40677, 456263, 423835],
  )
})

test('clip replay: full-canvas clearRect after restoring out of a clip', (t) => {
  checkScene(
    t,
    (ctx, read) => {
      ctx.save()
      ctx.beginPath()
      ctx.arc(24, 24, 10, 0, 7)
      ctx.clip()
      ctx.fillStyle = 'red'
      ctx.fillRect(0, 0, W, H)
      read()
      ctx.restore()
      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = 'rgba(0,0,255,0.5)'
      ctx.beginPath()
      ctx.arc(20, 20, 15, 0, 7)
      ctx.fill()
    },
    [0, 0, 191250, 89768],
  )
})

test('clip replay: reset() drops the saved clips', (t) => {
  checkScene(
    t,
    (ctx, read) => {
      ctx.save()
      ctx.rotate(0.3)
      ctx.beginPath()
      ctx.arc(24, 24, 15, 0, 7)
      ctx.clip()
      ctx.fillRect(0, 0, W, H)
      read()
      ctx.reset()
      ctx.save()
      ctx.beginPath()
      ctx.arc(30, 30, 12, 0, 7)
      ctx.clip()
      ctx.fillStyle = 'green'
      ctx.fillRect(0, 0, W, H)
      read()
      ctx.restore()
      ctx.fillStyle = 'rgba(0,0,255,0.3)'
      ctx.fillRect(0, 0, W, H)
    },
    [0, 41320, 504830, 257776],
  )
})

test('clip replay: drawImage of the canvas itself after a read in a clipped level', (t) => {
  // Chrome x64 rounds one blend step differently (arm64 and x64 differ by 1
  // in three channel sums); each arch matches its own Chrome.
  checkScene(
    t,
    (ctx, read) => {
      ctx.beginPath()
      ctx.arc(24, 24, 20, 0, 7)
      ctx.clip()
      ctx.save()
      ctx.rotate(0.25)
      ctx.beginPath()
      ctx.rect(8, 4, 26, 26)
      ctx.clip()
      ctx.fillStyle = 'red'
      ctx.fillRect(-20, -20, 90, 90)
      read()
      ctx.restore()
      ctx.globalAlpha = 0.5
      ctx.drawImage(ctx.canvas, 6, 6)
      ctx.globalAlpha = 1
      ctx.fillStyle = 'rgba(0,0,255,0.3)'
      ctx.fillRect(0, 0, W, H)
    },
    process.arch === 'x64' ? [147321, 0, 188255, 227315] : [147322, 0, 188254, 227316],
  )
})

test('clip replay: a mid-frame read never changes the result (40 seeded programs)', (t) => {
  const rng = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const program = (seed: number) => {
    const r = rng(seed)
    const ops: any[][] = []
    let depth = 0
    for (let i = 0; i < 40; i++) {
      const k = Math.floor(r() * 10)
      if (k === 0) {
        ops.push(['save'])
        depth++
      } else if (k === 1 && depth > 0) {
        ops.push(['restore'])
        depth--
      } else if (k === 2) ops.push(['rotate', r() * 1.2 - 0.6])
      else if (k === 3) ops.push(['translate', r() * 10 - 5, r() * 10 - 5])
      else if (k === 4) ops.push(['clipEllipse', 10 + r() * 28, 10 + r() * 28, 6 + r() * 16, 6 + r() * 16, r() * 3])
      else if (k === 5) ops.push(['clipRect', r() * 20, r() * 20, 10 + r() * 30, 10 + r() * 30])
      else if (k === 6)
        ops.push(['fill', Math.floor(r() * 255), Math.floor(r() * 255), Math.floor(r() * 255), 0.3 + r() * 0.7])
      else if (k === 7) ops.push(['read'])
      else if (k === 8) ops.push(['scale', 0.8 + r() * 0.4, 0.8 + r() * 0.4])
      else ops.push(['arc', 5 + r() * 38, 5 + r() * 38, 3 + r() * 12, Math.floor(r() * 255)])
    }
    return ops
  }
  const run = (ops: any[][]) => (ctx: Ctx, read: Read) => {
    for (const op of ops) {
      switch (op[0]) {
        case 'save':
          ctx.save()
          break
        case 'restore':
          ctx.restore()
          break
        case 'rotate':
          ctx.rotate(op[1])
          break
        case 'translate':
          ctx.translate(op[1], op[2])
          break
        case 'scale':
          ctx.scale(op[1], op[2])
          break
        case 'clipEllipse':
          ctx.beginPath()
          ctx.ellipse(op[1], op[2], op[3], op[4], op[5], 0, 7)
          ctx.clip()
          break
        case 'clipRect':
          ctx.beginPath()
          ctx.rect(op[1], op[2], op[3], op[4])
          ctx.clip()
          break
        case 'fill':
          ctx.fillStyle = `rgba(${op[1]},${op[2]},${op[3]},${op[4]})`
          ctx.fillRect(-60, -60, 200, 200)
          break
        case 'arc':
          ctx.fillStyle = `rgb(${op[4]},20,200)`
          ctx.beginPath()
          ctx.arc(op[1], op[2], op[3], 0, 7)
          ctx.fill()
          break
        case 'read':
          read()
          break
      }
    }
  }
  const differ = []
  for (let seed = 1; seed <= 40; seed++) {
    const scene = run(program(seed))
    if (!Buffer.from(frame(scene, true)).equals(Buffer.from(frame(scene, false)))) differ.push(seed)
  }
  t.deepEqual(differ, [])
})
