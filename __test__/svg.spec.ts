import { join } from 'path'
import { readFileSync, promises as fs } from 'fs'
import { platform } from 'os'

import test from 'ava'

import { convertSVGTextToPath, GlobalFonts } from '../index'

GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf'))

const FIXTURE = readFileSync(join(__dirname, 'text.svg'), 'utf8')

test('convertSVGTextToPath should work', async (t) => {
  const result = convertSVGTextToPath(FIXTURE)
  const outputPath = join(__dirname, 'text-to-path.svg')
  const output = await fs.readFile(outputPath, 'utf8')
  if (platform() === 'win32') {
    t.true(result.toString('utf8').length > 13000)
  } else {
    t.deepEqual(result.toString('utf8'), output)
  }
})
