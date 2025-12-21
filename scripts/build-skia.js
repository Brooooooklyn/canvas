const { execSync } = require('node:child_process')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { platform, arch } = require('node:os')

const PLATFORM_NAME = platform()
const HOST_ARCH = arch()
const HOST_LIBC =
  PLATFORM_NAME === 'linux' ? (process.report?.getReport()?.header?.glibcVersionRuntime ? 'glibc' : 'musl') : null

const [, , TARGET] = process.argv

let TARGET_TRIPLE = ''
if (TARGET && TARGET.startsWith('--target=')) {
  TARGET_TRIPLE = TARGET.replace('--target=', '')
}

function exec(command) {
  console.info(command)
  execSync(command, {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..', 'skia'),
    env: process.env,
    shell: PLATFORM_NAME === 'win32' ? 'powershell' : 'bash',
  })
}

if (process.env.SKIP_SYNC_SK_DEPS !== 'false' && process.env.SKIP_SYNC_SK_DEPS !== '0') {
  exec('python ./tools/git-sync-deps')
}

let CC = PLATFORM_NAME === 'win32' ? '\\"clang-cl\\"' : '"clang"'
let CXX = PLATFORM_NAME === 'win32' ? '\\"clang-cpp\\"' : '"clang++"'
let ExtraCflagsCC = ''
let ExtraSkiaBuildFlag = ''
let ExtraCflags
let ExtraLdFlags
let ExtraAsmFlags

const GN_ARGS = [
  `is_official_build=true`,
  `is_component_build=false`,
  `is_debug=false`,
  `werror=false`,
  `paragraph_gms_enabled=false`,
  `paragraph_tests_enabled=false`,
  `skia_enable_android_utils=false`,
  `skia_enable_discrete_gpu=false`,
  `skia_enable_ganesh=false`,
  `skia_enable_pdf=true`,
  `skia_enable_skottie=true`,
  `skia_enable_skshaper=true`,
  `skia_enable_tools=false`,
  `skia_enable_svg=true`,
  `skia_enable_skparagraph=true`,
  `skia_pdf_subset_harfbuzz=true`,
  `skia_use_expat=true`,
  `skia_use_system_expat=false`,
  `skia_use_gl=false`,
  `skia_use_harfbuzz=true`,
  `skia_use_icu=true`,
  // the libavif would conflict with the Rust libavif, use the Rust library to handle avif images
  `skia_use_libavif=false`,
  `skia_use_libjxl_decode=${!TARGET_TRIPLE.startsWith('riscv64')}`,
  `skia_use_libjpeg_turbo_decode=true`,
  `skia_use_libjpeg_turbo_encode=true`,
  `skia_use_libwebp_decode=true`,
  `skia_use_libwebp_encode=true`,
  `skia_use_freetype=true`,
  `skia_use_freetype_woff2=true`,
  `skia_use_fontconfig=false`,
  `skia_use_x11=false`,
  `skia_use_wuffs=true`,
  `skia_use_system_freetype2=false`,
  `skia_use_system_libjpeg_turbo=false`,
  `skia_use_system_libpng=false`,
  `skia_use_system_libwebp=false`,
  `skia_use_system_zlib=false`,
  `skia_use_system_icu=false`,
  `skia_use_system_harfbuzz=false`,
  `skia_use_lua=false`,
  `skia_use_piex=false`,
  `skia_enable_fontmgr_custom_directory=true`,
  `skia_enable_fontmgr_custom_embedded=false`,
  `skia_enable_fontmgr_custom_empty=true`,
  `skia_enable_fontmgr_android=false`,
  `skunicode_tests_enabled=false`,
  `skia_enable_skshaper_tests=false`,
]

