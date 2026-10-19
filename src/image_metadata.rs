//! The resolution and text metadata that toBuffer, encode and encodeSync
//! write into PNG and JPEG output (no Chrome counterpart). Skia's encoders
//! have no option for a PNG pHYs chunk or a JFIF density, so the encoded
//! bytes are patched here: PNG gets chunks before the first IDAT, JPEG gets
//! its JFIF density set and XMP / COM segments after the JFIF APP0.
//!
//! `resolution` follows node-canvas's PngConfig.resolution: pixels per inch,
//! written as px/m = round(ppi * 39.3701) (node-canvas PNG.h). As there, a
//! member counts only when it is a number or a string; nothing is converted.

use std::{ffi::CStr, ptr};

use napi::bindgen_prelude::*;

use crate::{encoding::ImageType, webidl};

/// The text members, in read and write order, with their PNG keywords.
const TEXT: [(&CStr, &str); 6] = [
  (c"title", "Title"),
  (c"author", "Author"),
  (c"description", "Description"),
  (c"copyright", "Copyright"),
  (c"software", "Software"),
  (c"comment", "Comment"),
];
const COMMENT: usize = 5;

/// node-canvas's inches to metres factor (PNG.h).
const PX_PER_M_PER_INCH: f64 = 39.3701;
/// The largest PNG chunk length and pHYs value (2^31 - 1).
const PNG_MAX: u32 = 0x7FFF_FFFF;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
/// The largest JFIF density.
const JFIF_MAX: u32 = 65535;
/// SOI, then the 16-byte JFIF APP0 libjpeg-turbo always writes for YCbCr
/// and grayscale (jcmarker.c emit_jfif_app0).
const JFIF_HEAD: &[u8] = b"\xFF\xD8\xFF\xE0\x00\x10JFIF\x00";
const JFIF_END: usize = 20;
/// The APP1 signature of an XMP packet (Skia's kXMPStandardSig).
const XMP_SIG: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
/// The most a JPEG segment holds after its 2 length bytes.
const SEGMENT_MAX: usize = 65533;
const XMP_MAX: usize = SEGMENT_MAX - XMP_SIG.len();

/// The XMP elements of title, author, description, copyright and software.
const XMP_ELEMENTS: [(&str, &str); 5] = [
  (
    "<dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">",
    "</rdf:li></rdf:Alt></dc:title>",
  ),
  (
    "<dc:creator><rdf:Seq><rdf:li>",
    "</rdf:li></rdf:Seq></dc:creator>",
  ),
  (
    "<dc:description><rdf:Alt><rdf:li xml:lang=\"x-default\">",
    "</rdf:li></rdf:Alt></dc:description>",
  ),
  (
    "<dc:rights><rdf:Alt><rdf:li xml:lang=\"x-default\">",
    "</rdf:li></rdf:Alt></dc:rights>",
  ),
  ("<xmp:CreatorTool>", "</xmp:CreatorTool>"),
];
const XMP_HEAD: &str = concat!(
  "<?xpacket begin=\"\u{FEFF}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n",
  "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n",
  "<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n",
  "<rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" ",
  "xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\">\n",
);
const XMP_TAIL: &str = "</rdf:Description>\n</rdf:RDF>\n</x:xmpmeta>\n<?xpacket end=\"w\"?>";

/// The metadata members of a Node export method's options object.
#[derive(Default)]
pub(crate) struct ImageMetadata {
  /// Pixels per inch.
  resolution: Option<u32>,
  /// title, author, description, copyright, software, comment.
  text: [Option<String>; 6],
}

impl ImageMetadata {
  /// Reads resolution, then the text members, once each, from `object`. A
  /// member that is not a number (resolution) or a string (text) is missing;
  /// an exception from a getter is passed on.
  pub(crate) unsafe fn read(env: sys::napi_env, object: sys::napi_value) -> Result<Self> {
    let member = |key: &CStr| -> Result<sys::napi_value> {
      let mut value = ptr::null_mut();
      check_status!(unsafe {
        sys::napi_get_named_property(env, object, key.as_ptr(), &mut value)
      })?;
      Ok(value)
    };
    let mut metadata = Self::default();
    let resolution = member(c"resolution")?;
    if webidl::type_of(env, resolution)? == ValueType::Number {
      metadata.resolution = ppi(unsafe { f64::from_napi_value(env, resolution)? });
    }
    for (slot, (key, _)) in metadata.text.iter_mut().zip(TEXT) {
      let value = member(key)?;
      if webidl::type_of(env, value)? == ValueType::String {
        *slot = clean(&unsafe { String::from_napi_value(env, value)? });
      }
    }
    Ok(metadata)
  }

