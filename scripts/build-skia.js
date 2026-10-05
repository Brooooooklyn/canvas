const { execSync } = require('node:child_process')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { platform, arch } = require('node:os')

const { buildGnArgs } = require('./skia-gn-args.cjs')

const PLATFORM_NAME = platform()
const HOST_ARCH = arch()
const HOST_LIBC =
  PLATFORM_NAME === 'linux' ? (process.report?.getReport()?.header?.glibcVersionRuntime ? 'glibc' : 'musl') : null

const [, , TARGET] = process.argv

let TARGET_TRIPLE = ''
if (TARGET && TARGET.startsWith('--target=')) {
  TARGET_TRIPLE = TARGET.replace('--target=', '')
}

// GN args are computed in scripts/skia-gn-args.cjs — shared with
// scripts/generate-sbom.mjs, which evaluates the same args per platform to
// decide which vendored third-party libs go into the CycloneDX SBOM.
const {
  gnArgs: GN_ARGS,
  cc: CC,
  cxx: CXX,
} = buildGnArgs({
  targetTriple: TARGET_TRIPLE,
  platformName: PLATFORM_NAME,
  hostArch: HOST_ARCH,
  hostLibc: HOST_LIBC,
  env: process.env,
})

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

const OUTPUT_PATH = path.join('out', 'Static')

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

// skia/third_party/highway/BUILD.gn still lists the two sources highway had when the
// wrapper was written in 2021. The highway roll in Skia m152 made hwy/targets.cc call
// hwy::VectorBytes() (targets.cc:754) to tell HWY_SVE_256 and HWY_SVE2_128 apart, and
// that function lives in hwy/per_target.cc, which nothing compiles. The call sits behind
// a plain `if (HWY_ARCH_ARM_A64)` rather than an #if, so every target keeps the reference
// wherever the optimiser does not fold the branch away, and libskia.a ships an undefined
// hwy::VectorBytes(). macOS bundles tolerate that, but dlopen of the Linux .node fails
// with "undefined symbol: _ZN3hwy11VectorBytesEv". Compile the missing source.
// The anchor is a single line because the Windows runners check the submodule out with
// CRLF endings, which a multi-line needle would never match.
const HighwayGNPath = path.join(__dirname, '..', 'skia', 'third_party', 'highway', 'BUILD.gn')
const HIGHWAY_SOURCE_TO_PATCH = `"../externals/highway/hwy/targets.cc",`
const HIGHWAY_SOURCE_ADDED = `"../externals/highway/hwy/per_target.cc",`

const HIGHWAY_GN_CONTENT = readFileSync(HighwayGNPath, 'utf8')
if (!HIGHWAY_GN_CONTENT.includes(HIGHWAY_SOURCE_TO_PATCH)) {
  throw new Error(
    `skia/third_party/highway/BUILD.gn no longer lists ${HIGHWAY_SOURCE_TO_PATCH}. ` +
      `Re-check whether hwy/per_target.cc is compiled upstream now.`,
  )
}
const HIGHWAY_GN_EOL = HIGHWAY_GN_CONTENT.includes('\r\n') ? '\r\n' : '\n'
writeFileSync(
  HighwayGNPath,
  HIGHWAY_GN_CONTENT.replace(
    HIGHWAY_SOURCE_TO_PATCH,
    `${HIGHWAY_SOURCE_ADDED}${HIGHWAY_GN_EOL}    ${HIGHWAY_SOURCE_TO_PATCH}`,
  ),
)
process.once('beforeExit', () => {
  writeFileSync(HighwayGNPath, HIGHWAY_GN_CONTENT)
})

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
// don't know why generated: python3 ../../third_party/externals/icu/scripts/make_data_assembly.py ../../third_party/icu/common/icudtl.dat gen/third_party/icu/icudtl_dat.S
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
