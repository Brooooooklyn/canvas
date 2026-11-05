import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..')

const LLVM_VERSION = readFileSync(join(REPO_ROOT, 'llvm-version'), 'utf-8').trim()

const TARGET = process.argv
  .slice(2)
  .find((arg) => arg.startsWith('--target='))
  ?.replace('--target=', '')

if (TARGET && TARGET !== 'armv7-unknown-linux-gnueabihf') {
  throw new TypeError(`[${TARGET}] is not a supported target`)
}

execSync(`wget https://github.com/llvm/llvm-project/archive/refs/tags/llvmorg-${LLVM_VERSION}.zip`, {
  stdio: 'inherit',
})

execSync(`unzip llvmorg-${LLVM_VERSION}.zip`, {
  stdio: 'inherit',
})

execSync(`mkdir -p build`, {
  stdio: 'inherit',
  cwd: `llvm-project-llvmorg-${LLVM_VERSION}`,
})

if (TARGET) {
  buildArmv7()
} else {
  buildHost()
}

function buildHost() {
  execSync(
    `cmake -G Ninja -S runtimes -B build -DCMAKE_BUILD_TYPE=Release -DLLVM_ENABLE_RUNTIMES="libcxx;libcxxabi;libunwind" -DLIBCXX_ENABLE_LOCALIZATION=OFF`,
    {
      stdio: 'inherit',
      cwd: `llvm-project-llvmorg-${LLVM_VERSION}`,
      env: {
        ...process.env,
        CXX: 'clang++',
        CC: 'clang',
        CXXFLAGS: '-fPIC',
      },
    },
  )

  execSync(`ninja -C build cxx cxxabi`, {
    stdio: 'inherit',
    cwd: `llvm-project-llvmorg-${LLVM_VERSION}`,
  })

  execSync(`cp llvm-project-llvmorg-${LLVM_VERSION}/build/lib/libc++abi.a .`, {
    stdio: 'inherit',
  })

  execSync(`cp llvm-project-llvmorg-${LLVM_VERSION}/build/lib/libc++.a .`, {
    stdio: 'inherit',
  })
}

// Static libc++ (with libc++abi merged in) for armv7, built against the
// napi-cross glibc 2.17 sysroot that skia.yaml unpacks to
// /usr/armv7-unknown-linux-gnueabihf. libskia and the canvas addon use these
// headers and this library; skia.yaml uploads the tarball as a release asset.
function buildArmv7() {
  const toolchain = '/usr/armv7-unknown-linux-gnueabihf'
  const prefix = `${toolchain}/lib/llvm-19`
  // Same CPU flags as scripts/skia-gn-args.cjs and build.rs: the napi-cross
  // GCC defaults (armv7-a, vfpv3-d16, hard float, Thumb). Without -mfpu
  // clang turns on NEON.
  const flags = `--gcc-toolchain=${toolchain} -march=armv7-a -mfpu=vfpv3-d16 -mfloat-abi=hard -mthumb`
  const cmakeArgs = [
    '-G Ninja',
    '-S runtimes',
    '-B build',
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_INSTALL_PREFIX=${prefix}`,
    '-DLLVM_ENABLE_RUNTIMES="libcxx;libcxxabi"',
    '-DCMAKE_SYSTEM_NAME=Linux',
    '-DCMAKE_SYSTEM_PROCESSOR=armv7',
    '-DCMAKE_C_COMPILER=clang-19',
    '-DCMAKE_CXX_COMPILER=clang++-19',
    `-DCMAKE_C_COMPILER_TARGET=${TARGET}`,
    `-DCMAKE_CXX_COMPILER_TARGET=${TARGET}`,
    `-DCMAKE_SYSROOT=${toolchain}/${TARGET}/sysroot`,
    `-DCMAKE_C_FLAGS="${flags}"`,
    `-DCMAKE_CXX_FLAGS="${flags}"`,
    '-DCMAKE_AR=/usr/bin/llvm-ar-19',
    '-DCMAKE_RANLIB=/usr/bin/llvm-ranlib-19',
    '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
    '-DLLVM_ENABLE_PER_TARGET_RUNTIME_DIR=OFF',
    '-DLLVM_INCLUDE_TESTS=OFF',
    '-DLIBCXX_INCLUDE_BENCHMARKS=OFF',
    '-DLIBCXX_ENABLE_SHARED=OFF',
    '-DLIBCXXABI_ENABLE_SHARED=OFF',
    // Puts libc++abi into libc++.a, so build.rs links only `static=c++`.
    '-DLIBCXX_ENABLE_STATIC_ABI_LIBRARY=ON',
    // The unwinder is the GCC 4.8.5 libgcc_s from napi-cross. ON needs
    // libunwind in LLVM_ENABLE_RUNTIMES.
    '-DLIBCXXABI_USE_LLVM_UNWINDER=OFF',
    // No CMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY: the
    // __cxa_thread_atexit_impl check has to link against glibc 2.17 and fail,
    // so libc++abi uses its weak fallback instead of needing GLIBC_2.18.
  ]

  execSync(`cmake ${cmakeArgs.join(' ')}`, {
    stdio: 'inherit',
    cwd: `llvm-project-llvmorg-${LLVM_VERSION}`,
  })

  execSync(`cmake --build build`, {
    stdio: 'inherit',
    cwd: `llvm-project-llvmorg-${LLVM_VERSION}`,
  })

  execSync(`cmake --install build`, {
    stdio: 'inherit',
    cwd: `llvm-project-llvmorg-${LLVM_VERSION}`,
  })

  execSync(`tar -C ${prefix} -czf ${join(REPO_ROOT, 'libc++-linux-armv7-gnueabihf.tar.gz')} include lib`, {
    stdio: 'inherit',
  })
}
