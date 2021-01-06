import { promises as fs } from 'fs'
import { join } from 'path'

import PNG from '@jimp/png'
import { ExecutionContext } from 'ava'

const png = PNG()

export async function snapshotImage<C>(t: ExecutionContext<C>) {
  // @ts-expect-error
  const { canvas } = t.context
  const image = await canvas.png()
  const p = join(__dirname, 'snapshots', `${t.title}.png`)

  async function writeFailureImage() {
    await fs.writeFile(join(__dirname, 'failure', `${t.title}.png`), image)
  }

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
    t.notThrowsAsync(async () => {
      const existedPixels = png.decoders['image/png'](existed).data
      const imagePixels = png.decoders['image/png'](image).data
      if (existedPixels.length !== imagePixels.length) {
        await writeFailureImage()
        throw new Error('Image size is not equal')
      }
      let diffCount = 0
      imagePixels.forEach((u8, index) => {
        if (u8 !== existedPixels[index]) {
          diffCount++
        }
      })
      // diff ratio greater than 0.01%
      if (diffCount / existedPixels.length > 0.01 / 100) {
        await writeFailureImage()
        throw new Error('Image bytes is not equal')
      }
    })
  }
}
