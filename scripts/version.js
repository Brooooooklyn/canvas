const { execSync } = require('child_process')
const path = require('path')

const { version } = require('../package.json')
const platforms = require('./platforms')
const updatePackageJson = require('./update-package')

for (const name of platforms) {
  const pkgDir = path.join(__dirname, '..', 'npm', name)
  updatePackageJson(path.join(pkgDir, 'package.json'), {
    version,
  })
}

execSync('git add .', {
  stdio: 'inherit',
})
