import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, promises as fs } from 'node:fs'

import test from 'ava'

import { convertSVGTextToPath, GlobalFonts } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

const FIXTURE = readFileSync(join(__dirname, 'text.svg'), 'utf8')

test.beforeEach((t) => {
  t.truthy(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf')))
})

test('convertSVGTextToPath should work', async (t) => {
  const result = convertSVGTextToPath(FIXTURE)
  const outputPath = join(__dirname, 'text-to-path.svg')
  const output = await fs.readFile(outputPath, 'utf8')
  if (process.platform === 'win32') {
    t.pass('Skip on windows')
  } else if (process.platform === 'darwin') {
    // CoreText draws this font on macOS: its outline points are within 0.05px
    // of FreeType's, which text-to-path.svg holds.
    const trimmed = (svg: string) =>
      svg
        .split('\n')
        .map((line) => line.trim())
        .join('\n')
    t.true(numberDistance(trimmed(result.toString('utf8')), trimmed(output)) <= 0.05)
  } else {
    result
      .toString('utf8')
      .split('\n')
      .forEach((line, index) => {
        t.deepEqual(line.trim(), output.split('\n')[index]?.trim())
      })
  }
})

const NUMBER = /-?\d+(?:\.\d+)?(?:e-?\d+)?/g

// How far apart the numbers of two texts are, or Infinity when the texts
// differ in more than their numbers.
function numberDistance(actual: string, expected: string) {
  if (actual.replace(NUMBER, '#') !== expected.replace(NUMBER, '#')) return Infinity
  const want = expected.match(NUMBER) ?? []
  return Math.max(0, ...(actual.match(NUMBER) ?? []).map((value, i) => Math.abs(Number(value) - Number(want[i]))))
}
