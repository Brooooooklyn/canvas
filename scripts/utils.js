const { execSync } = require('child_process')
const { join } = require('path')

const OWNER = 'Brooooooklyn'
const REPO = 'canvas'

const [FULL_HASH] =
  process.env.NODE_ENV === 'ava' ? ['000000'] : execSync(`git submodule status skia`).toString('utf8').trim().split(' ')

const SHORT_HASH = FULL_HASH.substr(0, 8)

const TAG = `skia-${SHORT_HASH}`

/**
 * @param {string} lib Static lib name
 * @param {string} hostPlatform require('os').platform()
 * @param {string | undefined} triple rust target triple
 * @returns {{ binary: string; copy: string; downloadUrl: string; filename: string }}
 */
function libPath(lib, hostPlatform, triple, tag = TAG) {
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
      default:
        throw new TypeError(`[${triple}] is not a valid target`)
    }
  }
  const binary = join(__dirname, '..', 'skia', 'out', 'Static', hostPlatform === 'win32' ? `${lib}.lib` : `lib${lib}.a`)

  const copy = join(__dirname, '..', platformName)
  const downloadUrl = `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${platformName}`
  return { binary, copy, downloadUrl, filename: platformName }
}

module.exports = { libPath, OWNER, REPO, TAG }
