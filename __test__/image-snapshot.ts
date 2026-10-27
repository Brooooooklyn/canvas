import { existsSync, promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { arch } from 'node:os'
import { fileURLToPath } from 'node:url'

import PNG from '@jimp/png'
import JPEG from '@jimp/jpeg'
import { ExecutionContext } from 'ava'

import { getTextRenderer } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

const png = PNG()
const jpeg = JPEG()
const ARCH_NAME = arch()

// With the system font renderer, text is drawn by each OS's own font scaler,
// as in Chrome (CoreText on macOS, Fontations on Linux, FreeType elsewhere), so
// a snapshot under snapshots/<os>/ wins over the shared one in snapshots/.
// Otherwise only the shared one is used.
export function snapshotPath(
  title: string,
  ext: string,
  existing: (p: string) => boolean,
  system = getTextRenderer() === 'system',
) {
  const shared = join(__dirname, 'snapshots', `${title}.${ext}`)
  const os = join(__dirname, 'snapshots', process.platform, `${title}.${ext}`)
  return system && existing(os) ? os : shared
}

export async function snapshotImage<C>(
  t: ExecutionContext<C>,
  context = t.context,
  type: 'png' | 'jpeg' | 'webp' | 'avif' = 'png',
  differentRatio = ARCH_NAME === 'x64' ? 0.015 : t.title.includes('filter') ? 2.5 : 0.3,
) {
  // @ts-expect-error
  const { canvas } = context
  const image = await canvas.encode(type, 100)
  const ext = type === 'jpeg' ? 'jpg' : type
  const p = snapshotPath(t.title, ext, existsSync)

  async function writeFailureImage() {
    // A .system.spec wrapper runs the same titles, so keep its failures apart.
    const name = getTextRenderer() === 'system' ? `${t.title}.system` : t.title
    await fs.writeFile(join(__dirname, 'failure', `${name}.${ext}`), image)
  }

  let existed = true
  try {
    await fs.stat(p)
  } catch {
    existed = false
  }
  if (!existed || process.env.UPDATE_SNAPSHOT) {
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
    const imagePixels: Uint8Array =
      type === 'png' ? png.decoders['image/png'](image).data : jpeg.decoders['image/jpeg'](image).data
    if (existedPixels.length !== imagePixels.length) {
      await writeFailureImage()
      t.fail('Image size is not equal')
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
    }
    t.pass('Image pixels is equal')
  }
}