  /// What to write for `ty`. Err: a JPEG segment that cannot hold the text,
  /// as a RangeError message.
  pub(crate) fn plan(&self, ty: ImageType) -> std::result::Result<MetadataPatch, String> {
    if self.resolution.is_none() && self.text.iter().all(Option::is_none) {
      return Ok(MetadataPatch::None);
    }
    match ty {
      ImageType::Png => {
        let mut chunks = Vec::new();
        if let Some(ppi) = self.resolution {
          let ppm = (f64::from(ppi) * PX_PER_M_PER_INCH)
            .round()
            .min(f64::from(PNG_MAX)) as u32;
          let mut data = [0; 9];
          data[..4].copy_from_slice(&ppm.to_be_bytes());
          data[4..8].copy_from_slice(&ppm.to_be_bytes());
          // The unit: the metre.
          data[8] = 1;
          png_chunk(&mut chunks, b"pHYs", &[&data]);
        }
        for ((_, keyword), text) in TEXT.iter().zip(&self.text) {
          if let Some(text) = text {
            png_text_chunk(&mut chunks, keyword, text)?;
          }
        }
        Ok(MetadataPatch::Png {
          chunks,
          phys: self.resolution.is_some(),
        })
      }
      ImageType::Jpeg => {
        let density = self.resolution.map(|ppi| ppi.min(JFIF_MAX) as u16);
        let mut segments = Vec::new();
        if let Some(packet) = xmp_packet(&self.text[..COMMENT]) {
          if packet.len() > XMP_MAX {
            return Err(format!(
              "The JPEG XMP metadata is {} bytes; one APP1 segment holds at most {XMP_MAX}.",
              packet.len()
            ));
          }
          jpeg_segment(&mut segments, 0xE1, &[XMP_SIG, packet.as_bytes()]);
        }
        if let Some(comment) = &self.text[COMMENT] {
          if comment.len() > SEGMENT_MAX {
            return Err(format!(
              "The JPEG comment is {} bytes; one COM segment holds at most {SEGMENT_MAX}.",
              comment.len()
            ));
          }
          jpeg_segment(&mut segments, 0xFE, &[comment.as_bytes()]);
        }
        if density.is_none() && segments.is_empty() {
          return Ok(MetadataPatch::None);
        }
        Ok(MetadataPatch::Jpeg { density, segments })
      }
      ImageType::Webp | ImageType::Avif | ImageType::Gif => Ok(MetadataPatch::None),
    }
  }
}

/// What `ImageMetadata::plan` gives: the bytes to put into the encoded image.
pub(crate) enum MetadataPatch {
  None,
  Png {
    chunks: Vec<u8>,
    /// A pHYs chunk is among `chunks`.
    phys: bool,
  },
  Jpeg {
    density: Option<u16>,
    segments: Vec<u8>,
  },
}

impl MetadataPatch {
  /// `encoded` with the metadata, or None when the encoder's output does not
  /// have the layout the patch needs.
  pub(crate) fn apply(&self, encoded: &[u8]) -> Option<Vec<u8>> {
    match self {
      Self::None => Some(encoded.to_vec()),
      Self::Png { chunks, phys } => splice_png(encoded, chunks, *phys),
      Self::Jpeg { density, segments } => splice_jpeg(encoded, *density, segments),
    }
  }
}

/// The resolution: a finite number whose integer part is at least 1, as
/// node-canvas's Uint32Value drops the fraction; a larger one than u32 holds
/// is u32::MAX.
fn ppi(value: f64) -> Option<u32> {
  let ppi = value.trunc();
  (ppi.is_finite() && ppi >= 1.0).then(|| ppi.min(f64::from(u32::MAX)) as u32)
}

/// A text member without U+0000; nothing when that leaves it empty.
fn clean(text: &str) -> Option<String> {
  let text = text.replace('\0', "");
  (!text.is_empty()).then_some(text)
}

