import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

// Issue #1405: a Linux .node must bind its own calls to its own code.
// rustc exports the cxx runtime (cxxbridge1$string$drop, ...) from the
// addon, and Electron exports the same names. Without -Bsymbolic, ld.so
// sends canvas's calls to the host's copy, and canvas frees its memory
// with Chromium's allocator. This reads the ELF itself, so it needs no
// binutils in the node:*-slim test images and works for any arch.

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..')

const SHT_RELA = 4
const SHT_DYNAMIC = 6
const SHT_REL = 9
const SHT_DYNSYM = 11
const DT_NULL = 0n
const DT_SYMBOLIC = 16n
const DT_FLAGS = 30n
const DF_SYMBOLIC = 0x2n
const STB_GLOBAL = 1
const STB_WEAK = 2

interface Section {
  type: number
  offset: number
  size: number
  link: number
  entsize: number
}

function readElf(buf: Buffer) {
  if (buf.readUInt32BE(0) !== 0x7f454c46) throw new Error('not an ELF file')
  const is64 = buf[4] === 2
  const le = buf[5] === 1
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o))
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
  const u64 = (o: number) => (le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o))
  // An address-sized field.
  const addr = (o: number) => (is64 ? u64(o) : BigInt(u32(o)))

  const shoff = Number(addr(is64 ? 0x28 : 0x20))
  const shentsize = u16(is64 ? 0x3a : 0x2e)
  const shnum = u16(is64 ? 0x3c : 0x30)
  const sections: Section[] = []
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize
    sections.push({
      type: u32(o + 4),
      offset: Number(addr(o + (is64 ? 0x18 : 0x10))),
      size: Number(addr(o + (is64 ? 0x20 : 0x14))),
      link: u32(o + (is64 ? 0x28 : 0x18)),
      entsize: Number(addr(o + (is64 ? 0x38 : 0x24))),
    })
  }

  const cstr = (o: number) => buf.toString('latin1', o, buf.indexOf(0, o))

  // .dynsym: name, whether this file defines it.
  const dynsymIndex = sections.findIndex((s) => s.type === SHT_DYNSYM)
  if (dynsymIndex < 0) throw new Error('no .dynsym')
  const dynsym = sections[dynsymIndex]
  const strtab = sections[dynsym.link]
  const symbols = []
  for (let o = dynsym.offset; o < dynsym.offset + dynsym.size; o += dynsym.entsize) {
    const name = cstr(strtab.offset + u32(o))
    const info = buf[o + (is64 ? 4 : 12)]
    const shndx = u16(o + (is64 ? 6 : 14))
    const bind = info >> 4
    symbols.push({ name, defined: shndx !== 0 && (bind === STB_GLOBAL || bind === STB_WEAK) })
  }

  // DT_FLAGS & DF_SYMBOLIC, or the older DT_SYMBOLIC entry.
  let symbolic = false
  const dynamic = sections.find((s) => s.type === SHT_DYNAMIC)
  if (!dynamic) throw new Error('no .dynamic')
  const dynent = is64 ? 16 : 8
  for (let o = dynamic.offset; o < dynamic.offset + dynamic.size; o += dynent) {
    const tag = is64 ? u64(o) : BigInt(u32(o))
    const val = addr(o + (is64 ? 8 : 4))
    if (tag === DT_NULL) break
    if (tag === DT_SYMBOLIC || (tag === DT_FLAGS && (val & DF_SYMBOLIC) !== 0n)) symbolic = true
  }

  // Every symbol a dynamic relocation names (.rela.dyn, .rela.plt, .rel.*).
  const relocated = new Set<string>()
  for (const s of sections) {
    if ((s.type !== SHT_REL && s.type !== SHT_RELA) || s.link !== dynsymIndex) continue
    const entsize = s.entsize || (is64 ? 8 : 4) * (s.type === SHT_RELA ? 3 : 2)
    for (let o = s.offset; o < s.offset + s.size; o += entsize) {
      const info = addr(o + (is64 ? 8 : 4))
      const sym = Number(is64 ? info >> 32n : info >> 8n)
      if (sym !== 0) relocated.add(symbols[sym].name)
    }
  }

  const exported = new Set(symbols.filter((s) => s.defined && s.name).map((s) => s.name))
  return { symbolic, exported, relocated }
}

const binaries = readdirSync(ROOT).filter((f) => /^skia\.linux-.+\.node$/.test(f))

if (binaries.length === 0) {
  test.skip('Linux .node binds its own symbols (no skia.linux-*.node built)', () => {})
}

for (const file of binaries) {
  test(`${file} binds its own symbols (-Bsymbolic, #1405)`, (t) => {
    const { symbolic, exported, relocated } = readElf(readFileSync(join(ROOT, file)))
    t.true(symbolic, 'DT_FLAGS has no SYMBOLIC: link with -Wl,-Bsymbolic')
    t.true(exported.has('napi_register_module_v1'), 'napi_register_module_v1 is not exported')
    // With -Bsymbolic the linker resolves these at link time; a dynamic
    // relocation against one of them is a slot the host can take over.
    t.deepEqual(
      [...exported].filter((name) => relocated.has(name)),
      [],
      'own exports still bound through a dynamic relocation',
    )
  })
}
