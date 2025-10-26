import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, promises as fs } from 'node:fs'

import test from 'ava'

import { convertSVGTextToPath, GlobalFonts } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

const FIXTURE = readFileSync(join(__dirname, 'text.svg'), 'utf8')

test.beforeEach((t) => {
  t.true(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf')))
})

test('convertSVGTextToPath should work', async (t) => {
  const result = convertSVGTextToPath(FIXTURE)
  const outputPath = join(__dirname, 'text-to-path.svg')
  const output = await fs.readFile(outputPath, 'utf8')
  if (process.platform === 'win32') {
    t.pass('Skip on windows')
  } else {
    result
      .toString('utf8')
      .split('\n')
      .forEach((line, index) => {
        t.deepEqual(line.trim(), output.split('\n')[index]?.trim())
      })
  }
})