const fn crc_table() -> [u32; 256] {
  let mut table = [0; 256];
  let mut n = 0;
  while n < 256 {
    let mut c = n as u32;
    let mut k = 0;
    while k < 8 {
      c = if c & 1 != 0 {
        0xEDB8_8320 ^ (c >> 1)
      } else {
        c >> 1
      };
      k += 1;
    }
    table[n] = c;
    n += 1;
  }
  table
}

static CRC_TABLE: [u32; 256] = crc_table();

/// The PNG CRC-32 of `parts`, one after the other.
fn crc32(parts: &[&[u8]]) -> u32 {
  let mut crc = 0xFFFF_FFFF_u32;
  for &byte in parts.iter().flat_map(|part| part.iter()) {
    crc = CRC_TABLE[((crc ^ u32::from(byte)) & 0xFF) as usize] ^ (crc >> 8);
  }
  crc ^ 0xFFFF_FFFF
}

/// Appends a chunk with `data` (the concatenated parts). The caller keeps
/// the data at most PNG_MAX bytes.
fn png_chunk(out: &mut Vec<u8>, ty: &[u8; 4], data: &[&[u8]]) {
  let len: usize = data.iter().map(|part| part.len()).sum();
  out.extend_from_slice(&(len as u32).to_be_bytes());
  out.extend_from_slice(ty);
  for part in data {
    out.extend_from_slice(part);
  }
  let mut parts = Vec::with_capacity(data.len() + 1);
  parts.push(&ty[..]);
  parts.extend_from_slice(data);
  out.extend_from_slice(&crc32(&parts).to_be_bytes());
}

/// tEXt when every character is one tEXt defines (LF and printable
/// Latin-1), else iTXt, uncompressed, with UTF-8 text and no language tag.
fn png_text_chunk(out: &mut Vec<u8>, keyword: &str, text: &str) -> std::result::Result<(), String> {
  let latin1 = text
    .chars()
    .all(|c| matches!(c, '\n' | ' '..='~' | '\u{A0}'..='\u{FF}'));
  let (ty, head, body): (&[u8; 4], &[u8], Vec<u8>) = if latin1 {
    (b"tEXt", &[0], text.chars().map(|c| c as u8).collect())
  } else {
    // Keyword NUL, compression flag 0, method 0, empty language tag and
    // translated keyword, each NUL-terminated.
    (b"iTXt", &[0; 5], text.as_bytes().to_vec())
  };
  let len = keyword.len() + head.len() + body.len();
  if len > PNG_MAX as usize {
    return Err(format!(
      "The PNG {keyword} text is {len} bytes; one PNG chunk holds at most {PNG_MAX}."
    ));
  }
  png_chunk(out, ty, &[keyword.as_bytes(), head, &body]);
  Ok(())
}

/// `text` as XML character data: without the characters XML 1.0 cannot
/// hold, and with &, <, > and CR escaped.
fn xml_text(out: &mut String, text: &str) {
  for c in text.chars() {
    match c {
      '&' => out.push_str("&amp;"),
      '<' => out.push_str("&lt;"),
      '>' => out.push_str("&gt;"),
      '\r' => out.push_str("&#xD;"),
      '\u{1}'..='\u{8}' | '\u{B}' | '\u{C}' | '\u{E}'..='\u{1F}' | '\u{FFFE}' | '\u{FFFF}' => {}
      c => out.push(c),
    }
  }
}

/// The XMP packet of title, author, description, copyright and software,
/// one element a line; None without any.
fn xmp_packet(text: &[Option<String>]) -> Option<String> {
  let mut body = String::new();
  for ((open, close), text) in XMP_ELEMENTS.iter().zip(text) {
    let Some(text) = text else { continue };
    let mut value = String::new();
    xml_text(&mut value, text);
    if value.is_empty() {
      continue;
    }
    body.push_str(open);
    body.push_str(&value);
    body.push_str(close);
    body.push('\n');
  }
  (!body.is_empty()).then(|| format!("{XMP_HEAD}{body}{XMP_TAIL}"))
}

