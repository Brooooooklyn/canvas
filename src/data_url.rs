//! The Fetch "data: URL processor" (https://fetch.spec.whatwg.org/#data-url-processor),
//! with the URL parser steps a data: URL goes through first
//! (https://url.spec.whatwg.org/#concept-basic-url-parser), as Chrome loads
//! an `<img src="data:...">`.

/// A parsed data: URL: the MIME type essence (lowercase `type/subtype`) and
/// the body bytes.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct DataUrl {
  pub essence: String,
  pub body: Vec<u8>,
}

/// URL parser: leading and trailing C0 controls and spaces go away.
fn trim_c0_control_or_space(input: &[u8]) -> &[u8] {
  let start = input.iter().position(|&b| b > 0x20).unwrap_or(input.len());
  let end = input
    .iter()
    .rposition(|&b| b > 0x20)
    .map_or(start, |i| i + 1);
  &input[start..end]
}

/// Whether `input` is a data: URL (what [`parse`] looks at first).
pub(crate) fn is_data_url(input: &[u8]) -> bool {
  let input = trim_c0_control_or_space(input);
  // The scheme cannot hold a tab or newline once they are removed; a URL
  // like "da\tta:" is so rare that it is not worth a copy here.
  input.len() >= 5 && input[..5].eq_ignore_ascii_case(b"data:")
}

fn is_ascii_whitespace(b: u8) -> bool {
  matches!(b, b'\t' | b'\n' | b'\x0c' | b'\r' | b' ')
}

fn trim_ascii_whitespace(input: &[u8]) -> &[u8] {
  let start = input
    .iter()
    .position(|&b| !is_ascii_whitespace(b))
    .unwrap_or(input.len());
  let end = input
    .iter()
    .rposition(|&b| !is_ascii_whitespace(b))
    .map_or(start, |i| i + 1);
  &input[start..end]
}

/// https://url.spec.whatwg.org/#percent-decode: `%XX` with two hex digits is
/// that byte, anything else stays as it is.
fn percent_decode(input: &[u8]) -> Vec<u8> {
  fn hex(b: u8) -> Option<u8> {
    (b as char).to_digit(16).map(|d| d as u8)
  }
  let mut out = Vec::with_capacity(input.len());
  let mut i = 0;
  while i < input.len() {
    if input[i] == b'%'
      && let (Some(high), Some(low)) = (
        input.get(i + 1).copied().and_then(hex),
        input.get(i + 2).copied().and_then(hex),
      )
    {
      out.push((high << 4) | low);
      i += 3;
      continue;
    }
    out.push(input[i]);
    i += 1;
  }
  out
}

