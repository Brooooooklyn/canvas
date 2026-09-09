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

// Skia m148 (commit e179431b2b, "[pdf] Allow table based font subsetting")
// introduced a new path in src/pdf/SkPDFSubsetFont.cpp::subset_harfbuzz that
// wraps woff/woff2 typefaces through hb_face_create_for_tables +
// hb_face_set_get_table_tags_func (HB_VERSION_ATLEAST(10,0,0)) and then calls
// hb_subset_or_fail. For woff/woff2 fonts hb_face_count on the raw blob
// returns 0 (HarfBuzz cannot parse woff2 natively), so execution always falls
// through to the table-based path, and hb_subset_or_fail segfaults inside the
// HarfBuzz 13.1.0 subset module on the targets listed below. glibc linux,
// darwin, aarch64-pc-windows-msvc, android, and riscv64 are unaffected, so
// this is very likely a toolchain/ABI interaction in the static-linked musl
// and MSVC x64 builds rather than a pure logic bug. There is no upstream fix
// as of HarfBuzz 14.1.0 and no revert of the Skia commit.
//
// Workaround: disable skia_pdf_subset_harfbuzz on the affected targets. The
// flag is declared in skia/gn/skia.gni:158 and gates both the harfbuzz subset
// dependency and the SK_PDF_USE_HARFBUZZ_SUBSET define at skia/BUILD.gn:1255.
// With it off, SkPDFSubsetFont compiles as the #else branch and returns null,
// which SkPDFFont.cpp:474-478 handles gracefully: "If subsetting fails, fall
// back to original font data." TrueType fonts on these targets are embedded
// whole instead of subsetted (slightly larger PDFs) and woff/woff2 fonts go
// through the pre-m148 Type3 fallback. All other targets keep full subsetting.
const PDF_HARFBUZZ_SUBSET_CRASHING_TARGETS = new Set([
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-musl',
  'aarch64-unknown-linux-musl',
])
// Windows-latest in skia.yaml invokes this script with no --target= flag
// (native x64 host build), so TARGET_TRIPLE is empty even though the resulting
// binary is x86_64-pc-windows-msvc and is affected by the crash. Match the
// native host explicitly in addition to the --target= lookup.
const IS_NATIVE_WIN_X64 = !TARGET_TRIPLE && PLATFORM_NAME === 'win32' && HOST_ARCH === 'x64'
const PDF_HARFBUZZ_SUBSET_ENABLED = !PDF_HARFBUZZ_SUBSET_CRASHING_TARGETS.has(TARGET_TRIPLE) && !IS_NATIVE_WIN_X64

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
  // See PDF_HARFBUZZ_SUBSET_CRASHING_TARGETS above for the crash details.
  `skia_pdf_subset_harfbuzz=${PDF_HARFBUZZ_SUBSET_ENABLED}`,
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
  // Skia defaults this to `is_clang`, which pulls PartitionAlloc into libskia. Its Linux code
  // needs glibc (sys/cdefs.h, sys/ifunc.h, AT_HWCAP2), breaking musl and the glibc 2.17 aarch64
  // sysroot. The PartitionAlloc archives are never uploaded or linked either, so libskia would
  // ship unresolved raw_ptr/BackupRefPtr symbols.
  `skia_use_partition_alloc=false`,
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
      '"-std=c++20",' +
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
    // -DAT_HWCAP2=26: the highway roll in Skia m152 taught hwy/targets.cc to probe the
    // aarch64 CPU through getauxval(AT_HWCAP2). Highway backfills the HWCAP2_* bit values
    // it reads (targets.cc:502-507) but not the auxv key itself, and glibc only added
    // AT_HWCAP2 to elf.h in 2.18, so the 2.17 sysroot this target builds against fails
    // with "use of undeclared identifier 'AT_HWCAP2'". 26 is the fixed Linux uapi value
    // from linux/auxvec.h, identical to what glibc >= 2.18 defines, so a newer sysroot
    // would redefine it token-for-token. getauxval returns 0 for a key the kernel does
    // not supply, which highway reads as "no SVE2", so the probe stays correct.
    ExtraCflags =
      '"--target=aarch64-unknown-linux-gnu", "--sysroot=/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot", "-I/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot/usr/include", "-march=armv8-a", "-DAT_HWCAP2=26"'
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

// gn/BUILDCONFIG.gn only trusts `cc`/`cxx` named literally clang/clang++; for anything
// else it shells out to gn/is_clang.py to detect the compiler. Skia commit 7e658a67a1
// ("Disable partition_alloc on Mac/iOS when using Xcode clang", first shipped in m152)
// rewrote that probe from
//   subprocess.check_output('%s --version' % cc, shell=True)
// to
//   subprocess.check_output([cc, '--version'])
// The list form execs argv[0] verbatim, so our musl targets - which build through
// cc="zig cc" / cxx="zig c++" - make it look for a single binary named `zig cc`, raise
// FileNotFoundError, and take `gn gen` down with them. Split the multi-word compiler
// back into argv while we run. This only touches the probe: the toolchain still invokes
// `zig cc` exactly as before.
const IsClangPyPath = path.join(__dirname, '..', 'skia', 'gn', 'is_clang.py')
const IS_CLANG_CODE_TO_PATCH = [
  `subprocess.check_output([cc, '--version'])`,
  `subprocess.check_output([cxx, '--version'])`,
]
const IS_CLANG_CODE_I_WANT = [
  `subprocess.check_output(cc.split() + ['--version'])`,
  `subprocess.check_output(cxx.split() + ['--version'])`,
]

if (CC.includes(' ') || CXX.includes(' ')) {
  const isClangContent = readFileSync(IsClangPyPath, 'utf8')
  let patched = isClangContent
  IS_CLANG_CODE_TO_PATCH.forEach((codeToPatch, index) => {
    if (!patched.includes(codeToPatch)) {
      throw new Error(
        `skia/gn/is_clang.py does not contain ${JSON.stringify(codeToPatch)} any more. ` +
          `Re-check the multi-word cc/cxx workaround in scripts/build-skia.js.`,
      )
    }
    patched = patched.replace(codeToPatch, IS_CLANG_CODE_I_WANT[index])
  })
  writeFileSync(IsClangPyPath, patched)
  process.once('beforeExit', () => {
    writeFileSync(IsClangPyPath, isClangContent)
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