switch (PLATFORM_NAME) {
  case 'win32':
    ExtraCflagsCC =
      '\\"/std:c++20\\",' +
      '\\"/MT\\",' +
      '\\"-DSK_FORCE_RASTER_PIPELINE_BLITTER\\",' +
      '\\"-DSK_ENABLE_SVG\\",' +
      '\\"-DSK_RELEASE\\",' +
      '\\"-DSK_DISABLE_TRACING\\",' +
      '\\"-DSK_ENCODE_WEBP\\",' +
      '\\"-DSK_CODEC_DECODES_WEBP\\",' +
      '\\"-DSK_ENCODE_PNG\\",' +
      '\\"-DSK_CODEC_DECODES_PNG\\",' +
      '\\"-DSK_ENCODE_JPEG\\",' +
      '\\"-DSK_CODEC_DECODES_JPEG\\",' +
      '\\"-DSK_SHAPER_HARFBUZZ_AVAILABLE\\"'
    const clangVersion = findClangWinVersion()
    if (clangVersion) {
      console.info(`Found clang version: ${clangVersion}`)
      ExtraSkiaBuildFlag = `clang_win_version=\\"${clangVersion}\\"`
    }
    GN_ARGS.push(`clang_win=\\"C:\\\\Program Files\\\\LLVM\\"`)
    GN_ARGS.push(`skia_enable_fontmgr_win=false`)
    break
  case 'linux':
  case 'darwin':
    ExtraCflagsCC =
      '"-std=c++17",' +
      '"-fno-exceptions",' +
      '"-DSK_FORCE_RASTER_PIPELINE_BLITTER",' +
      '"-DSK_ENABLE_SVG",' +
      '"-DSK_RELEASE",' +
      '"-DSK_DISABLE_TRACING",' +
      '"-DSK_ENCODE_WEBP",' +
      '"-DSK_CODEC_DECODES_WEBP",' +
      '"-DSK_ENCODE_PNG",' +
      '"-DSK_CODEC_DECODES_PNG",' +
      '"-DSK_ENCODE_JPEG",' +
      '"-DSK_CODEC_DECODES_JPEG",' +
      '"-DSK_SHAPER_HARFBUZZ_AVAILABLE"'
    if (PLATFORM_NAME === 'linux' && !TARGET_TRIPLE && HOST_ARCH === 'x64') {
      if (HOST_LIBC === 'glibc') {
        ExtraCflagsCC += ',"-stdlib=libc++","-static","-I/usr/lib/llvm-19/include/c++/v1"'
      } else {
        ExtraCflagsCC += ',"-stdlib=libc++","-static","-I/usr/include/c++/v1","-fPIC","-fno-cxx-exceptions"'
      }
    }
    if (PLATFORM_NAME === 'linux' && (!TARGET_TRIPLE || TARGET_TRIPLE.startsWith('x86_64'))) {
      ExtraCflagsCC += ',"-Wno-psabi"'
    }
    break
  default:
    throw new TypeError(`Don't support ${PLATFORM_NAME} for now`)
}