/// The essence of a MIME type string (https://mimesniff.spec.whatwg.org/#parse-a-mime-type),
/// or None when it does not parse.
fn mime_essence(input: &[u8]) -> Option<String> {
  fn is_token(bytes: &[u8]) -> bool {
    !bytes.is_empty()
      && bytes
        .iter()
        .all(|&b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
  }
  // HTTP whitespace: ASCII whitespace without form feed.
  let is_http_whitespace = |b: &u8| matches!(b, b'\t' | b'\n' | b'\r' | b' ');
  let start = input
    .iter()
    .position(|b| !is_http_whitespace(b))
    .unwrap_or(input.len());
  let end = input
    .iter()
    .rposition(|b| !is_http_whitespace(b))
    .map_or(start, |i| i + 1);
  let input = &input[start..end];
  let slash = input.iter().position(|&b| b == b'/')?;
  let kind = &input[..slash];
  let rest = &input[slash + 1..];
  let subtype = &rest[..rest.iter().position(|&b| b == b';').unwrap_or(rest.len())];
  let subtype = &subtype[..subtype
    .iter()
    .rposition(|b| !is_http_whitespace(b))
    .map_or(0, |i| i + 1)];
  if !is_token(kind) || !is_token(subtype) {
    return None;
  }
  Some(format!(
    "{}/{}",
    String::from_utf8_lossy(kind).to_ascii_lowercase(),
    String::from_utf8_lossy(subtype).to_ascii_lowercase()
  ))
}

/// None when `input` is not a data: URL; Some(Err) when it is one that the
/// data: URL processor fails on (the image fires onerror).
pub(crate) fn parse(input: &[u8]) -> Option<Result<DataUrl, ()>> {
  if !is_data_url(input) {
    return None;
  }
  // URL parser: trim, then drop every tab and newline.
  let url: Vec<u8> = trim_c0_control_or_space(input)
    .iter()
    .copied()
    .filter(|&b| !matches!(b, b'\t' | b'\n' | b'\r'))
    .collect();
  // The URL serializer with "exclude fragment": cut at the first '#'. The
  // query stays part of the body.
  let url = &url[..url.iter().position(|&b| b == b'#').unwrap_or(url.len())];
  // Remove "data:".
  let input = &url[5..];
  let Some(comma) = input.iter().position(|&b| b == b',') else {
    return Some(Err(()));
  };
  let (essence, base64) = mime_type(&input[..comma]);
  let mut body = percent_decode(&input[comma + 1..]);
  if base64 {
    // forgiving-base64 decode of the isomorphic decode of the body.
    body = match base64_simd::forgiving_decode_to_vec(&body) {
      Ok(decoded) => decoded,
      Err(_) => return Some(Err(())),
    };
  }
  Some(Ok(DataUrl { essence, body }))
}

/// The MIME type of a data: URL, the part before the comma without tabs and
/// newlines: its essence, and whether the body is base64.
fn mime_type(input: &[u8]) -> (String, bool) {
  let mut mime_type = trim_ascii_whitespace(input).to_vec();
  // ";" then spaces then "base64", ASCII case-insensitive, at the end.
  let base64 =
    mime_type.len() >= 6 && mime_type[mime_type.len() - 6..].eq_ignore_ascii_case(b"base64") && {
      let before = &mime_type[..mime_type.len() - 6];
      let without_spaces = before.len() - before.iter().rev().take_while(|&&b| b == b' ').count();
      without_spaces > 0 && before[without_spaces - 1] == b';'
    };
  if base64 {
    mime_type.truncate(mime_type.len() - 6);
    while mime_type.last() == Some(&b' ') {
      mime_type.pop();
    }
    mime_type.pop();
  }
  if mime_type.first() == Some(&b';') {
    mime_type.splice(0..0, b"text/plain".iter().copied());
  }
  let essence = mime_essence(&mime_type).unwrap_or_else(|| "text/plain".to_owned());
  (essence, base64)
}

/// The start of a data: URL, read without decoding the whole body.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Head {
  /// The MIME type essence, as [`parse`] gives it.
  pub essence: String,
  /// The first bytes of the body [`parse`] gives: all of them when the body
  /// fits in [`HEAD_WINDOW`] bytes of the URL, else the ones that the first
  /// [`HEAD_WINDOW`] bytes decode to. Empty when those do not decode.
  pub prefix: Vec<u8>,
  /// The most bytes the body can decode to.
  pub max_body_len: usize,
}

/// How much of a data: URL's body [`head`] decodes.
const HEAD_WINDOW: usize = 1024;

