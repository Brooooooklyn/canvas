// Runs index.js with Electron's own Node.js (ELECTRON_RUN_AS_NODE=1), twice:
// once with the system fonts loaded by require('@napi-rs/canvas'), once with
// them enabled later by GlobalFonts.enableSystemFonts().
// A crash shows up as a signal (issue #1405 was a SIGTRAP), so report it.

const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

const electron = require('electron')

const runs = [
  { name: 'system fonts loaded on require', env: {} },
  { name: 'system fonts enabled later', env: { DISABLE_SYSTEM_FONTS_LOAD: '1' } },
]

let failed = 0
for (const run of runs) {
  console.log(`# ${run.name}`)
  const env = { ...process.env, ...run.env, ELECTRON_RUN_AS_NODE: '1' }
  if (!('DISABLE_SYSTEM_FONTS_LOAD' in run.env)) {
    delete env.DISABLE_SYSTEM_FONTS_LOAD
  }
  const result = spawnSync(electron, [join(__dirname, 'index.js')], { env, stdio: 'inherit' })
  if (result.error) {
    console.error(`not ok - ${run.name}: could not start ${electron}: ${result.error.message}`)
    failed++
  } else if (result.signal) {
    console.error(`not ok - ${run.name}: Electron was killed by ${result.signal}`)
    failed++
  } else if (result.status !== 0) {
    console.error(`not ok - ${run.name}: Electron exited with code ${result.status}`)
    failed++
  }
}

if (failed) {
  console.error(`${failed} of ${runs.length} Electron runs failed`)
  process.exit(1)
}
console.log(`all ${runs.length} Electron runs passed`)
