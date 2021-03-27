const { execSync } = require('child_process')
const { promises: fs } = require('fs')
const { platform } = require('os')
const { parse } = require('path')

const { Octokit } = require('@octokit/rest')
const chalk = require('chalk')

const { libPath, TAG, OWNER, REPO } = require('./utils')

const PLATFORM_NAME = platform()

const [, , ARG, TARGET] = process.argv

let TARGET_TRIPLE

if (TARGET && TARGET.startsWith('--target=')) {
  TARGET_TRIPLE = TARGET.replace('--target=', '')
}

const LIB = ['skia', 'skparagraph', 'skshaper']

const CLIENT = new Octokit({
  auth: process.env.GITHUB_TOKEN,
})

async function upload() {
  let assets = []
  try {
    console.info(chalk.green(`Fetching release by tag: [${TAG}]`))
    assets = (
      await CLIENT.repos.getReleaseByTag({
        repo: REPO,
        owner: OWNER,
        tag: TAG,
      })
    ).data.assets
  } catch (e) {
    if (e.status === 404) {
      console.info(chalk.green(`No release tag, creating release tag ${TAG}`))
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
  const putasset = require('putasset')
  for (const lib of LIB) {
    const { copy, binary } = libPath(lib, PLATFORM_NAME, TARGET_TRIPLE)
    console.info(chalk.green(`Copy [${binary}] to [${copy}]`))
    await fs.copyFile(binary, copy)
    console.info(chalk.green(`Uploading [${copy}] to github release: [${TAG}]`))

    const asset = assets.find(({ name }) => name === parse(copy).base)
    if (asset) {
      console.info(chalk.green(`[${copy}] existed, delete it...`))
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
}

// eslint-disable-next-line sonarjs/no-use-of-empty-return-value
program().catch((e) => {
  console.error(e)
  process.exit(1)
})