switch (TARGET_TRIPLE) {
  case 'aarch64-unknown-linux-gnu':
    ExtraSkiaBuildFlag += ' target_cpu="arm64" target_os="linux"'
    ExtraCflags =
      '"--target=aarch64-unknown-linux-gnu", "--sysroot=/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot", "-I/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot/usr/include", "-march=armv8-a"'
    ExtraCflagsCC +=
      ', "--target=aarch64-unknown-linux-gnu", "--sysroot=/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot", "-I/usr/lib/llvm-19/include/c++/v1", "-I/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot/usr/include", "-march=armv8-a"'
    ExtraLdFlags =
      '"-fuse-ld=lld", "-L/usr/aarch64-unknown-linux-gnu/lib/llvm-19/lib", "-L/usr/aarch64-unknown-linux-gnu/lib", "-L/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot/lib", "-L/usr/aarch64-unknown-linux-gnu/lib/gcc/aarch64-unknown-linux-gnu/4.8.5"'
    ExtraAsmFlags = '"--target=aarch64-unknown-linux-gnu", "-march=armv8-a"'

    GN_ARGS.push(
      `extra_ldflags=[${ExtraLdFlags}]`,
      `ar="llvm-ar-19"`,
      `extra_asmflags=[${ExtraAsmFlags}]`,
      `extra_cflags=[${ExtraCflags}]`,
      `extra_cflags_c=[${ExtraCflags}]`,
    )
    break
  case 'aarch64-unknown-linux-musl':
    CC = '"zig cc"'
    CXX = '"zig c++"'
    ExtraSkiaBuildFlag += ' target_cpu="arm64" target_os="linux"'
    ExtraCflags = `"--target=aarch64-linux-musl", "-fPIC", "-march=cortex_a78"`
    ExtraCflagsCC += `, "--target=aarch64-linux-musl", "-static", "-fPIC", "-march=cortex_a78"`
    ExtraLdFlags = `"--target=aarch64-linux-musl"`
    ExtraAsmFlags = '"--target=aarch64-linux-musl", "-march=cortex_a78"'
    GN_ARGS.push(
      `extra_ldflags=[${ExtraLdFlags}]`,
      `ar="zig ar"`,
      `extra_asmflags=[${ExtraAsmFlags}]`,
      `extra_cflags=[${ExtraCflags}]`,
      `extra_cflags_c=[${ExtraCflags}]`,
    )
    break
  case 'x86_64-unknown-linux-musl':
    CC = '"zig cc"'
    CXX = '"zig c++"'
    ExtraSkiaBuildFlag += ' target_cpu="x64" target_os="linux"'
    ExtraCflags = `"--target=x86_64-linux-musl", "-fPIC"`
    ExtraCflagsCC += `, "--target=x86_64-linux-musl", "-static", "-fPIC", "-march=sandybridge", "-mevex512"`
    ExtraLdFlags = `"--target=x86_64-linux-musl"`
    ExtraAsmFlags = '"--target=x86_64-linux-musl"'
    GN_ARGS.push(
      `extra_ldflags=[${ExtraLdFlags}]`,
      `ar="zig ar"`,
      `extra_asmflags=[${ExtraAsmFlags}]`,
      `extra_cflags=[${ExtraCflags}]`,
      `extra_cflags_c=[${ExtraCflags}]`,
    )
    break
  case 'armv7-unknown-linux-gnueabihf':
    CC = '"arm-linux-gnueabihf-gcc"'
    CXX = '"arm-linux-gnueabihf-g++"'
    // Disable SkPathData backend - it has issues on 32-bit ARM under QEMU emulation
    // The kill switch was added in Chrome m144: skia commit 7f325708d2
    ExtraCflagsCC += ',"-DSK_DISABLE_PATHDATA"'
    // Use "armv7a" (not "arm") to avoid Skia's zlib bug where ARM CRC32
    // (armv8-only) is incorrectly enabled for all ARM targets
    ExtraSkiaBuildFlag += ' target_cpu="armv7a" target_os="linux"'
    break
  case 'aarch64-apple-darwin':
    ExtraSkiaBuildFlag += ' target_cpu="arm64" target_os="mac"'
    ExtraCflagsCC += ', "--target=arm64-apple-macos", "-mmacosx-version-min=11.0"'
    ExtraLdFlags = '"--target=arm64-apple-macos", "-mmacosx-version-min=11.0"'
    ExtraAsmFlags = '"--target=arm64-apple-macos", "-mmacosx-version-min=11.0"'
    ExtraCflags = '"--target=arm64-apple-macos", "-mmacosx-version-min=11.0"'
    GN_ARGS.push(
      `extra_ldflags=[${ExtraLdFlags}]`,
      `extra_asmflags=[${ExtraAsmFlags}]`,
      `extra_cflags=[${ExtraCflags}]`,
      `extra_cflags_c=[${ExtraCflags}]`,
    )
    break
  case 'aarch64-linux-android':
    const { ANDROID_NDK_LATEST_HOME } = process.env
    if (!ANDROID_NDK_LATEST_HOME) {
      throw new TypeError('ANDROID_NDK_LATEST_HOME must be specified in env variable')
    }
    ExtraSkiaBuildFlag += ` target_cpu="arm64" ndk="${ANDROID_NDK_LATEST_HOME}"`
    break
  case 'x86_64-apple-darwin':
    if (HOST_ARCH === 'arm64') {
      ExtraSkiaBuildFlag += ' target_cpu="x64" target_os="mac"'
      ExtraCflagsCC += ',"-Wno-psabi"'
    }
    ExtraCflagsCC += ', "-mmacosx-version-min=10.13"'
    ExtraLdFlags = ' "-mmacosx-version-min=10.13"'
    ExtraAsmFlags = '"-mmacosx-version-min=10.13"'
    ExtraCflags = '"-mmacosx-version-min=10.13"'
    GN_ARGS.push(
      `extra_ldflags=[${ExtraLdFlags}]`,
      `extra_asmflags=[${ExtraAsmFlags}]`,
      `extra_cflags=[${ExtraCflags}]`,
      `extra_cflags_c=[${ExtraCflags}]`,
    )
    break
  case 'riscv64gc-unknown-linux-gnu':
    ExtraSkiaBuildFlag += ' target_cpu="riscv64" target_os="linux"'
    CC = '"riscv64-linux-gnu-gcc"'
    CXX = '"riscv64-linux-gnu-g++"'
    break
  case 'aarch64-pc-windows-msvc':
    ExtraSkiaBuildFlag += ' target_cpu=\\"arm64\\"'
    break
  case '':
    break
  default:
    throw new TypeError(`[${TARGET_TRIPLE}] is not a valid target`)
}

