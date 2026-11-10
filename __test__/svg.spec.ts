import { spawnSync } from 'node:child_process'
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
  } else {
    result
      .toString('utf8')
      .split('\n')
      .forEach((line, index) => {
        t.deepEqual(line.trim(), output.split('\n')[index]?.trim())
      })
  }
})

// Bytes that are not an SVG document (not XML, a repeated attribute, a
// U+FFFF character) throw the error a document SkSVG cannot read throws,
// instead of crashing the process. In a child process, so a crash fails
// this test and not the run.
test('convertSVGTextToPath throws on bytes that are not an SVG document', (t) => {
  const script = `
    const { convertSVGTextToPath } = require(process.env.PROBE_INDEX)
    const inputs = ['not svg', '<svg a="1" a="2"/>', '<svg xmlns="http://www.w3.org/2000/svg">\\uFFFF</svg>']
    console.log(JSON.stringify(inputs.map((input) => {
      try {
        return { length: convertSVGTextToPath(input).length }
      } catch (e) {
        return { error: e.message }
      }
    })))
  `
  const child = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, PROBE_INDEX: join(__dirname, '..', 'index.js') },
  })
  t.is(child.signal, null, child.stderr)
  t.is(child.status, 0, child.stderr)
  t.deepEqual(JSON.parse(child.stdout), [
    { error: 'Convert svg text to path failed' },
    { error: 'Convert svg text to path failed' },
    { error: 'Convert svg text to path failed' },
  ])
})
