import { promises as fs } from 'fs'
import { join } from 'path'

import { ExecutionContext } from 'ava'

export async function snapshotImage<C>(t: ExecutionContext<C>, ext = 'png') {
  // @ts-expect-error
  const { canvas } = t.context
  const image = await canvas.png()
  const p = join(__dirname, 'snapshots', `${t.title}.${ext}`)
  let existed = true
  try {
    await fs.stat(p)
  } catch {
    existed = false
  }
  if (!existed) {
    await fs.writeFile(p, image)
    t.pass()
  } else {
    const existed = await fs.readFile(p)
    t.deepEqual(image, existed)
  }
}