const OUTPUT_PATH = path.join('out', 'Static')

GN_ARGS.push(`cc=${CC}`, `cxx=${CXX}`, `extra_cflags_cc=[${ExtraCflagsCC}]`, ExtraSkiaBuildFlag)

const SkLoadICUCppFilePath = path.join(__dirname, '..', 'skia', 'third_party', 'icu', 'SkLoadICU.cpp')
const CODE_TO_PATCH = 'good = load_from(executable_directory()) || load_from(library_directory());'
const CODE_I_WANT = 'good = load_from(library_directory()) || load_from(executable_directory());'
const GNConfigPath = path.join(__dirname, '..', 'skia', 'BUILD.gn')
const GNExampleCode = `skia_executable("skia_c_api_example") {
  sources = [ "experimental/c-api-example/skia-c-example.c" ]
  include_dirs = [ "." ]
  deps = [ ":skia" ]
}`

if (PLATFORM_NAME === 'win32') {
  const content = readFileSync(SkLoadICUCppFilePath, 'utf8')
  const patch = content.replace(CODE_TO_PATCH, CODE_I_WANT)
  writeFileSync(SkLoadICUCppFilePath, patch)
  process.once('beforeExit', () => {
    writeFileSync(SkLoadICUCppFilePath, content)
  })
}

const GN_BUILD_CONTENT = readFileSync(GNConfigPath, 'utf8')
writeFileSync(GNConfigPath, GN_BUILD_CONTENT.replace(GNExampleCode, ''))

process.once('beforeExit', () => {
  writeFileSync(GNConfigPath, GN_BUILD_CONTENT)
})

exec(
  `${process.env.GN_EXE ? process.env.GN_EXE : path.join('bin', 'gn')} gen ${OUTPUT_PATH} --args='${GN_ARGS.join(
    ' ',
  )}'`,
)

// linux musl
// don't know why generated: python3 ../../third_party/externals/icu/scripts/make_data_assembly.py ../../third_party/externals/icu/common/icudtl.dat gen/third_party/icu/icudtl_dat.S
// `python3` should be `python`
if (process.env.GN_EXE) {
  const { readFileSync, writeFileSync } = require('fs')
  const { join } = require('path')

  const ninjaToolchain = join(__dirname, '..', 'skia', 'out', 'Static', 'toolchain.ninja')
  const ninjaToolchainContent = readFileSync(ninjaToolchain, 'utf8')
  writeFileSync(ninjaToolchain, ninjaToolchainContent.replace('python3', 'python'))
}

console.time('Build Skia')

exec(`ninja -C ${OUTPUT_PATH}`)

console.timeEnd('Build Skia')

function findClangWinVersion() {
  const stdout = execSync('clang --version', {
    encoding: 'utf8',
  })
  const clangVersion = stdout.match(/clang version\s(\d+\.\d+\.\d+)/)
  if (!clangVersion) {
    return null
  }
  return clangVersion[1]?.split('.')?.at(0)
}
