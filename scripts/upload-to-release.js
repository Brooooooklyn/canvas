const { execSync } = require('child_process')
const { join } = require('path')

const { Octokit } = require('@octokit/rest')
const chalk = require('chalk')
const putasset = require('putasset')

const platforms = require('./platforms')

const version =
  'v' +
  execSync('git log -1 --pretty=%B', {
    encoding: 'utf8',
  }).trim('')

;(async () => {
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/')
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  })
  await octokit.repos.createRelease({
    owner,
    repo,
    tag_name: version,
  })
  await Promise.all(
    platforms.map(async (platform) => {
      const binary = join(__dirname, '..', `bindings-${platform}`, `index.${platform}.node`)
      const downloadUrl = await putasset(process.env.GITHUB_TOKEN, {
        owner,
        repo,
        tag: version,
        filename: binary,
      })
      console.info(`${chalk.green(binary)} upload success`)
      console.info(`Download url: ${chalk.blueBright(downloadUrl)}`)
    }),
  )
})().catch((e) => {
  console.error(e)
})
