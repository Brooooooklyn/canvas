const { execSync } = require('child_process')
const path = require('path')
const { platform } = require('os')

const platformName = platform()

function exec(command) {
  console.info(command)
  execSync(command, {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..', 'skia'),
    env: process.env,
    shell: platformName === 'win32' ? 'powershell' : 'bash',
  })
}

exec('python ./tools/git-sync-deps')

const CC = platformName === 'win32' ? '\\"clang-cl\\"' : platformName === 'linux' ? '"clang-9"' : '"clang"'
const CXX = platformName === 'win32' ? '\\"clang-cl\\"' : platformName === 'linux' ? '"clang++-9"' : '"clang++"'
let ExtraCflagsCC = ''
let ExtraSkiaBuildFlag = ''
switch (platformName) {
  case 'win32':
    ExtraCflagsCC = `\\"/std:c++17\\", \\"/MT\\", \\"-DSK_FORCE_RASTER_PIPELINE_BLITTER\\"`
    ExtraSkiaBuildFlag = 'clang_win=\\"C:\\\\Program Files\\\\LLVM\\"'
    break
  case 'linux':
    ExtraCflagsCC = '"-std=c++17", "-fno-rtti", "-fno-exceptions", "-DSK_FORCE_RASTER_PIPELINE_BLITTER"'
    ExtraSkiaBuildFlag = ['skia_use_system_freetype2=false', 'skia_use_fontconfig=false'].join(' ')
    break
  case 'darwin':
    ExtraCflagsCC = '"-std=c++17", "-fno-rtti", "-fno-exceptions", "-DSK_FORCE_RASTER_PIPELINE_BLITTER"'
    break
  default:
    throw new TypeError(`Don't support ${platformName} for now`)
}

const OUTPUT_PATH = path.join('out', 'Static')

const GN_ARGS = [
  `is_official_build=false`,
  `is_component_build=false`,
  `is_debug=false`,
  `cc=${CC}`,
  `cxx=${CXX}`,
  `extra_cflags_cc=[${ExtraCflagsCC}]`,
  `werror=false`,
  `paragraph_gms_enabled=false`,
  `paragraph_tests_enabled=false`,
  `skia_enable_android_utils=false`,
  `skia_enable_discrete_gpu=false`,
  `skia_enable_gpu=false`,
  `skia_enable_nvpr=false`,
  `skia_enable_particles=true`,
  `skia_enable_pdf=true`,
  `skia_enable_skottie=false`,
  `skia_enable_skrive=false`,
  `skia_enable_skshaper=true`,
  `skia_enable_sksl_interpreter=false`,
  `skia_enable_tools=false`,
  `skia_use_expat=false`,
  `skia_use_gl=false`,
  `skia_use_harfbuzz=true`,
  `skia_pdf_subset_harfbuzz=true`,
  `skia_use_sfntly=false`,
  `skia_enable_skparagraph=true`,
  `skia_use_icu=false`,
  `skia_use_libgifcodec=false`,
  `skia_use_libheif=false`,
  `skia_use_libjpeg_turbo_decode=false`,
  `skia_use_libjpeg_turbo_encode=false`,
  `skia_use_libwebp_decode=false`,
  `skia_use_libwebp_encode=false`,
  `skia_use_lua=false`,
  ExtraSkiaBuildFlag,
  `skia_use_piex=false`,
].join(' ')

exec(`${path.join('bin', 'gn')} gen ${OUTPUT_PATH} --args='${GN_ARGS}'`)

exec(`ninja -C ${OUTPUT_PATH}`)
