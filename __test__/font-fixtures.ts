// Font files the tests make from the fixtures in __test__/fonts.

// Lato with no glyf table: FreeType (portable) opens it, CoreText (system,
// macOS) does not. The tables are kept as they are, only the directory is
// written again.
export function withoutGlyf(font: Buffer): Buffer {
  const tables = []
  for (let i = 0; i < font.readUInt16BE(4); i++) {
    const at = 12 + 16 * i
    if (font.toString('latin1', at, at + 4) !== 'glyf') {
      tables.push({
        entry: font.subarray(at, at + 16),
        data: font.subarray(font.readUInt32BE(at + 8)).subarray(0, font.readUInt32BE(at + 12)),
      })
    }
  }
  const head = Buffer.alloc(12 + 16 * tables.length)
  font.copy(head, 0, 0, 4)
  const selector = Math.floor(Math.log2(tables.length))
  head.writeUInt16BE(tables.length, 4)
  head.writeUInt16BE(16 << selector, 6)
  head.writeUInt16BE(selector, 8)
  head.writeUInt16BE(tables.length * 16 - (16 << selector), 10)
  const parts = [head]
  let offset = head.length
  for (const [i, { entry, data }] of tables.entries()) {
    entry.copy(head, 12 + 16 * i)
    head.writeUInt32BE(offset, 12 + 16 * i + 8)
    const padded = Buffer.alloc((data.length + 3) & ~3)
    data.copy(padded)
    parts.push(padded)
    offset += padded.length
  }
  return Buffer.concat(parts)
}

export interface StaticStyleOptions {
  family: string
  widthClass?: number
  weightClass?: number
  italic?: boolean
  advanceM?: number
}

function sfntTableChecksum(buf: Buffer, offset: number, length: number): number {
  let sum = 0
  const alignedEnd = offset + (length & ~3)
  for (let i = offset; i < alignedEnd; i += 4) {
    sum = (sum + buf.readUInt32BE(i)) >>> 0
  }
  const rem = length & 3
  if (rem > 0) {
    let last = 0
    for (let i = 0; i < rem; i++) {
      last |= buf[alignedEnd + i] << (24 - 8 * i)
    }
    sum = (sum + (last >>> 0)) >>> 0
  }
  return sum
}

function findGlyphId(buf: Buffer, cmapOffset: number, codePoint: number): number {
  const numSubtables = buf.readUInt16BE(cmapOffset + 2)
  for (let i = 0; i < numSubtables; i++) {
    const rec = cmapOffset + 4 + i * 8
    const subOffset = cmapOffset + buf.readUInt32BE(rec + 4)
    if (buf.readUInt16BE(subOffset) !== 4) continue
    const segCount = buf.readUInt16BE(subOffset + 6) / 2
    const endOff = subOffset + 14
    const startOff = endOff + segCount * 2 + 2
    const deltaOff = startOff + segCount * 2
    const rangeOff = deltaOff + segCount * 2
    for (let s = 0; s < segCount; s++) {
      const end = buf.readUInt16BE(endOff + s * 2)
      const start = buf.readUInt16BE(startOff + s * 2)
      if (codePoint >= start && codePoint <= end) {
        const delta = buf.readInt16BE(deltaOff + s * 2)
        const ro = buf.readUInt16BE(rangeOff + s * 2)
        if (ro === 0) {
          return (codePoint + delta) & 0xffff
        }
        const gid = buf.readUInt16BE(rangeOff + s * 2 + ro + (codePoint - start) * 2)
        return gid === 0 ? 0 : (gid + delta) & 0xffff
      }
    }
  }
  throw new Error(`Code point U+${codePoint.toString(16)} not found in cmap format 4`)
}