/// [`parse`] for the start of the body only, at a cost that does not grow
/// with the body's length. None when `input` is not a data: URL; Some(Err)
/// when [`parse`] fails on it before the body.
pub(crate) fn head(input: &[u8]) -> Option<Result<Head, ()>> {
  // `is_data_url`, without looking at the end of the input.
  let start = input.iter().position(|&b| b > 0x20)?;
  if !input[start..]
    .get(..5)
    .is_some_and(|scheme| scheme.eq_ignore_ascii_case(b"data:"))
  {
    return None;
  }
  let input = &input[start + 5..];
  // The URL is cut at its first '#', so the comma comes before any '#'.
  let Some(comma) = input
    .iter()
    .position(|&b| b == b',' || b == b'#')
    .filter(|&i| input[i] == b',')
  else {
    return Some(Err(()));
  };
  let not_tab_or_newline = |b: &u8| !matches!(b, b'\t' | b'\n' | b'\r');
  let mime: Vec<u8> = input[..comma]
    .iter()
    .copied()
    .filter(not_tab_or_newline)
    .collect();
  let (essence, base64) = mime_type(&mime);
  // The body runs to the end of the input, before the trailing C0 controls
  // and spaces and the fragment are cut: no more bytes than that, and a
  // base64 body decodes to 3 bytes or fewer for each 4.
  let body = &input[comma + 1..];
  let max_body_len = if base64 {
    body.len() / 4 * 3 + 2
  } else {
    body.len()
  };
  let whole = body.len() <= HEAD_WINDOW;
  let window = if whole {
    // The end of the URL: its trailing C0 controls and spaces go away.
    &body[..body.iter().rposition(|&b| b > 0x20).map_or(0, |i| i + 1)]
  } else {
    &body[..HEAD_WINDOW]
  };
  let hash = window.iter().position(|&b| b == b'#');
  let whole = whole || hash.is_some();
  let mut chars: Vec<u8> = window[..hash.unwrap_or(window.len())]
    .iter()
    .copied()
    .filter(not_tab_or_newline)
    .collect();
  if !whole {
    // A "%XX" escape cut by the end of the window: decode up to it.
    let tail = chars.len().saturating_sub(2);
    if let Some(i) = chars[tail..].iter().position(|&b| b == b'%') {
      chars.truncate(tail + i);
    }
  }
  let mut prefix = percent_decode(&chars);
  if base64 {
    prefix.retain(|&b| !is_ascii_whitespace(b));
    if !whole {
      // Whole groups of 4 only: the rest of the body continues the last one.
      prefix.truncate(prefix.len() / 4 * 4);
    }
    prefix = base64_simd::forgiving_decode_to_vec(&prefix).unwrap_or_default();
  }
  Some(Ok(Head {
    essence,
    prefix,
    max_body_len,
  }))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn ok(input: &str) -> (String, Vec<u8>) {
    let url = parse(input.as_bytes()).unwrap().unwrap();
    (url.essence, url.body)
  }

  #[test]
  fn not_data_urls() {
    assert_eq!(parse(b"/tmp/a.png"), None);
    assert_eq!(parse(b"https://example.com/a.png"), None);
    assert_eq!(parse(b"dat:a"), None);
  }

  #[test]
  fn data_url_processor() {
    assert_eq!(ok("data:,A%20B"), ("text/plain".into(), b"A B".to_vec()));
    assert_eq!(
      ok(" \x01DATA:Image/PNG;BASE64,QUJD\x01 "),
      ("image/png".into(), b"ABC".to_vec())
    );
    assert_eq!(
      ok("data:image/png; base64,Q U\nJ\tD"),
      ("image/png".into(), b"ABC".to_vec())
    );
    assert_eq!(
      ok("data:image/png;foo=bar;base64,QUJD#x"),
      ("image/png".into(), b"ABC".to_vec())
    );
    assert_eq!(
      ok("data: image/svg+xml ;base64,QUJD"),
      ("image/svg+xml".into(), b"ABC".to_vec())
    );
    assert_eq!(
      ok("data:;base64,QUJD"),
      ("text/plain".into(), b"ABC".to_vec())
    );
    assert_eq!(
      ok("data:image/svg+xml,%3Csvg%zz%"),
      ("image/svg+xml".into(), b"<svg%zz%".to_vec())
    );
    assert_eq!(ok("data:bogus,x"), ("text/plain".into(), b"x".to_vec()));
    assert_eq!(
      ok("data:image/png;base64,QUJ"),
      ("image/png".into(), b"AB".to_vec())
    );
    // ";base64" not at the end: not base64.
    assert_eq!(
      ok("data:image/png;base64;x=y,QUJD"),
      ("image/png".into(), b"QUJD".to_vec())
    );
    assert_eq!(parse(b"data:image/png;base64QUJD"), Some(Err(())));
    assert_eq!(parse(b"data:image/png;base64,QUJD?x=1"), Some(Err(())));
    assert_eq!(parse(b"data:image/png;base64,Q*UJD"), Some(Err(())));
    assert_eq!(parse(b"data:image/png;base64,QUJDA"), Some(Err(())));
  }

  /// `head` agrees with `parse`: the same essence, a prefix of its body (the
  /// whole body when it is short), and a bound on its length.
  fn same_start(input: &[u8]) -> Option<Head> {
    let Some(parsed) = parse(input) else {
      assert_eq!(head(input), None);
      return None;
    };
    let Some(Ok(start)) = head(input) else {
      assert_eq!(parsed, Err(()));
      assert_eq!(head(input), Some(Err(())));
      return None;
    };
    let Ok(url) = parsed else {
      // The body does not decode: no prefix when it is all in the window.
      if input.len() <= HEAD_WINDOW {
        assert!(start.prefix.is_empty());
      }
      return Some(start);
    };
    assert_eq!(start.essence, url.essence);
    assert!(start.max_body_len >= url.body.len());
    assert_eq!(start.prefix, url.body[..start.prefix.len()]);
    if input.len() <= HEAD_WINDOW {
      assert_eq!(start.prefix, url.body);
    }
    Some(start)
  }

  #[test]
  fn head_of_short_urls() {
    for input in [
      "/tmp/a.png",
      "data:,A%20B",
      " \x01DATA:Image/PNG;BASE64,QUJD\x01 ",
      "data:image/png; base64,Q U\nJ\tD",
      "data:image/png;foo=bar;base64,QUJD#x",
      "data: image/svg+xml ;base64,QUJD",
      "data:;base64,QUJD",
      "data:image/svg+xml,%3Csvg%zz%",
      "data:bogus,x",
      "data:image/png;base64,QUJ",
      "data:image/png;base64;x=y,QUJD",
      "data:image/png;base64QUJD",
      "data:image/png;base64,QUJD?x=1",
      "data:image/png;base64,Q*UJD",
      "data:image/png;base64,QUJDA",
      "data:image/png#x,QUJD",
      "data:,  a b \x01 ",
      "data:,a\t%4\n1#b",
      "  data:",
    ] {
      same_start(input.as_bytes());
    }
  }

  #[test]
  fn head_of_long_urls() {
    let bytes: Vec<u8> = (0..6000u32).map(|i| (i * 7 + i / 255) as u8).collect();
    let base64 = base64_simd::STANDARD.encode_to_string(&bytes);
    // Lines of 76 characters, as MIME encoders write them.
    let lines: String = base64
      .as_bytes()
      .chunks(76)
      .map(|line| std::str::from_utf8(line).unwrap())
      .collect::<Vec<_>>()
      .join("\r\n");
    let escaped: String = bytes.iter().map(|b| format!("%{b:02X}")).collect();
    for (input, min_prefix) in [
      (format!("data:image/png;base64,{base64}"), 760),
      (format!("data:image/png;base64,{lines}  "), 740),
      (format!("data:image/png;base64,{base64}#{base64}"), 760),
      (format!("data:image/png;base64,{}#x", &base64[..1000]), 750),
      (format!("data:image/png,{escaped}"), 340),
      (format!("data:image/png,x{escaped}"), 340),
      (format!("data:image/png,xy{escaped}"), 340),
      (
        format!("data:image/png;base64,{}", base64.replace('Q', "%51")),
        300,
      ),
      (format!("data:image/png;base64,=={base64}"), 0),
    ] {
      let start = same_start(input.as_bytes()).unwrap();
      assert!(
        start.prefix.len() >= min_prefix,
        "{} bytes from {}",
        start.prefix.len(),
        &input[..40]
      );
      assert!(start.max_body_len <= input.len());
    }
  }
}
