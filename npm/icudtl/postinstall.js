const { copyFile } = require('fs')
const { join } = require('path')

const ICU_DAT = 'icudtl.dat'

const path = join(require.resolve('@napi-rs/canvas', '..'))
copyFile(join(__dirname, ICU_DAT), join(path, '..', ICU_DAT), (err) => {
  if (err) {
    console.error(err)
    process.exit(1)
  }
})
