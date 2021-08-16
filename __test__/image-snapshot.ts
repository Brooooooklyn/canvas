import { promises as fs } from 'fs'
import { join } from 'path'
import { arch } from 'os'

import PNG from '@jimp/png'
import JPEG from '@jimp/jpeg'
import { ExecutionContext } from 'ava'

const png = PNG()
const jpeg = JPEG()
const ARCH_NAME = arch()

export async function snapshotImage<C>(
  t: ExecutionContext<C>,
  context = t.context,
  type: 'png' | 'jpeg' | 'webp' = 'png',
  differentRatio = ARCH_NAME === 'x64' ? 0.015 : 0.3,
) {
  // @ts-expect-error
  const { canvas } = context
  const image = await canvas.encode(type, 100)
  const ext = type === 'jpeg' ? 'jpg' : type
  const p = join(__dirname, 'snapshots', `${t.title}.${ext}`)

  async function writeFailureImage() {
    await fs.writeFile(join(__dirname, 'failure', `${t.title}.${ext}`), image)
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
    if (type !== 'png' && type !== 'jpeg') {
      t.pass()
      return
    }
    const existedPixels =
      type === 'png' ? png.decoders['image/png'](existed).data : jpeg.decoders['image/jpeg'](existed).data
    const imagePixels = type === 'png' ? png.decoders['image/png'](image).data : jpeg.decoders['image/jpeg'](image).data
    if (existedPixels.length !== imagePixels.length) {
      await writeFailureImage()
      t.fail('Image size is not equal')
      return
    }
    let diffCount = 0
    imagePixels.forEach((u8, index) => {
      if (u8 !== existedPixels[index]) {
        diffCount++
      }
    })
    if (diffCount / existedPixels.length > differentRatio / 100) {
      await writeFailureImage()
      t.fail(`Image bytes is not equal, different ratio is ${((diffCount / existedPixels.length) * 100).toFixed(2)}%`)
      return
    }
    t.pass('Image pixels is equal')
  }
}
