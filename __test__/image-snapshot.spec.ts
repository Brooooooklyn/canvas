import './use-system-fonts'

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test, { type ExecutionContext } from 'ava'

import { createCanvas } from '../index'
import { snapshotImage, snapshotPath } from './image-snapshot'

const __dirname = dirname(fileURLToPath(import.meta.url))

function square(color: string) {
  const canvas = createCanvas(2, 2)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 2, 2)
  return canvas
}

test('a snapshot under snapshots/<os>/ wins over the shared one', async (t) => {
  const title = '__per-os-snapshot-probe'
  const osDir = join(__dirname, 'snapshots', process.platform)
  const shared = join(__dirname, 'snapshots', `${title}.png`)
  const perOs = join(osDir, `${title}.png`)
  const hadOsDir = existsSync(osDir)
  mkdirSync(osDir, { recursive: true })
  t.teardown(() => {
    rmSync(shared, { force: true })
    rmSync(perOs, { force: true })
    if (!hadOsDir) {
      rmSync(osDir, { recursive: true, force: true })
    }
  })
  writeFileSync(shared, await square('blue').encode('png'))
  writeFileSync(perOs, await square('red').encode('png'))

  t.is(
    snapshotPath(title, 'png', () => true),
    perOs,
  )
  t.is(
    snapshotPath(title, 'png', () => false),
    shared,
  )
  // Only the system font renderer reads snapshots/<os>/.
  t.is(
    snapshotPath(title, 'png', () => true, false),
    shared,
  )
  t.is(
    snapshotPath(title, 'png', () => true, true),
    perOs,
  )
  t.is(
    snapshotPath(title, 'png', () => false, true),
    shared,
  )

  // A red canvas matches the red per-OS snapshot, not the blue shared one.
  const failures: string[] = []
  const probe = {
    title,
    context: { canvas: square('red') },
    pass() {},
    fail(message: string) {
      failures.push(message)
    },
  } as unknown as ExecutionContext<unknown>
  await snapshotImage(probe)
  t.deepEqual(failures, [])
  rmSync(join(__dirname, 'failure', `${title}.system.png`), { force: true })
})
