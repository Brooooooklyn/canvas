import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

const require = createRequire(import.meta.url)
const { buildGnArgs } = require('../skia-gn-args.cjs')

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..')

// The macOS and Linux targets build.rs compiles Skia's Fontations C++ for,
// with the arguments scripts/build-skia.js builds their libskia with.
const TARGETS = [
  { rust: 'x86_64-unknown-linux-gnu', platformName: 'linux', targetTriple: '', hostArch: 'x64', hostLibc: 'glibc' },
  { rust: 'aarch64-unknown-linux-gnu', platformName: 'linux', targetTriple: 'aarch64-unknown-linux-gnu' },
  { rust: 'x86_64-unknown-linux-musl', platformName: 'linux', targetTriple: 'x86_64-unknown-linux-musl' },
  { rust: 'aarch64-unknown-linux-musl', platformName: 'linux', targetTriple: 'aarch64-unknown-linux-musl' },
  { rust: 'armv7-unknown-linux-gnueabihf', platformName: 'linux', targetTriple: 'armv7-unknown-linux-gnueabihf' },
  { rust: 'riscv64gc-unknown-linux-gnu', platformName: 'linux', targetTriple: 'riscv64gc-unknown-linux-gnu' },
  { rust: 'aarch64-apple-darwin', platformName: 'darwin', targetTriple: 'aarch64-apple-darwin' },
  { rust: 'x86_64-apple-darwin', platformName: 'darwin', targetTriple: 'x86_64-apple-darwin' },
]

// build.rs libskia_flags: the "*" lines and the target's own.
function flagsFileDefines(target: string) {
  return readFileSync(join(ROOT, 'skia-c', 'libskia.flags'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => line.split(' '))
    .filter(([scope]) => scope === '*' || scope === target)
    .map(([, flag]) => flag)
}

// The -D / -U flags of libskia's extra_cflags (C and C++) and extra_cflags_cc.
function gnArgDefines(args: Map<string, string>) {
  return ['extra_cflags', 'extra_cflags_cc'].flatMap((name) =>
    [...(args.get(name) ?? '').matchAll(/"(-[DU][^"]*)"/g)].map((match) => match[1]),
  )
}

for (const { rust, ...context } of TARGETS) {
  test(`skia-c/libskia.flags has libskia's GN defines for ${rust}`, (t) => {
    const { args } = buildGnArgs({ ...context, env: {} })
    // The same flags; the order only matters for -USK_R32_SHIFT, which both
    // put before -DSK_R32_SHIFT=0.
    t.deepEqual(flagsFileDefines(rust).sort(), gnArgDefines(args).sort())
  })
}
