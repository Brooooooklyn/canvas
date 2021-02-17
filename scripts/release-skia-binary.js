const { execSync } = require('child_process')
const { promises: fs } = require('fs')
const { platform } = require('os')
const { join, parse } = require('path')

const { Octokit } = require('@octokit/rest')
const chalk = require('chalk')

const OWNER = 'Brooooooklyn'
const REPO = 'skia-rs'

const [FULL_HASH] = execSync(`git submodule status skia`).toString('utf8').trim().split(' ')

const SHORT_HASH = FULL_HASH.substr(0, 8)

const TAG = `skia-${SHORT_HASH}`

const PLATFORM_NAME = platform()

const [, , ARG] = process.argv

const LIB = ['skia', 'skparagraph', 'skshaper']

function libPath(lib) {
  const binary = join(__dirname, '..', 'skia', 'out', 'Static', PLATFORM_NAME === 'win32' ? 'skia.lib' : 'libskia.a')
  const platformName = PLATFORM_NAME === 'win32' ? `${lib}-${PLATFORM_NAME}.lib` : `lib${lib}-${PLATFORM_NAME}.a`
  const copy = join(__dirname, '..', platformName)
  const downloadUrl = `https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${platformName}`
  return { binary, copy, downloadUrl }
}

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
  for (const lib of LIB) {
    const { copy, binary } = libPath(lib)
    console.info(chalk.green(`Copy [${binary}] to [${copy}]`))
    await fs.copyFile(binary, copy)
    console.info(chalk.green(`Uploading [${copy}] to github release: [${TAG}]`))
    await putasset(process.env.GITHUB_TOKEN, {
      owner: OWNER,
      repo: REPO,
      tag: TAG,
      filename: copy,
      force: true,
    })
  }
}

async function download() {
  await fs.mkdir(parse(libPath('skia').binary).dir, {
    recursive: true,
  })
  for (const lib of LIB) {
    const { downloadUrl, binary } = libPath(lib)
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
