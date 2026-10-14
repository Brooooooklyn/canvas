// Generates CycloneDX 1.6 SBOMs for the platform npm packages.
// Sources: Cargo.lock (Rust crates), skia/DEPS (vendored C++ commits),
// scripts/skia-gn-args.cjs (the GN args the real build uses).
//
//   node ./scripts/generate-sbom.mjs --dir npm/linux-x64-gnu [--out path]
//   node ./scripts/generate-sbom.mjs --all    # npm/*/sbom.cdx.json + sbom/sbom-*.cdx.json
//                                           # + sbom/sbom-all.cdx.json (merged, for CI attestation)

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse as parseToml } from 'smol-toml'

const require = createRequire(import.meta.url)
const { buildGnArgs } = require('./skia-gn-args.cjs')

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// npm/<platform> directory name -> Rust target triple used by scripts/build-skia.js
const PLATFORM_TRIPLES = {
  'android-arm64': 'aarch64-linux-android',
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm-gnueabihf': 'armv7-unknown-linux-gnueabihf',
  'linux-arm64-gnu': 'aarch64-unknown-linux-gnu',
  'linux-arm64-musl': 'aarch64-unknown-linux-musl',
  'linux-riscv64-gnu': 'riscv64gc-unknown-linux-gnu',
  'linux-x64-gnu': 'x86_64-unknown-linux-gnu',
  'linux-x64-musl': 'x86_64-unknown-linux-musl',
  'win32-arm64-msvc': 'aarch64-pc-windows-msvc',
  'win32-x64-msvc': 'x86_64-pc-windows-msvc',
}

// Build host simulated per platform, mirroring skia.yaml's runners (win32 on
// windows-latest, darwin on macos-latest arm64, rest on Linux). Native x64
// builds pass no --target, so they map to targetTriple '' — buildGnArgs
// throws on triples build-skia.js is never invoked with.
const PLATFORM_BUILD_HOSTS = {
  'darwin-arm64': { platformName: 'darwin', hostArch: 'arm64', hostLibc: null },
  'darwin-x64': { platformName: 'darwin', hostArch: 'arm64', hostLibc: null },
  'linux-x64-gnu': { platformName: 'linux', hostArch: 'x64', hostLibc: 'glibc', native: true },
  'linux-x64-musl': { platformName: 'linux', hostArch: 'x64', hostLibc: 'musl' },
  'win32-x64-msvc': { platformName: 'win32', hostArch: 'x64', hostLibc: null, native: true },
}

// Vendored Skia libs keyed on the GN args from skia-gn-args.cjs: gnAll/gnAny
// gate enablement, gnDefault is the fallback for args the build never sets
// (skia.gni defaults), depsPath is the skia/DEPS pin.
const SKIA_LIBS = [
  { name: 'expat', depsPath: 'third_party/externals/expat', gnAll: ['skia_use_expat'], license: 'MIT' },
  { name: 'freetype', depsPath: 'third_party/externals/freetype', gnAll: ['skia_use_freetype'], license: 'FTL' },
  // woff2 support (skia_use_freetype_woff2) links brotli, not a separate woff2 library
  {
    name: 'brotli',
    depsPath: 'third_party/externals/brotli',
    gnAny: ['skia_use_freetype_woff2', 'skia_use_libjxl_decode'],
    license: 'MIT',
  },
  { name: 'harfbuzz', depsPath: 'third_party/externals/harfbuzz', gnAll: ['skia_use_harfbuzz'], license: 'MIT' },
  { name: 'icu', depsPath: 'third_party/externals/icu', gnAll: ['skia_use_icu'], license: 'ICU' },
  {
    name: 'libjxl',
    depsPath: 'third_party/externals/libjxl',
    gnAll: ['skia_use_libjxl_decode'],
    license: 'BSD-3-Clause',
  },
  {
    name: 'highway',
    depsPath: 'third_party/externals/highway',
    gnAll: ['skia_use_libjxl_decode'],
    license: 'Apache-2.0',
  },
  {
    name: 'libjpeg-turbo',
    depsPath: 'third_party/externals/libjpeg-turbo',
    gnAny: ['skia_use_libjpeg_turbo_decode', 'skia_use_libjpeg_turbo_encode'],
    licenseExpression: 'BSD-3-Clause AND IJG AND Zlib',
  },
  {
    name: 'libpng',
    depsPath: 'third_party/externals/libpng',
    gnAny: ['skia_use_libpng_decode', 'skia_use_libpng_encode'],
    // unset in skia-gn-args.cjs; skia.gni defaults these to true
    gnDefault: true,
    license: 'libpng-2.0',
  },
  {
    name: 'libwebp',
    depsPath: 'third_party/externals/libwebp',
    gnAny: ['skia_use_libwebp_decode', 'skia_use_libwebp_encode'],
    license: 'BSD-3-Clause',
  },
  { name: 'wuffs', depsPath: 'third_party/externals/wuffs', gnAll: ['skia_use_wuffs'], license: 'Apache-2.0' },
  {
    name: 'zlib',
    depsPath: 'third_party/externals/zlib',
    gnAll: ['skia_use_zlib'],
    // unset in skia-gn-args.cjs; skia.gni defaults it to true
    gnDefault: true,
    license: 'Zlib',
  },
]

