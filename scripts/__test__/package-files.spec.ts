import { readFile } from 'node:fs/promises'

import test from 'ava'

test('published package includes cargo manifests', async (t) => {
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    files: string[]
  }

  t.true(packageJson.files.includes('Cargo.toml'))
  t.true(packageJson.files.includes('Cargo.lock'))
})