/// Appends a marker segment with `data` (at most SEGMENT_MAX bytes in all).
fn jpeg_segment(out: &mut Vec<u8>, marker: u8, data: &[&[u8]]) {
  let len: usize = data.iter().map(|part| part.len()).sum();
  out.extend_from_slice(&[0xFF, marker]);
  out.extend_from_slice(&((len + 2) as u16).to_be_bytes());
  for part in data {
    out.extend_from_slice(part);
  }
}

/// Puts `chunks` right before the first IDAT. The chunks are walked by their
/// lengths: compressed data (iCCP) can hold the bytes "IDAT".
fn splice_png(encoded: &[u8], chunks: &[u8], phys: bool) -> Option<Vec<u8>> {
  if encoded.get(..PNG_SIGNATURE.len())? != PNG_SIGNATURE {
    return None;
  }
  let mut offset = PNG_SIGNATURE.len();
  loop {
    let header = encoded.get(offset..offset.checked_add(8)?)?;
    let len = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
    let ty = &header[4..8];
    if offset == PNG_SIGNATURE.len() && ty != b"IHDR" {
      return None;
    }
    let end = offset.checked_add(12)?.checked_add(len)?;
    if end > encoded.len() || (phys && ty == b"pHYs") {
      return None;
    }
    if ty == b"IDAT" {
      let mut out = Vec::with_capacity(encoded.len() + chunks.len());
      out.extend_from_slice(&encoded[..offset]);
      out.extend_from_slice(chunks);
      out.extend_from_slice(&encoded[offset..]);
      return Some(out);
    }
    offset = end;
  }
}

