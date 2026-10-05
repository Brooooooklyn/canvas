// Computes the GN args for building Skia. Shared between build-skia.js (which
// passes them to `gn gen`) and generate-sbom.mjs (which evaluates the same args
// per platform to decide which vendored third-party libs are enabled) — so the
// SBOM reads the real GN configuration instead of re-parsing this file.
//
// Keep the arg list identical to what build-skia.js produces for the same build
// context; when you add or change a GN arg here it changes both the build and
// the SBOM.

const { execSync } = require('node:child_process')

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

// context mirrors the build host of a GN invocation:
//   targetTriple — the --target= value ('' for a native build)
//   platformName — os.platform() of the build host ('linux' | 'darwin' | 'win32')
//   hostArch     — os.arch() of the build host
//   hostLibc     — 'glibc' | 'musl' | null (build host libc)
//   env          — for ANDROID_NDK_LATEST_HOME
// Returns { gnArgs: string[], args: Map<name, evaluated-value>, cc, cxx, extraSkiaBuildFlag }
function buildGnArgs({
  targetTriple = '',
  platformName = process.platform,
  hostArch = process.arch,
  hostLibc = null,
  env = process.env,
} = {}) {
  // Windows-latest in skia.yaml invokes build-skia.js with no --target= flag
  // (native x64 host build), so targetTriple is empty even though the resulting
  // binary is x86_64-pc-windows-msvc and is affected by the crash. Match the
  // native host explicitly in addition to the --target= lookup.
  const IS_NATIVE_WIN_X64 = !targetTriple && platformName === 'win32' && hostArch === 'x64'
  const PDF_HARFBUZZ_SUBSET_ENABLED = !PDF_HARFBUZZ_SUBSET_CRASHING_TARGETS.has(targetTriple) && !IS_NATIVE_WIN_X64

  let cc = platformName === 'win32' ? '\\"clang-cl\\"' : '"clang"'
  let cxx = platformName === 'win32' ? '\\"clang-cpp\\"' : '"clang++"'
  let extraCflagsCC = ''
  let extraSkiaBuildFlag = ''
  let extraCflags
  let extraLdFlags
  let extraAsmFlags

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
    `skia_use_libjxl_decode=${!targetTriple.startsWith('riscv64')}`,
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

  switch (platformName) {
    case 'win32':
      extraCflagsCC =
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
        extraSkiaBuildFlag = `clang_win_version=\\"${clangVersion}\\"`
      }
      GN_ARGS.push(`clang_win=\\"C:\\\\Program Files\\\\LLVM\\"`)
      GN_ARGS.push(`skia_enable_fontmgr_win=false`)
      break
    case 'linux':
    case 'darwin':
      extraCflagsCC =
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
      if (platformName === 'linux' && !targetTriple && hostArch === 'x64') {
        if (hostLibc === 'glibc') {
          extraCflagsCC += ',"-stdlib=libc++","-static","-I/usr/lib/llvm-19/include/c++/v1"'
        } else {
          extraCflagsCC += ',"-stdlib=libc++","-static","-I/usr/include/c++/v1","-fPIC","-fno-cxx-exceptions"'
        }
      }
      if (platformName === 'linux' && (!targetTriple || targetTriple.startsWith('x86_64'))) {
        extraCflagsCC += ',"-Wno-psabi"'
      }
      break
    default:
      throw new TypeError(`Don't support ${platformName} for now`)
  }

  switch (targetTriple) {
    case 'aarch64-unknown-linux-gnu':
      extraSkiaBuildFlag += ' target_cpu="arm64" target_os="linux"'
      // -DAT_HWCAP2=26: the highway roll in Skia m152 taught hwy/targets.cc to probe the
      // aarch64 CPU through getauxval(AT_HWCAP2). Highway backfills the HWCAP2_* bit values
      // it reads (targets.cc:502-507) but not the auxv key itself, and glibc only added
      // AT_HWCAP2 to elf.h in 2.18, so the 2.17 sysroot this target builds against fails
      // with "use of undeclared identifier 'AT_HWCAP2'". 26 is the fixed Linux uapi value
      // from linux/auxvec.h, identical to what glibc >= 2.18 defines, so a newer sysroot
      // would redefine it token-for-token. getauxval returns 0 for a key the kernel does
      // not supply, which highway reads as "no SVE2", so the probe stays correct.
      extraCflags =
        '"--target=aarch64-unknown-linux-gnu", "--sysroot=/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot", "-I/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot/usr/include", "-march=armv8-a", "-DAT_HWCAP2=26"'
      extraCflagsCC +=
        ', "--target=aarch64-unknown-linux-gnu", "--sysroot=/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot", "-I/usr/lib/llvm-19/include/c++/v1", "-I/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot/usr/include", "-march=armv8-a"'
      extraLdFlags =
        '"-fuse-ld=lld", "-L/usr/aarch64-unknown-linux-gnu/lib/llvm-19/lib", "-L/usr/aarch64-unknown-linux-gnu/lib", "-L/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot/lib", "-L/usr/aarch64-unknown-linux-gnu/lib/gcc/aarch64-unknown-linux-gnu/4.8.5"'
      extraAsmFlags = '"--target=aarch64-unknown-linux-gnu", "-march=armv8-a"'

      GN_ARGS.push(
        `extra_ldflags=[${extraLdFlags}]`,
        `ar="llvm-ar-19"`,
        `extra_asmflags=[${extraAsmFlags}]`,
        `extra_cflags=[${extraCflags}]`,
        `extra_cflags_c=[${extraCflags}]`,
      )
      break
    case 'aarch64-unknown-linux-musl':
      cc = '"zig cc"'
      cxx = '"zig c++"'
      extraSkiaBuildFlag += ' target_cpu="arm64" target_os="linux"'
      extraCflags = `"--target=aarch64-linux-musl", "-fPIC", "-march=cortex_a78"`
      extraCflagsCC += `, "--target=aarch64-linux-musl", "-static", "-fPIC", "-march=cortex_a78"`
      extraLdFlags = `"--target=aarch64-linux-musl"`
      extraAsmFlags = '"--target=aarch64-linux-musl", "-march=cortex_a78"'
      GN_ARGS.push(
        `extra_ldflags=[${extraLdFlags}]`,
        `ar="zig ar"`,
        `extra_asmflags=[${extraAsmFlags}]`,
        `extra_cflags=[${extraCflags}]`,
        `extra_cflags_c=[${extraCflags}]`,
      )
      break
    case 'x86_64-unknown-linux-musl':
      cc = '"zig cc"'
      cxx = '"zig c++"'
      extraSkiaBuildFlag += ' target_cpu="x64" target_os="linux"'
      extraCflags = `"--target=x86_64-linux-musl", "-fPIC"`
      extraCflagsCC += `, "--target=x86_64-linux-musl", "-static", "-fPIC", "-march=sandybridge", "-mevex512"`
      extraLdFlags = `"--target=x86_64-linux-musl"`
      extraAsmFlags = '"--target=x86_64-linux-musl"'
      GN_ARGS.push(
        `extra_ldflags=[${extraLdFlags}]`,
        `ar="zig ar"`,
        `extra_asmflags=[${extraAsmFlags}]`,
        `extra_cflags=[${extraCflags}]`,
        `extra_cflags_c=[${extraCflags}]`,
      )
      break
    case 'armv7-unknown-linux-gnueabihf':
      cc = '"arm-linux-gnueabihf-gcc"'
      cxx = '"arm-linux-gnueabihf-g++"'
      // Disable SkPathData backend - it has issues on 32-bit ARM under QEMU emulation
      // The kill switch was added in Chrome m144: skia commit 7f325708d2
      extraCflagsCC += ',"-DSK_DISABLE_PATHDATA"'
      // Use "armv7a" (not "arm") to avoid Skia's zlib bug where ARM CRC32
      // (armv8-only) is incorrectly enabled for all ARM targets
      extraSkiaBuildFlag += ' target_cpu="armv7a" target_os="linux"'
      break
    case 'aarch64-apple-darwin':
      extraSkiaBuildFlag += ' target_cpu="arm64" target_os="mac"'
      extraCflagsCC += ', "--target=arm64-apple-macos", "-mmacosx-version-min=11.0"'
      extraLdFlags = '"--target=arm64-apple-macos", "-mmacosx-version-min=11.0"'
      extraAsmFlags = '"--target=arm64-apple-macos", "-mmacosx-version-min=11.0"'
      extraCflags = '"--target=arm64-apple-macos", "-mmacosx-version-min=11.0"'
      GN_ARGS.push(
        `extra_ldflags=[${extraLdFlags}]`,
        `extra_asmflags=[${extraAsmFlags}]`,
        `extra_cflags=[${extraCflags}]`,
        `extra_cflags_c=[${extraCflags}]`,
      )
      break
    case 'aarch64-linux-android': {
      const { ANDROID_NDK_LATEST_HOME } = env
      if (!ANDROID_NDK_LATEST_HOME) {
        throw new TypeError('ANDROID_NDK_LATEST_HOME must be specified in env variable')
      }
      extraSkiaBuildFlag += ` target_cpu="arm64" ndk="${ANDROID_NDK_LATEST_HOME}"`
      break
    }
    case 'x86_64-apple-darwin':
      if (hostArch === 'arm64') {
        extraSkiaBuildFlag += ' target_cpu="x64" target_os="mac"'
        extraCflagsCC += ',"-Wno-psabi"'
      }
      extraCflagsCC += ', "-mmacosx-version-min=10.13"'
      extraLdFlags = ' "-mmacosx-version-min=10.13"'
      extraAsmFlags = '"-mmacosx-version-min=10.13"'
      extraCflags = '"-mmacosx-version-min=10.13"'
      GN_ARGS.push(
        `extra_ldflags=[${extraLdFlags}]`,
        `extra_asmflags=[${extraAsmFlags}]`,
        `extra_cflags=[${extraCflags}]`,
        `extra_cflags_c=[${extraCflags}]`,
      )
      break
    case 'riscv64gc-unknown-linux-gnu':
      extraSkiaBuildFlag += ' target_cpu="riscv64" target_os="linux"'
      cc = '"riscv64-linux-gnu-gcc"'
      cxx = '"riscv64-linux-gnu-g++"'
      break
    case 'aarch64-pc-windows-msvc':
      extraSkiaBuildFlag += ' target_cpu=\\"arm64\\"'
      break
    case '':
      break
    default:
      throw new TypeError(`[${targetTriple}] is not a valid target`)
  }

  GN_ARGS.push(`cc=${cc}`, `cxx=${cxx}`, `extra_cflags_cc=[${extraCflagsCC}]`, extraSkiaBuildFlag)

  const args = new Map()
  for (const entry of GN_ARGS) {
    const eq = entry.indexOf('=')
    if (eq === -1) continue
    args.set(entry.slice(0, eq), entry.slice(eq + 1))
  }

  return { gnArgs: GN_ARGS, args, cc, cxx, extraSkiaBuildFlag }
}

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

module.exports = { buildGnArgs }
