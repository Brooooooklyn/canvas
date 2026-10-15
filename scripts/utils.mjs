import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const OWNER = 'Brooooooklyn'
export const REPO = 'canvas'

const [FULL_HASH] =
  process.env.NODE_ENV === 'ava' ? ['000000'] : execSync(`git submodule status skia`).toString('utf8').trim().split(' ')

export const dirname = join(fileURLToPath(import.meta.url), '..')

/**
 * The prebuilt Skia libraries depend on the Skia commit and on the GN args
 * they were built with, so the release tag carries both: a change to
 * scripts/skia-gn-args.cjs needs new binaries instead of reusing the old ones.
 * CRLF is folded to LF first, as Windows runners check the repo out with CRLF.
 * @param {string} submoduleHash `git submodule status skia` hash
 * @param {string} gnArgsSource content of scripts/skia-gn-args.cjs
 * @returns {string} `skia-<8 hex of the Skia commit>-<8 hex of the GN args>`
 */
export function skiaReleaseTag(submoduleHash, gnArgsSource) {
  const gnArgsHash = createHash('sha256').update(gnArgsSource.replace(/\r\n/g, '\n')).digest('hex').substring(0, 8)
  return `skia-${submoduleHash.substring(0, 8)}-${gnArgsHash}`
}

export const TAG = skiaReleaseTag(FULL_HASH, readFileSync(join(dirname, 'skia-gn-args.cjs'), 'utf8'))

/**
 * @param {string} lib Static lib name
 * @param {string} hostPlatform require('os').platform()
 * @param {string | undefined} triple rust target triple
 * @returns {{ binary: string; copy: string; downloadUrl: string; filename: string }}
 */
export function libPath(lib, hostPlatform, triple, tag = TAG) {
  let platformName
  if (!triple) {
    switch (hostPlatform) {
      case 'win32':
        platformName = `${lib}-win32-x64-msvc.lib`
        break
      case 'darwin':
        platformName = `lib${lib}-darwin-x64.a`
        break
      case 'linux':
        platformName = `lib${lib}-linux-x64-gnu.a`
        break
      default:
        throw new TypeError(`[${hostPlatform}] is not a valid platform`)
    }
  } else {
    switch (triple) {
      case 'aarch64-unknown-linux-gnu':
        platformName = `lib${lib}-linux-aarch64-gnu.a`
        break
      case 'aarch64-unknown-linux-musl':
        platformName = `lib${lib}-linux-aarch64-musl.a`
        break
      case 'armv7-unknown-linux-gnueabihf':
        platformName = `lib${lib}-linux-armv7-gnueabihf.a`
        break
      case 'x86_64-unknown-linux-musl':
        platformName = `lib${lib}-linux-x64-musl.a`
        break
      case 'aarch64-apple-darwin':
        platformName = `lib${lib}-darwin-aarch64.a`
        break
      case 'aarch64-linux-android':
        platformName = `lib${lib}-android-aarch64.a`
        break
      case 'riscv64gc-unknown-linux-gnu':
        platformName = `lib${lib}-linux-riscv64-gnu.a`
        break
      case 'aarch64-pc-windows-msvc':
        platformName = `${lib}-win32-arm64-msvc.lib`
        break
      default:
        throw new TypeError(`[${triple}] is not a valid target`)
    }
  }
  const binary = join(dirname, '..', 'skia', 'out', 'Static', hostPlatform === 'win32' ? `${lib}.lib` : `lib${lib}.a`)

  const copy = join(dirname, '..', platformName)
  const downloadUrl = `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${platformName}`
  return { binary, copy, downloadUrl, filename: platformName }
}
