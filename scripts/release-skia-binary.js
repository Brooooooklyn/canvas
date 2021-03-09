const { execSync } = require('child_process')
const { promises: fs } = require('fs')
const { platform } = require('os')
const { join, parse } = require('path')

const { Octokit } = require('@octokit/rest')
const chalk = require('chalk')

const OWNER = 'Brooooooklyn'
const REPO = 'canvas'

const [FULL_HASH] = execSync(`git submodule status skia`).toString('utf8').trim().split(' ')

const SHORT_HASH = FULL_HASH.substr(0, 8)

const TAG = `skia-${SHORT_HASH}`

const PLATFORM_NAME = platform()

const [, , ARG] = process.argv

const SKIA_BINARY = join(__dirname, '..', 'skia', 'out', 'Static', PLATFORM_NAME === 'win32' ? 'skia.lib' : 'libskia.a')
const SKIA_PLATFORM_NAME = PLATFORM_NAME === 'win32' ? `skia-${PLATFORM_NAME}.lib` : `libskia-${PLATFORM_NAME}.a`
const SKIA_COPY = join(__dirname, '..', SKIA_PLATFORM_NAME)
const DOWNLOAD_URL = `https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${SKIA_PLATFORM_NAME}`

const CLIENT = new Octokit({
  auth: process.env.GITHUB_TOKEN,
})

async function upload() {
  try {
    console.info(chalk.green(`Fetching release by tag: [${TAG}]`))
    await CLIENT.repos.getReleaseByTag({
      repo: REPO,
      owner: OWNER,
      tag: TAG,
    })
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
  console.info(chalk.green(`Copy [${SKIA_BINARY}] to [${SKIA_COPY}]`))
  await fs.copyFile(SKIA_BINARY, SKIA_COPY)
  console.info(chalk.green(`Uploading [${SKIA_COPY}] to github release: [${TAG}]`))
  await putasset(process.env.GITHUB_TOKEN, {
    owner: OWNER,
    repo: REPO,
    tag: TAG,
    filename: SKIA_COPY,
  })
}

async function download() {
  await fs.mkdir(parse(SKIA_BINARY).dir, {
    recursive: true,
  })
  execSync(`curl -J -L -H "Accept: application/octet-stream" ${DOWNLOAD_URL} -o ${SKIA_BINARY}`, {
    stdio: 'inherit',
  })
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
