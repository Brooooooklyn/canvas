import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import test from 'ava'

import { downloadFile } from '../utils.mjs'

// The node:*-slim and node:*-alpine CI images have no curl.
const curlTest = spawnSync('curl', ['--version']).status === 0 ? test : test.skip

// downloadFile blocks the event loop (execFileSync), so the HTTP server runs
// in a child process.
async function withServer(status: number, body: string, run: (url: string) => void) {
  const server = spawn(
    process.execPath,
    [
      '-e',
      `const s = require('node:http').createServer((q, r) => { r.statusCode = ${status}; r.end(${JSON.stringify(body)}) })
       s.listen(0, '127.0.0.1', () => console.log(s.address().port))`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  try {
    const port = await new Promise<string>((resolve, reject) => {
      server.stdout.once('data', (data) => resolve(String(data).trim()))
      server.once('error', reject)
    })
    run(`http://127.0.0.1:${port}/libskia.a`)
  } finally {
    server.kill()
  }
}

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-download-'))
  return { file: join(dir, 'libskia.a'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

curlTest('downloadFile fails on an HTTP error and leaves no file', async (t) => {
  const { file, cleanup } = tempFile()
  t.teardown(cleanup)
  await withServer(404, 'Not Found', (url) => {
    t.throws(() => downloadFile(url, file), { message: `Failed to download ${url}` })
  })
  t.false(existsSync(file))
})

curlTest('downloadFile saves the response body', async (t) => {
  const { file, cleanup } = tempFile()
  t.teardown(cleanup)
  await withServer(200, '!<arch>\n', (url) => {
    downloadFile(url, file)
  })
  t.is(readFileSync(file, 'utf8'), '!<arch>\n')
})
