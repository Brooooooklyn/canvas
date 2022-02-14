const { execSync } = require('child_process')
const { promises: fs, copyFileSync } = require('fs')
const { platform } = require('os')
const { parse, join } = require('path')

const { Octokit } = require('@octokit/rest')
const { green } = require('colorette')

const { libPath, TAG, OWNER, REPO } = require('./utils')

const PLATFORM_NAME = platform()

const [, , ARG, TARGET] = process.argv

let TARGET_TRIPLE

if (TARGET && TARGET.startsWith('--target=')) {
  TARGET_TRIPLE = TARGET.replace('--target=', '')
}

const LIB = ['skia', 'skparagraph', 'skshaper', 'svg', 'sktext', 'skunicode']
const ICU_DAT = 'icudtl.dat'

const CLIENT = new Octokit({
  auth: process.env.GITHUB_TOKEN,
})

async function upload() {
  const putasset = require('putasset')
  let assets = []
  try {
    console.info(green(`Fetching release by tag: [${TAG}]`))
    assets = (
      await CLIENT.repos.getReleaseByTag({
        repo: REPO,
        owner: OWNER,
        tag: TAG,
      })
    ).data.assets
  } catch (e) {
    if (e.status === 404) {
      console.info(green(`No release tag, creating release tag ${TAG}`))
      await CLIENT.repos.createRelease({
        repo: REPO,
        owner: OWNER,
        tag_name: TAG,
        name: TAG,
      })
    } else {
      throw e
    }
  }
  for (const lib of LIB) {
    const { copy, binary } = libPath(lib, PLATFORM_NAME, TARGET_TRIPLE)
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
    await putasset(process.env.GITHUB_TOKEN, {
      owner: OWNER,
      repo: REPO,
      tag: TAG,
      filename: copy,
    }).catch((e) => {
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
    await putasset(process.env.GITHUB_TOKEN, {
      owner: OWNER,
      repo: REPO,
      tag: TAG,
      filename: join(__dirname, '..', 'skia', 'out', 'Static', ICU_DAT),
    })
  }
}

async function download() {
  await fs.mkdir(parse(libPath('skia', PLATFORM_NAME, TARGET_TRIPLE).binary).dir, {
    recursive: true,
  })
  for (const lib of LIB) {
    const { downloadUrl, binary } = libPath(lib, PLATFORM_NAME, TARGET_TRIPLE)
    execSync(`curl -J -L -H "Accept: application/octet-stream" ${downloadUrl} -o ${binary}`, {
      stdio: 'inherit',
    })
  }
  if (PLATFORM_NAME === 'win32') {
    await downloadIcu()
    await fs.copyFile(join(__dirname, '..', ICU_DAT), join(__dirname, '..', 'npm', 'win32-x64-msvc', ICU_DAT))
  }
}

function downloadIcu() {
  const downloadUrl = `https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${ICU_DAT}`
  execSync(`curl -J -L -H "Accept: application/octet-stream" ${downloadUrl} -o ${ICU_DAT}`, {
    stdio: 'inherit',
  })
  copyFileSync(join(__dirname, '..', ICU_DAT), join(__dirname, '..', 'npm', 'win32-x64-msvc', ICU_DAT))
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
