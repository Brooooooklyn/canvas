import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function runInChildProcess(
  script: string,
  nodeArgs: string[] = [],
  timeoutMs = 180_000,
): Promise<{
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, '-e', script], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Child process timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stdout, stderr })
    })
  })
}

// A canvas that is not held alive across the await must still be kept
// native-alive by the async encode task itself (issue #1312).
test('encode() completes when the canvas is not referenced across the await', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(`
const { createCanvas } = require('./index.js')
function kick() {
  const canvas = createCanvas(1024, 1024)
  canvas.getContext('2d').fillRect(0, 0, 1024, 1024)
  return canvas.encode('png')
}
;(async () => {
  for (let round = 1; round <= 5; round += 1) {
    await Promise.all(Array.from({ length: 64 }, () => kick()))
    console.log('Completed round ' + round + '.')
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
`)

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('Completed round 5.'), `unexpected output:\n${stdout}`)
})

test('encode() survives garbage collection of the canvas while the encode is in flight', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const pending = new Set()
const registry = new FinalizationRegistry((held) => pending.delete(held))
let finalizedWhilePending = 0
let total = 0
function kick() {
  const canvas = createCanvas(1024, 1024)
  canvas.getContext('2d').fillRect(0, 0, 1024, 1024)
  const held = {}
  pending.add(held)
  registry.register(canvas, held)
  const promise = canvas.encode('png')
  promise.then(() => {
    if (!pending.has(held)) finalizedWhilePending += 1
    total += 1
  })
  return promise
}
;(async () => {
  for (let round = 1; round <= 5; round += 1) {
    const jobs = Array.from({ length: 8 }, () => kick())
    global.gc()
    await Promise.all(jobs)
    console.log('Round ' + round + ': finalizedWhilePending=' + finalizedWhilePending + ' total=' + total)
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('total=40'), `unexpected output:\n${stdout}`)
})

test('encode() survives a resize that drops the old surface while the encode is in flight', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(`
const { createCanvas } = require('./index.js')
;(async () => {
  for (let index = 0; index < 32; index += 1) {
    const canvas = createCanvas(1024, 1024)
    canvas.getContext('2d').fillRect(0, 0, 1024, 1024)
    const promise = canvas.encode('png')
    canvas.width = 512
    await promise
  }
  console.log('done')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
`)

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('done'), `unexpected output:\n${stdout}`)
})
