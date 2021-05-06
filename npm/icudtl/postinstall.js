const { copyFile } = require('fs')
const { join } = require('path')

const ICU_DAT = 'icudtl.dat'

copyFile(join(__dirname, ICU_DAT), join(require.resolve('@napi-rs/canvas'), '..', ICU_DAT), (err) => {
  if (err) {
    console.error(err)
    process.exit(1)
  }
})