function parseArgs(argv) {
  const args = { all: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') args.all = true
    else if (argv[i] === '--dir') args.dir = argv[++i]
    else if (argv[i] === '--out') args.out = argv[++i]
    else throw new Error(`Unknown argument: ${argv[i]}`)
  }
  if (!args.all && !args.dir) {
    throw new Error('Usage: generate-sbom.mjs --dir <npm-platform-dir> --out <path> | --all')
  }
  return args
}

function parseCargoLock(lockPath) {
  const parsed = parseToml(readFileSync(lockPath, 'utf8'))
  return (parsed.package ?? [])
    .filter((p) => p.name && p.version)
    .map((p) => ({ name: p.name, version: p.version, source: p.source ?? null, checksum: p.checksum ?? null }))
}

// Best-effort crate licenses via `cargo metadata`; degrades to {} (crates
// still listed, license omitted) when cargo or the registry cache is absent.
function cargoMetadataLicenses() {
  try {
    const json = execFileSync('cargo', ['metadata', '--locked', '--format-version', '1'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const licenses = {}
    for (const pkg of JSON.parse(json).packages) {
      if (pkg.license) licenses[`${pkg.name}@${pkg.version}`] = pkg.license
    }
    return licenses
  } catch {
    console.warn('warn: cargo metadata unavailable, crate licenses omitted')
    return {}
  }
}

// Parse the `deps` map out of skia/DEPS. Entries look like:
//   "third_party/externals/expat" : "https://chromium.googlesource.com/.../libexpat.git@<sha>",
function parseSkiaDeps() {
  const deps = {}
  const content = readFileSync(join(REPO_ROOT, 'skia', 'DEPS'), 'utf8')
  const depsMatch = content.match(/^deps\s*=\s*\{([\s\S]*)\n\}/m)
  if (!depsMatch) throw new Error('Could not locate deps map in skia/DEPS')
  const entryRe = /["']([^"']+)["']\s*:\s*["']([^"']+)["']/g
  for (const match of depsMatch[1].matchAll(entryRe)) {
    deps[match[1]] = match[2]
  }
  return deps
}

// Evaluates the skia_use_* args for a platform via the same buildGnArgs the
// real build uses (native builds pass targetTriple '', matching skia.yaml).
// Returns Map<name, value>; unset args keep skia.gni defaults (see gnDefault).
function gnArgsFor(platformName, targetTriple) {
  const host = PLATFORM_BUILD_HOSTS[platformName] ?? { platformName: 'linux', hostArch: 'x64', hostLibc: 'glibc' }
  return buildGnArgs({
    targetTriple: host.native ? '' : targetTriple,
    platformName: host.platformName,
    hostArch: host.hostArch,
    hostLibc: host.hostLibc ?? 'glibc',
    env: { ...process.env, ANDROID_NDK_LATEST_HOME: process.env.ANDROID_NDK_LATEST_HOME ?? '/opt/ndk' },
  }).args
}

// 'true'/'false' -> bool; unset arg falls back to its gni default.
function gnEnabled(gn, key, fallback = false) {
  const value = gn.get(key)
  return value === undefined ? fallback : value === 'true'
}

function licenseEntry({ license, licenseExpression }) {
  if (licenseExpression) return { expression: licenseExpression }
  if (license) return { license: { id: license } }
  return null
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// RFC 4122 UUIDv5 (SHA-1, URL namespace) for a deterministic serial number.
function uuidv5(name) {
  const NS = '6ba7b8119dad11d180b400c04fd430c8'
  const hash = createHash('sha1')
    .update(Buffer.concat([Buffer.from(NS, 'hex'), Buffer.from(name, 'utf8')]))
    .digest('hex')
  const b = hash.slice(0, 32).split('')
  b[12] = '5'
  b[16] = ((parseInt(b[16], 16) & 0x3) | 0x8).toString(16)
  const hex = b.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function generateBom(platformDir, platformName) {
  const packageJsonPath = join(platformDir, 'package.json')
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const targetTriple = PLATFORM_TRIPLES[platformName] ?? ''
  // purl: pkg:npm/<urlencoded-scope>/<name>@<version>
  const [pkgScope, ...pkgNameParts] = pkg.name.split('/')
  const metadataPurl = `pkg:npm/${encodeURIComponent(pkgScope)}${
    pkgNameParts.length ? `/${pkgNameParts.map(encodeURIComponent).join('/')}` : ''
  }@${pkg.version}`

  const crates = parseCargoLock(join(REPO_ROOT, 'Cargo.lock'))
  const crateLicenses = cargoMetadataLicenses()
  const gn = gnArgsFor(platformName, targetTriple)
  const skiaDeps = parseSkiaDeps()

  const components = []
  const dependsOn = []

  const nodeFile = readdirSync(platformDir).find((f) => f.endsWith('.node'))
  if (nodeFile) {
    dependsOn.push(nodeFile)
    components.push({
      type: 'file',
      'bom-ref': nodeFile,
      name: nodeFile,
      hashes: [{ alg: 'SHA-256', content: sha256File(join(platformDir, nodeFile)) }],
      purl: `${metadataPurl}#${nodeFile}`,
    })
  } else {
    console.warn(`warn: no .node binary in ${platformDir}, file component omitted`)
  }

  for (const crate of crates) {
    const bomRef = `pkg:cargo/${crate.name}@${crate.version}`
    dependsOn.push(bomRef)
    const component = {
      type: 'library',
      'bom-ref': bomRef,
      name: crate.name,
      version: crate.version,
      purl: bomRef,
      properties: [{ name: 'cdx:rust:source', value: crate.source ?? 'local' }],
    }
    if (crate.checksum) {
      component.hashes = [{ alg: 'SHA-256', content: crate.checksum }]
    }
    const license = crateLicenses[bomRef.replace('pkg:cargo/', '')]
    if (license) component.licenses = [{ expression: license }]
    components.push(component)
  }

  for (const lib of SKIA_LIBS) {
    const enabled =
      (lib.gnAll?.every((key) => gnEnabled(gn, key, lib.gnDefault ?? false)) ?? true) &&
      (lib.gnAny === undefined || lib.gnAny.some((key) => gnEnabled(gn, key, lib.gnDefault ?? false)))
    if (!enabled) continue
    const pinned = skiaDeps[lib.depsPath]
    if (!pinned) {
      console.warn(`warn: ${lib.depsPath} not found in skia/DEPS, skipping ${lib.name}`)
      continue
    }
    const at = pinned.lastIndexOf('@')
    const repoUrl = pinned.slice(0, at)
    const commit = pinned.slice(at + 1)
    const bomRef = `skia-vendored:${lib.name}@${commit}`
    dependsOn.push(bomRef)
    const component = {
      type: 'library',
      'bom-ref': bomRef,
      name: lib.name,
      version: commit,
      purl: `pkg:generic/${lib.name}@${commit}?repository_url=${encodeURIComponent(repoUrl)}`,
      properties: [
        { name: 'cdx:skia:depsPath', value: lib.depsPath },
        { name: 'cdx:skia:repositoryUrl', value: repoUrl },
      ],
    }
    const licenses = licenseEntry(lib)
    if (licenses) component.licenses = [licenses]
    components.push(component)
  }

  const metadataComponent = {
    type: 'application',
    'bom-ref': metadataPurl,
    name: pkg.name,
    version: pkg.version,
    purl: metadataPurl,
    licenses: pkg.license ? [{ license: { id: pkg.license } }] : [],
  }

  return {
    $schema: 'http://cyclonedx.org/schema/bom-1.6.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${uuidv5(`${pkg.name}@${pkg.version} sbom`)}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: {
        components: [
          {
            type: 'application',
            name: 'generate-sbom.mjs',
            group: '@napi-rs/canvas',
            version: pkg.version,
          },
        ],
      },
      component: metadataComponent,
    },
    components,
    dependencies: [{ ref: metadataPurl, dependsOn }],
  }
}

const args = parseArgs(process.argv.slice(2))

if (args.dir) {
  const dir = args.dir
  const platformName = dir.replace(/\/+$/, '').split('/').pop()
  const out = args.out ?? join(dir, 'sbom.cdx.json')
  const bom = generateBom(dir, platformName)
  writeFileSync(out, `${JSON.stringify(bom, null, 2)}\n`)
  console.info(`Wrote ${out} (${bom.components.length} components)`)
} else {
  const npmDir = join(REPO_ROOT, 'npm')
  const sbomDir = join(REPO_ROOT, 'sbom')
  mkdirSync(sbomDir, { recursive: true })
  const boms = []
  for (const platformName of readdirSync(npmDir).sort()) {
    const platformDir = join(npmDir, platformName)
    if (!existsSync(join(platformDir, 'package.json'))) continue
    const bom = generateBom(platformDir, platformName)
    const inPackage = join(platformDir, 'sbom.cdx.json')
    const standalone = join(sbomDir, `sbom-${platformName}.cdx.json`)
    const json = `${JSON.stringify(bom, null, 2)}\n`
    writeFileSync(inPackage, json)
    writeFileSync(standalone, json)
    console.info(`Wrote ${inPackage} and ${standalone} (${bom.components.length} components)`)
    boms.push(bom)
  }
  const merged = mergeBoms(boms)
  const mergedOut = join(sbomDir, 'sbom-all.cdx.json')
  writeFileSync(mergedOut, `${JSON.stringify(merged, null, 2)}\n`)
  console.info(`Wrote ${mergedOut} (${merged.components.length} components)`)
}

// One CycloneDX document covering every platform package, rooted at
// @napi-rs/canvas. CI attests all skia.*.node binaries against it in a single
// actions/attest call, which accepts only one predicate per invocation.
function mergeBoms(boms) {
  const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const rootPurl = `pkg:npm/${encodeURIComponent('@napi-rs')}/${encodeURIComponent('canvas')}@${rootPkg.version}`

  const seen = new Map()
  const components = []
  for (const bom of boms) {
    for (const component of bom.components ?? []) {
      const ref = component['bom-ref']
      const serialized = JSON.stringify(component)
      const key = ref ?? serialized
      if (seen.has(key)) {
        if (ref !== undefined && seen.get(key) !== serialized) {
          console.warn(`warn: bom-ref ${ref} has divergent content across platform SBOMs, keeping first`)
        }
        continue
      }
      seen.set(key, serialized)
      components.push(component)
    }
  }

  const platformRefs = boms.map((bom) => bom.metadata?.component?.['bom-ref']).filter(Boolean)
  const dependencies = [{ ref: rootPurl, dependsOn: platformRefs }]
  for (const bom of boms) {
    for (const dep of bom.dependencies ?? []) {
      dependencies.push(dep)
    }
  }

  return {
    $schema: 'http://cyclonedx.org/schema/bom-1.6.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${uuidv5(`${rootPkg.name}@${rootPkg.version} sbom-all`)}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: {
        components: [
          {
            type: 'application',
            name: 'generate-sbom.mjs',
            group: '@napi-rs/canvas',
            version: rootPkg.version,
          },
        ],
      },
      component: {
        type: 'application',
        'bom-ref': rootPurl,
        name: rootPkg.name,
        version: rootPkg.version,
        purl: rootPurl,
        licenses: rootPkg.license ? [{ license: { id: rootPkg.license } }] : [],
      },
    },
    components,
    dependencies,
  }
}
