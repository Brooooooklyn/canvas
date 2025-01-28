import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const LLVM_VERSION = readFileSync(join(fileURLToPath(import.meta.url), '..', '..', 'llvm-version'), 'utf-8').trim()

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

execSync(`ninja -C build cxxabi`, {
  stdio: 'inherit',
  cwd: `llvm-project-llvmorg-${LLVM_VERSION}`,
})

execSync(`cp llvm-project-llvmorg-${LLVM_VERSION}/build/lib/libc++abi.a .`, {
  stdio: 'inherit',
})
