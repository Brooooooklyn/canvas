import { execSync } from 'node:child_process'
import { promises as fs, copyFileSync, statSync } from 'node:fs'
import { platform } from 'node:os'
import { parse, join } from 'node:path'

import { Octokit } from '@octokit/rest'
import { green } from 'colorette'

import { libPath, TAG, OWNER, REPO, dirname } from './utils.mjs'

const PLATFORM_NAME = platform()

const [, , ARG, TARGET] = process.argv

let TARGET_TRIPLE

if (TARGET && TARGET.startsWith('--target=')) {
  TARGET_TRIPLE = TARGET.replace('--target=', '')
}

const LIB = ['skia', 'skparagraph', 'skshaper', 'svg', 'skunicode_core', 'skunicode_icu']
const ICU_DAT = 'icudtl.dat'

const CLIENT = new Octokit({
  auth: process.env.GITHUB_TOKEN,
})

async function upload() {
  let release_id
  let assets = []
  try {
    console.info(green(`Fetching release by tag: [${TAG}]`))
    const release = await CLIENT.repos.getReleaseByTag({
      repo: REPO,
      owner: OWNER,
      tag: TAG,
    })
    release_id = release.data.id
    assets = release.data.assets
  } catch (e) {
    if (e.status === 404) {
      console.info(green(`No release tag, creating release tag ${TAG}`))
      const release = await CLIENT.repos.createRelease({
        repo: REPO,
        owner: OWNER,
        tag_name: TAG,
        name: TAG,
      })
      release_id = release.data.id
    } else {
      throw e
    }
  }
  for (const lib of LIB) {
    const { copy, binary, filename } = libPath(lib, PLATFORM_NAME, TARGET_TRIPLE)
    console.info(green(`Copy [${binary}] to [${copy}]`))
    await fs.copyFile(binary, copy)
    console.info(green(`Uploading [${copy}] to github release: [${TAG}]`))

    const asset = assets.find(({ name }) => name === parse(copy).base)
    if (asset) {
      console.info(green(`[${copy}] existed, delete it...`))
      await CLIENT.repos.deleteReleaseAsset({
        owner: OWNER,
        repo: REPO,
        asset_id: asset.id,
      })
    }
    const dstFileStats = statSync(copy)
    await CLIENT.repos
      .uploadReleaseAsset({
        owner: OWNER,
        repo: REPO,
        name: filename,
        release_id,
        mediaType: { format: 'raw' },
        headers: {
          'content-length': dstFileStats.size,
          'content-type': 'application/octet-stream',
        },
        data: await fs.readFile(copy),
      })
      .catch((e) => {
        execSync(`ls -la ./skia/out/Static`, { stdio: 'inherit' })
        execSync(`ls -la .`, { stdio: 'inherit' })
        throw e
      })
  }
  if (PLATFORM_NAME === 'win32') {
    const icudtl = assets.find(({ name }) => name === ICU_DAT)
    if (icudtl) {
      console.info(green(`[${ICU_DAT}] existed, delete it...`))
      await CLIENT.repos.deleteReleaseAsset({
        owner: OWNER,
        repo: REPO,
        asset_id: icudtl.id,
      })
    }
    console.info(green(`Uploading [${ICU_DAT}] to github release: [${TAG}]`))
    const icuDataPath = join(dirname, '..', 'skia', 'out', 'Static', ICU_DAT)
    await CLIENT.repos.uploadReleaseAsset({
      owner: OWNER,
      repo: REPO,
      name: ICU_DAT,
      release_id,
      mediaType: { format: 'raw' },
      headers: {
        'content-length': statSync(icuDataPath).size,
        'content-type': 'application/octet-stream',
      },
      data: await fs.readFile(icuDataPath),
    })
  }
}

async function download() {
  await fs.mkdir(parse(libPath('skia', PLATFORM_NAME, TARGET_TRIPLE).binary).dir, {
    recursive: true,
  })
  for (const lib of LIB) {
    const { downloadUrl, binary } = libPath(lib, PLATFORM_NAME, TARGET_TRIPLE)
    console.info(`downloading ${downloadUrl} to ${binary}`)
    execSync(`curl -J -L -H "Accept: application/octet-stream" ${downloadUrl} -o ${binary}`, {
      stdio: 'inherit',
    })
  }
  if (PLATFORM_NAME === 'win32') {
    await downloadIcu()
    await fs.copyFile(join(dirname, '..', ICU_DAT), join(dirname, '..', 'npm', 'win32-x64-msvc', ICU_DAT))
  }
}

function downloadIcu() {
  const downloadUrl = `https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${ICU_DAT}`
  execSync(`curl -J -L -H "Accept: application/octet-stream" ${downloadUrl} -o ${ICU_DAT}`, {
    stdio: 'inherit',
  })
  copyFileSync(join(dirname, '..', ICU_DAT), join(dirname, '..', 'npm', 'win32-x64-msvc', ICU_DAT))
  return Promise.resolve(null)
}

let program = () => {
  throw new TypeError(`Unknown arguments [${ARG}]`)
}

switch (ARG) {
  case '--download':
    program = download
    break
  case '--upload':
    program = upload
    break
  case '--download-icu':
    program = downloadIcu
}

// eslint-disable-next-line sonarjs/no-use-of-empty-return-value
program().catch((e) => {
  console.error(e)
  process.exit(1)
})
