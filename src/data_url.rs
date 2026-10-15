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
  let mut mime_type = trim_ascii_whitespace(&input[..comma]).to_vec();
  let mut body = percent_decode(&input[comma + 1..]);
  // ";" then spaces then "base64", ASCII case-insensitive, at the end.
  let base64 =
    mime_type.len() >= 6 && mime_type[mime_type.len() - 6..].eq_ignore_ascii_case(b"base64") && {
      let before = &mime_type[..mime_type.len() - 6];
      let without_spaces = before.len() - before.iter().rev().take_while(|&&b| b == b' ').count();
      without_spaces > 0 && before[without_spaces - 1] == b';'
    };
  if base64 {
    // forgiving-base64 decode of the isomorphic decode of the body.
    body = match base64_simd::forgiving_decode_to_vec(&body) {
      Ok(decoded) => decoded,
      Err(_) => return Some(Err(())),
    };
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
  Some(Ok(DataUrl { essence, body }))
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
}
