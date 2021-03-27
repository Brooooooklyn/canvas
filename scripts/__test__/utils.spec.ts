import { sep } from 'path'

import test from 'ava'

const { libPath } = require('../utils')

const TEST_MATRIX = [
  { platform: 'win32' },
  { platform: 'linux' },
  { platform: 'darwin' },
  { platform: 'linux', triple: 'aarch64-unknown-linux-gnu' },
  { platform: 'linux', triple: 'armv7-unknown-linux-gnueabihf' },
  { platform: 'linux', triple: 'x86_64-unknown-linux-musl' },
  { platform: 'linux', triple: 'aarch64-linux-android' },
]

for (const { platform, triple } of TEST_MATRIX) {
  const title = triple ? `parse ${triple} path` : `parse ${platform} path`
  test(title, (t) => {
    const { downloadUrl, binary, copy } = libPath('skia', platform, triple, '000')
    t.snapshot(downloadUrl)
    t.snapshot(binary.replace(process.cwd(), '').split(sep).join('/'))
    t.snapshot(copy.replace(process.cwd(), '').split(sep).join('/'))
  })
}
