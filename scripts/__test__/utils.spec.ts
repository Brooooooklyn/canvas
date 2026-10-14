import { sep } from 'node:path'

import test from 'ava'

import { libPath, skiaReleaseTag } from '../utils.mjs'

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

test('release tag carries the Skia commit and the GN args', (t) => {
  const args = "const X = ['-DSK_A']\nmodule.exports = { X }\n"
  const tag = skiaReleaseTag('95ee33d7ec7791ab9c071675710a14fe6408ae4f', args)
  t.regex(tag, /^skia-95ee33d7-[0-9a-f]{8}$/)
  t.not(skiaReleaseTag('95ee33d7ec7791ab9c071675710a14fe6408ae4f', args.replace('SK_A', 'SK_B')), tag)
  // Windows runners check the scripts out with CRLF.
  t.is(skiaReleaseTag('95ee33d7ec7791ab9c071675710a14fe6408ae4f', args.replace(/\n/g, '\r\n')), tag)
})
