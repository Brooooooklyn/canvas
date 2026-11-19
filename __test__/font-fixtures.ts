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
