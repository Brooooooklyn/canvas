// Generates CycloneDX 1.6 SBOMs (sbom.cdx.json) for the platform npm packages.
// Sources of truth:
//   - Cargo.lock          -> resolved Rust crates statically linked into the .node binary
//   - skia/DEPS           -> vendored third-party C/C++ libraries pinned to commits
//   - scripts/build-skia.js -> GN args that decide which vendored libs are enabled per target
// No external dependencies; Cargo.lock is parsed with a minimal [[package]] block parser.
//
// Usage:
//   node ./scripts/generate-sbom.mjs --dir npm/linux-x64-gnu --out /tmp/sbom.cdx.json
//   node ./scripts/generate-sbom.mjs --all
//
// --all iterates npm/*/ and writes:
//   npm/<platform>/sbom.cdx.json            (shipped inside the npm tarball via package.json "files")
//   sbom/sbom-<platform>.cdx.json           (repo root, for release-asset attachment)

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// Vendored Skia third-party libs enabled by the GN args in scripts/build-skia.js.
// `gn` keys are skia_use_* / skia_enable_* args; `gnAll` requires every key to be
// truthy, `gnAny` requires at least one. `depsPath` is the key in skia/DEPS that
// pins repo+commit.
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
    license: 'libpng-2.0',
  },
  {
    name: 'libwebp',
    depsPath: 'third_party/externals/libwebp',
    gnAny: ['skia_use_libwebp_decode', 'skia_use_libwebp_encode'],
    license: 'BSD-3-Clause',
  },
  { name: 'wuffs', depsPath: 'third_party/externals/wuffs', gnAll: ['skia_use_wuffs'], license: 'Apache-2.0' },
  { name: 'zlib', depsPath: 'third_party/externals/zlib', gnAll: ['skia_use_zlib'], license: 'Zlib' },
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

// Minimal TOML parse of Cargo.lock [[package]] blocks: name, version, source, checksum.
function parseCargoLock(lockPath) {
  const content = readFileSync(lockPath, 'utf8')
  const packages = []
  for (const block of content.split('[[package]]').slice(1)) {
    const get = (key) => {
      const match = block.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'))
      return match ? match[1] : null
    }
    const name = get('name')
    const version = get('version')
    if (name && version) {
      packages.push({ name, version, source: get('source'), checksum: get('checksum') })
    }
  }
  return packages
}

// Best-effort license lookup via `cargo metadata` (reads the local registry cache or
// manifest files). Returns {} when cargo or the dependency cache is unavailable —
// crates in Cargo.lock are still listed, just without a license field.
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

// Evaluate the skia_use_*/skia_enable_* GN args declared in scripts/build-skia.js.
// Args are template literals like `skia_use_icu=true` or
// `skia_use_libjxl_decode=${!TARGET_TRIPLE.startsWith('riscv64')}` — evaluate the
// ${...} against the target triple for the platform being generated. Args that
// build-skia.js does not set keep their declare_args() default from
// skia/gn/skia.gni (e.g. skia_use_libpng_* and skia_use_zlib default to true);
// only literal true/false defaults are read, expression defaults stay unset.
function parseGnArgs(targetTriple) {
  const source = readFileSync(join(REPO_ROOT, 'scripts', 'build-skia.js'), 'utf8')
  const arrayMatch = source.match(/const GN_ARGS = \[([\s\S]*?)\n\]/)
  if (!arrayMatch) throw new Error('Could not locate GN_ARGS in scripts/build-skia.js')
  const gn = {}
  const gniSource = readFileSync(join(REPO_ROOT, 'skia', 'gn', 'skia.gni'), 'utf8')
  for (const block of gniSource.matchAll(/declare_args\(\)\s*\{([\s\S]*?)\n\}/g)) {
    for (const m of block[1].matchAll(/^\s*(\w+)\s*=\s*(true|false)\s*(?:#.*)?$/gm)) {
      gn[m[1]] = m[2] === 'true'
    }
  }
  // Interpolations in GN_ARGS may reference TARGET_TRIPLE or
  // PDF_HARFBUZZ_SUBSET_ENABLED; mirror the latter's computation from
  // scripts/build-skia.js (musl + win-x64 targets disable harfbuzz subsetting).
  const pdfHarfbuzzSubsetEnabled = !new Set([
    'x86_64-pc-windows-msvc',
    'x86_64-unknown-linux-musl',
    'aarch64-unknown-linux-musl',
  ]).has(targetTriple)
  const lineRe = /`(\w+)=([^`]*)`/g
  for (const match of arrayMatch[1].matchAll(lineRe)) {
    const [, key, rawValue] = match
    let value = rawValue
    if (value.includes('${')) {
      value = new Function('TARGET_TRIPLE', 'PDF_HARFBUZZ_SUBSET_ENABLED', `return \`${value}\``)(
        targetTriple,
        pdfHarfbuzzSubsetEnabled,
      )
    }
    gn[key] = value === 'true' ? true : value === 'false' ? false : value
  }
  return gn
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
  // purl: pkg:npm/<urlencoded-scope>/<name>@<version> — the scope/name slash stays literal
  const [pkgScope, ...pkgNameParts] = pkg.name.split('/')
  const metadataPurl = `pkg:npm/${encodeURIComponent(pkgScope)}${
    pkgNameParts.length ? `/${pkgNameParts.map(encodeURIComponent).join('/')}` : ''
  }@${pkg.version}`

  const crates = parseCargoLock(join(REPO_ROOT, 'Cargo.lock'))
  const crateLicenses = cargoMetadataLicenses()
  const gn = parseGnArgs(targetTriple)
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
      (lib.gnAll?.every((key) => gn[key] === true) ?? true) &&
      (lib.gnAny === undefined || lib.gnAny.some((key) => gn[key] === true))
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

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.dir) {
    const dir = args.dir
    const platformName = dir.replace(/\/+$/, '').split('/').pop()
    const out = args.out ?? join(dir, 'sbom.cdx.json')
    const bom = generateBom(dir, platformName)
    writeFileSync(out, `${JSON.stringify(bom, null, 2)}\n`)
    console.info(`Wrote ${out} (${bom.components.length} components)`)
    return
  }

  const npmDir = join(REPO_ROOT, 'npm')
  const sbomDir = join(REPO_ROOT, 'sbom')
  mkdirSync(sbomDir, { recursive: true })
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
  }
}

main()
