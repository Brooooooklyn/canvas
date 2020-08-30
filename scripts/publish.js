const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const platforms = require('./platforms')
const updatePackageJson = require('./update-package')

const { version } = require('../package.json')

updatePackageJson(path.join(__dirname, '..', 'package.json'), {
  optionalDependencies: platforms.reduce((acc, cur) => {
    acc[`@napi-rs/package-template-${cur}`] = `^${version}`
    return acc
  }, {}),
})

for (const name of platforms) {
  const pkgDir = path.join(__dirname, '..', 'npm', name)
  const filename = `index.${name}.node`
  const bindingFile = fs.readFileSync(path.join(__dirname, '..', `bindings-${name}`, filename))
  fs.writeFileSync(path.join(pkgDir, filename), bindingFile)
  execSync('npm publish', {
    cwd: pkgDir,
    env: process.env,
    stdio: 'inherit',
  })
}