// Clones a static 4-char-family TTF (such as Lato-Regular.ttf) and patches its
// OS/2 weight/width/italic flags, head.macStyle, name table family occurrences,
// optional 'M' advance width in hmtx, and SFNT checksums in-place (no offsets shift).
export function withStaticStyle(font: Buffer, options: StaticStyleOptions): Buffer {
  const { family, widthClass, weightClass, italic, advanceM } = options
  if (family.length !== 4) {
    throw new Error(`withStaticStyle requires a 4-char family name, got "${family}"`)
  }
  const buf = Buffer.from(font)
  const numTables = buf.readUInt16BE(4)
  const tables = new Map<string, { entryOffset: number; offset: number; length: number }>()
  for (let i = 0; i < numTables; i++) {
    const entryOffset = 12 + 16 * i
    const tag = buf.toString('latin1', entryOffset, entryOffset + 4)
    tables.set(tag, {
      entryOffset,
      offset: buf.readUInt32BE(entryOffset + 8),
      length: buf.readUInt32BE(entryOffset + 12),
    })
  }

  const os2 = tables.get('OS/2')
  const head = tables.get('head')
  const name = tables.get('name')
  if (!os2 || !head || !name) {
    throw new Error('withStaticStyle requires OS/2, head, and name tables')
  }

  if (weightClass !== undefined) {
    buf.writeUInt16BE(weightClass, os2.offset + 4)
  }
  if (widthClass !== undefined) {
    buf.writeUInt16BE(widthClass, os2.offset + 6)
  }
  if (italic !== undefined) {
    let fsSelection = buf.readUInt16BE(os2.offset + 62)
    let macStyle = buf.readUInt16BE(head.offset + 44)
    if (italic) {
      fsSelection = (fsSelection | 0x0001) & ~0x0040
      macStyle |= 0x0002
    } else {
      fsSelection = (fsSelection & ~0x0001) | 0x0040
      macStyle &= ~0x0002
    }
    buf.writeUInt16BE(fsSelection, os2.offset + 62)
    buf.writeUInt16BE(macStyle, head.offset + 44)
  }

  // Replace ASCII / UTF-16BE occurrences of "Lato" in family/full/PostScript name records.
  const count = buf.readUInt16BE(name.offset + 2)
  const stringStorage = name.offset + buf.readUInt16BE(name.offset + 4)
  const targetIds = new Set([1, 3, 4, 6, 16])
  const srcAscii = Buffer.from('Lato', 'latin1')
  const dstAscii = Buffer.from(family, 'latin1')
  const srcUtf16 = Buffer.from([0, 0x4c, 0, 0x61, 0, 0x74, 0, 0x6f])
  const dstUtf16 = Buffer.alloc(8)
  for (let i = 0; i < 4; i++) {
    dstUtf16.writeUInt16BE(family.charCodeAt(i), i * 2)
  }
  for (let i = 0; i < count; i++) {
    const rec = name.offset + 6 + i * 12
    const platformId = buf.readUInt16BE(rec)
    const nameId = buf.readUInt16BE(rec + 6)
    if (!targetIds.has(nameId)) continue
    const len = buf.readUInt16BE(rec + 8)
    const off = buf.readUInt16BE(rec + 10)
    const slice = buf.subarray(stringStorage + off, stringStorage + off + len)
    if (platformId === 0 || platformId === 3) {
      let pos = 0
      while ((pos = slice.indexOf(srcUtf16, pos)) !== -1) {
        if ((pos & 1) === 0) {
          dstUtf16.copy(slice, pos)
          pos += srcUtf16.length
        } else {
          pos += 1
        }
      }
    } else {
      let pos = 0
      while ((pos = slice.indexOf(srcAscii, pos)) !== -1) {
        dstAscii.copy(slice, pos)
        pos += srcAscii.length
      }
    }
  }

  if (advanceM !== undefined) {
    const cmap = tables.get('cmap')
    const hhea = tables.get('hhea')
    const hmtx = tables.get('hmtx')
    if (!cmap || !hhea || !hmtx) {
      throw new Error('withStaticStyle advanceM requires cmap, hhea, and hmtx tables')
    }
    const gid = findGlyphId(buf, cmap.offset, 0x4d)
    const numLongMetrics = buf.readUInt16BE(hhea.offset + 34)
    if (gid >= numLongMetrics) {
      throw new Error(`Glyph ID ${gid} exceeds numOfLongHorMetrics ${numLongMetrics}`)
    }
    buf.writeUInt16BE(advanceM, hmtx.offset + gid * 4)
  }

  // Recompute per-table checksums and head.checkSumAdjustment.
  buf.writeUInt32BE(0, head.offset + 8)
  for (const { entryOffset, offset, length } of tables.values()) {
    buf.writeUInt32BE(sfntTableChecksum(buf, offset, length), entryOffset + 4)
  }
  const totalChecksum = sfntTableChecksum(buf, 0, buf.length)
  buf.writeUInt32BE((0xb1b0afba - totalChecksum) >>> 0, head.offset + 8)
  return buf
}