/// Sets the JFIF density in dots per inch, and puts `segments` right after
/// the JFIF APP0.
fn splice_jpeg(encoded: &[u8], density: Option<u16>, segments: &[u8]) -> Option<Vec<u8>> {
  if encoded.len() < JFIF_END || !encoded.starts_with(JFIF_HEAD) {
    return None;
  }
  let mut out = Vec::with_capacity(encoded.len() + segments.len());
  out.extend_from_slice(&encoded[..JFIF_END]);
  if let Some(density) = density {
    // Units 1 (dots per inch), then Xdensity and Ydensity.
    out[13] = 1;
    out[14..16].copy_from_slice(&density.to_be_bytes());
    out[16..18].copy_from_slice(&density.to_be_bytes());
  }
  out.extend_from_slice(segments);
  out.extend_from_slice(&encoded[JFIF_END..]);
  Some(out)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
  }

  fn with_resolution(resolution: Option<u32>) -> ImageMetadata {
    ImageMetadata {
      resolution,
      ..Default::default()
    }
  }

  fn with_text(index: usize, text: &str) -> ImageMetadata {
    let mut metadata = ImageMetadata::default();
    metadata.text[index] = clean(text);
    metadata
  }

  fn png_chunks(metadata: &ImageMetadata) -> Vec<u8> {
    match metadata.plan(ImageType::Png).unwrap() {
      MetadataPatch::Png { chunks, .. } => chunks,
      _ => panic!("not a PNG patch"),
    }
  }

  fn jpeg_segments(metadata: &ImageMetadata) -> std::result::Result<Vec<u8>, String> {
    Ok(match metadata.plan(ImageType::Jpeg)? {
      MetadataPatch::Jpeg { segments, .. } => segments,
      MetadataPatch::None => Vec::new(),
      MetadataPatch::Png { .. } => panic!("not a JPEG patch"),
    })
  }

  fn png(chunks: &[(&[u8; 4], &[u8])]) -> Vec<u8> {
    let mut out = PNG_SIGNATURE.to_vec();
    for &(ty, data) in chunks {
      png_chunk(&mut out, ty, &[data]);
    }
    out
  }

  fn chunk_types(png: &[u8]) -> Vec<String> {
    let mut types = Vec::new();
    let mut offset = 8;
    while offset < png.len() {
      let len = u32::from_be_bytes(png[offset..offset + 4].try_into().unwrap()) as usize;
      types.push(String::from_utf8(png[offset + 4..offset + 8].to_vec()).unwrap());
      offset += 12 + len;
    }
    types
  }

  #[test]
  fn crc() {
    assert_eq!(crc32(&[b"IEND"]), 0xAE42_6082);
    assert_eq!(crc32(&[b"IE", b"ND"]), 0xAE42_6082);
  }

  #[test]
  fn phys_bytes_are_node_canvas_bytes() {
    for (ppi, expected) in [
      (1, "00000009704859730000002700000027012a09914f"),
      (72, "000000097048597300000b1300000b1301009a9c18"),
      (96, "000000097048597300000ec400000ec401952b0e1b"),
      (150, "0000000970485973000017120000171201679fd252"),
      (300, "000000097048597300002e2300002e230178a53f76"),
      (600, "000000097048597300005c4600005c460114944341"),
    ] {
      assert_eq!(
        hex(&png_chunks(&with_resolution(Some(ppi)))),
        expected,
        "{ppi}"
      );
    }
  }

  #[test]
  fn phys_clamp() {
    let ppm = |ppi| {
      let chunks = png_chunks(&with_resolution(Some(ppi)));
      (
        u32::from_be_bytes(chunks[8..12].try_into().unwrap()),
        u32::from_be_bytes(chunks[12..16].try_into().unwrap()),
      )
    };
    assert_eq!(ppm(54_546_055), (2_147_483_640, 2_147_483_640));
    assert_eq!(ppm(54_546_056), (PNG_MAX, PNG_MAX));
    assert_eq!(ppm(u32::MAX), (PNG_MAX, PNG_MAX));
  }

  #[test]
  fn ppi_rule() {
    assert_eq!(ppi(300.9), Some(300));
    assert_eq!(ppi(1.0), Some(1));
    assert_eq!(ppi(1e300), Some(u32::MAX));
    for value in [
      0.5,
      0.999,
      0.0,
      -0.0,
      -1.0,
      -300.5,
      f64::NAN,
      f64::INFINITY,
      f64::NEG_INFINITY,
    ] {
      assert_eq!(ppi(value), None, "{value}");
    }
  }

  #[test]
  fn clean_removes_nul() {
    assert_eq!(clean("a\0b").as_deref(), Some("ab"));
    assert_eq!(clean("\0\0"), None);
    assert_eq!(clean(""), None);
    assert_eq!(clean(" ").as_deref(), Some(" "));
  }

  #[test]
  fn text_chunks() {
    assert_eq!(
      hex(&png_chunks(&with_text(0, "Hello"))),
      "0000000b744558745469746c650048656c6c6fcdcfc0cf"
    );
    assert_eq!(
      hex(&png_chunks(&with_text(1, "Zoë"))),
      "0000000a74455874417574686f72005a6feb637ff490"
    );
    assert_eq!(
      hex(&png_chunks(&with_text(0, "画"))),
      "0000000d695458745469746c650000000000e794bb7f285b43"
    );
    for text in ["\n", " ", "~", "\u{A0}", "\u{FF}", "Café ©"] {
      assert_eq!(&png_chunks(&with_text(0, text))[4..8], b"tEXt", "{text:?}");
    }
    for text in [
      "\t", "\r", "\u{1}", "\u{1F}", "\u{7F}", "\u{9F}", "\u{100}", "😀", "\u{FFFD}",
    ] {
      let chunks = png_chunks(&with_text(0, text));
      assert_eq!(&chunks[4..8], b"iTXt", "{text:?}");
      assert_eq!(&chunks[8..18], b"Title\0\0\0\0\0");
      assert_eq!(&chunks[18..chunks.len() - 4], text.as_bytes());
    }
  }

  #[test]
  fn png_chunk_order() {
    let mut metadata = with_resolution(Some(72));
    for (index, text) in ["t", "a", "d", "c", "s", "m"].iter().enumerate() {
      metadata.text[index] = clean(text);
    }
    let chunks = png_chunks(&metadata);
    let mut keywords = Vec::new();
    let mut offset = 0;
    while offset < chunks.len() {
      let len = u32::from_be_bytes(chunks[offset..offset + 4].try_into().unwrap()) as usize;
      let data = &chunks[offset + 8..offset + 8 + len];
      keywords.push(String::from_utf8_lossy(data.split(|&b| b == 0).next().unwrap()).into_owned());
      offset += 12 + len;
    }
    assert_eq!(
      keywords[1..],
      [
        "Title",
        "Author",
        "Description",
        "Copyright",
        "Software",
        "Comment"
      ]
    );
    assert_eq!(&chunks[4..8], b"pHYs");
  }

  #[test]
  fn png_splice() {
    let base = png(&[
      (b"IHDR", &[0; 13]),
      (b"iCCP", b"xIDATx"),
      (b"IDAT", &[1]),
      (b"IDAT", &[2]),
      (b"IEND", &[]),
    ]);
    let chunks = png_chunks(&with_resolution(Some(300)));
    let out = splice_png(&base, &chunks, true).unwrap();
    assert_eq!(
      chunk_types(&out),
      ["IHDR", "iCCP", "pHYs", "IDAT", "IDAT", "IEND"]
    );
    let at = 8 + 25 + 18;
    assert_eq!(&out[..at], &base[..at]);
    assert_eq!(&out[at..at + chunks.len()], &chunks[..]);
    assert_eq!(&out[at + chunks.len()..], &base[at..]);

    // Truncated, no IDAT, a bad signature, IHDR not first, a pHYs already.
    assert!(splice_png(&base[..base.len() - 30], &chunks, true).is_none());
    assert!(splice_png(&base[..40], &chunks, true).is_none());
    assert!(splice_png(&png(&[(b"IHDR", &[0; 13]), (b"IEND", &[])]), &chunks, true).is_none());
    let mut bad = base.clone();
    bad[1] = b'Q';
    assert!(splice_png(&bad, &chunks, true).is_none());
    assert!(
      splice_png(
        &png(&[(b"sRGB", &[0]), (b"IHDR", &[0; 13]), (b"IDAT", &[1])]),
        &chunks,
        true
      )
      .is_none()
    );
    let with_phys = png(&[(b"IHDR", &[0; 13]), (b"pHYs", &[0; 9]), (b"IDAT", &[1])]);
    assert!(splice_png(&with_phys, &chunks, true).is_none());
    // A pHYs is no conflict when only text is written.
    assert!(splice_png(&with_phys, &png_chunks(&with_text(0, "t")), false).is_some());
    // A length that overflows.
    let mut huge = png(&[(b"IHDR", &[0; 13])]);
    huge.extend_from_slice(&[0xFF, 0xFF, 0xFF, 0xFF, b'I', b'D', b'A', b'T']);
    assert!(splice_png(&huge, &chunks, true).is_none());
  }

  #[test]
  fn jpeg_splice() {
    let mut base = b"\xFF\xD8\xFF\xE0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00".to_vec();
    base.extend_from_slice(b"\xFF\xE2\x00\x04ab\xFF\xDB");
    let out = splice_jpeg(&base, Some(300), &[]).unwrap();
    assert_eq!(hex(&out[..20]), "ffd8ffe000104a46494600010101012c012c0000");
    assert_eq!(out.len(), base.len());
    let out = splice_jpeg(&base, None, b"\xFF\xFE\x00\x03c").unwrap();
    assert_eq!(&out[..20], &base[..20]);
    assert_eq!(&out[20..25], b"\xFF\xFE\x00\x03c");
    assert_eq!(&out[25..], &base[20..]);
    assert!(
      splice_jpeg(
        b"\xFF\xD8\xFF\xDB\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00",
        Some(1),
        &[]
      )
      .is_none()
    );
    assert!(splice_jpeg(&base[..19], Some(1), &[]).is_none());
  }

  #[test]
  fn jpeg_density_clamp() {
    let density = |ppi| match with_resolution(Some(ppi)).plan(ImageType::Jpeg).unwrap() {
      MetadataPatch::Jpeg { density, segments } => {
        assert!(segments.is_empty());
        density
      }
      _ => panic!("not a JPEG patch"),
    };
    assert_eq!(density(300), Some(300));
    assert_eq!(density(65535), Some(65535));
    assert_eq!(density(70000), Some(65535));
    assert_eq!(density(u32::MAX), Some(65535));
  }

  #[test]
  fn jpeg_limits() {
    let mut metadata = with_text(2, &"x".repeat(65078));
    let segments = jpeg_segments(&metadata).unwrap();
    assert_eq!(u16::from_be_bytes([segments[2], segments[3]]), 65535);
    metadata.text[2] = Some("x".repeat(65079));
    assert_eq!(
      jpeg_segments(&metadata).unwrap_err(),
      "The JPEG XMP metadata is 65505 bytes; one APP1 segment holds at most 65504."
    );
    // Escaping counts.
    metadata.text[2] = Some("&".repeat(13015));
    assert!(jpeg_segments(&metadata).is_ok());
    metadata.text[2] = Some("&".repeat(13016));
    assert!(jpeg_segments(&metadata).is_err());
    metadata.text[2] = Some("张".repeat(21692));
    assert!(jpeg_segments(&metadata).is_ok());
    metadata.text[2] = Some("张".repeat(21693));
    assert!(jpeg_segments(&metadata).is_err());

    let mut metadata = with_text(COMMENT, &"y".repeat(65533));
    let segments = jpeg_segments(&metadata).unwrap();
    assert_eq!(&segments[..4], b"\xFF\xFE\xFF\xFF");
    metadata.text[COMMENT] = Some("y".repeat(65534));
    assert_eq!(
      jpeg_segments(&metadata).unwrap_err(),
      "The JPEG comment is 65534 bytes; one COM segment holds at most 65533."
    );
    // The XMP limit is checked first.
    metadata.text[2] = Some("x".repeat(65079));
    assert!(jpeg_segments(&metadata).unwrap_err().contains("XMP"));
  }

  #[test]
  fn xmp_template_sizes() {
    assert_eq!(XMP_HEAD.len() + XMP_TAIL.len(), 335);
    for (index, size) in [79, 62, 91, 81, 36].into_iter().enumerate() {
      let packet = xmp_packet(&with_text(index, "v").text[..COMMENT]).unwrap();
      assert_eq!(packet.len(), 335 + size + 1, "{index}");
    }
  }

  #[test]
  fn xmp_round_trip() {
    let mut metadata = ImageMetadata::default();
    let values = [
      "T&<>\"'",
      "a\rb\tc\nd",
      "d\u{1}\u{8}\u{B}\u{C}\u{E}\u{1F}e",
      "\u{FFFE}c\u{FFFF}",
      "s 张 😀",
    ];
    for (index, value) in values.iter().enumerate() {
      metadata.text[index] = clean(value);
    }
    let packet = xmp_packet(&metadata.text[..COMMENT]).unwrap();
    assert!(packet.starts_with("<?xpacket begin=\"\u{FEFF}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n"));
    assert!(packet.ends_with("</x:xmpmeta>\n<?xpacket end=\"w\"?>"));
    assert!(packet.contains("T&amp;&lt;&gt;\"'"));
    assert!(packet.contains("a&#xD;b\tc\nd"));
    let doc = roxmltree::Document::parse(&packet).unwrap();
    let dc = "http://purl.org/dc/elements/1.1/";
    let xmp = "http://ns.adobe.com/xap/1.0/";
    let text_of = |ns: &str, name: &str| {
      let node = doc
        .descendants()
        .find(|n| n.tag_name().namespace() == Some(ns) && n.tag_name().name() == name)
        .unwrap();
      node
        .descendants()
        .filter(|n| n.is_text())
        .map(|n| n.text().unwrap())
        .collect::<String>()
    };
    assert_eq!(text_of(dc, "title"), "T&<>\"'");
    assert_eq!(text_of(dc, "creator"), "a\rb\tc\nd");
    assert_eq!(text_of(dc, "description"), "de");
    assert_eq!(text_of(dc, "rights"), "c");
    assert_eq!(text_of(xmp, "CreatorTool"), "s 张 😀");
    // An element empty after cleaning is left out; none left, no packet.
    assert!(xmp_packet(&with_text(0, "\u{1}").text[..COMMENT]).is_none());
    assert!(matches!(
      with_text(0, "\u{1}").plan(ImageType::Jpeg),
      Ok(MetadataPatch::None)
    ));
  }

  #[test]
  fn other_formats_and_empty_metadata() {
    let mut metadata = with_resolution(Some(300));
    metadata.text[0] = clean("t");
    for ty in [ImageType::Webp, ImageType::Avif, ImageType::Gif] {
      assert!(matches!(metadata.plan(ty), Ok(MetadataPatch::None)));
    }
    for ty in [ImageType::Png, ImageType::Jpeg] {
      assert!(matches!(
        ImageMetadata::default().plan(ty),
        Ok(MetadataPatch::None)
      ));
    }
  }
}
