// shared with layer 07 (css-color)
//! cssparser keeps numeric tokens as f32; Blink's CSS tokenizer keeps them as
//! f64 (css_tokenizer.cc ConsumeNumber). Re-read the number from the token's
//! source text so values like `12.123456789px` keep their precision.

use cssparser::{BasicParseError, Parser, Token};

/// The value of the CSS number at the start of `src`
/// (`[+-]?(\d*\.\d+|\d+)([eE][+-]?\d+)?`), parsed correctly rounded.
pub(crate) fn number_prefix(src: &str) -> Option<f64> {
  let bytes = src.as_bytes();
  let mut end = 0;
  if matches!(bytes.first(), Some(b'+' | b'-')) {
    end += 1;
  }
  let int_start = end;
  while bytes.get(end).is_some_and(u8::is_ascii_digit) {
    end += 1;
  }
  let mut digits = end > int_start;
  if bytes.get(end) == Some(&b'.') && bytes.get(end + 1).is_some_and(u8::is_ascii_digit) {
    end += 1;
    while bytes.get(end).is_some_and(u8::is_ascii_digit) {
      end += 1;
    }
    digits = true;
  }
  if !digits {
    return None;
  }
  if matches!(bytes.get(end), Some(b'e' | b'E')) {
    let mut exp = end + 1;
    if matches!(bytes.get(exp), Some(b'+' | b'-')) {
      exp += 1;
    }
    if bytes.get(exp).is_some_and(u8::is_ascii_digit) {
      while bytes.get(exp).is_some_and(u8::is_ascii_digit) {
        exp += 1;
      }
      end = exp;
    }
  }
  src[..end].parse::<f64>().ok()
}

/// A token and, for Number / Percentage / Dimension tokens, its f64 value
/// (a percentage keeps its percent number: `50%` is 50).
pub(crate) struct NumericToken<'i> {
  pub token: Token<'i>,
  pub value: f64,
}

fn with_value<'i>(token: Token<'i>, src: &str) -> NumericToken<'i> {
  let value = match token {
    Token::Number { value, .. } => number_prefix(src).unwrap_or(value as f64),
    Token::Percentage { unit_value, .. } => number_prefix(src).unwrap_or(unit_value as f64 * 100.0),
    Token::Dimension { value, .. } => number_prefix(src).unwrap_or(value as f64),
    _ => f64::NAN,
  };
  NumericToken { token, value }
}

/// `Parser::next` (skips whitespace and comments) with the f64 value.
pub(crate) fn next<'i>(p: &mut Parser<'i>) -> Result<NumericToken<'i>, BasicParseError> {
  p.skip_whitespace();
  let start = p.position();
  let token = p.next()?.clone();
  let src = p.slice_from(start);
  Ok(with_value(token, src))
}

/// `Parser::next_including_whitespace` (skips comments) with the f64 value.
pub(crate) fn next_including_whitespace<'i>(
  p: &mut Parser<'i>,
) -> Result<NumericToken<'i>, BasicParseError> {
  loop {
    let start = p.position();
    let token = p.next_including_whitespace_and_comments()?.clone();
    if matches!(token, Token::Comment(_)) {
      continue;
    }
    let src = p.slice_from(start);
    return Ok(with_value(token, src));
  }
}

#[cfg(test)]
mod tests {
  use super::number_prefix;

  #[test]
  fn number_prefix_reads_css_numbers() {
    assert_eq!(number_prefix("12.123456789px"), Some(12.123456789));
    assert_eq!(number_prefix("+.5px"), Some(0.5));
    assert_eq!(number_prefix("1e+1px"), Some(10.0));
    assert_eq!(number_prefix("1E1px"), Some(10.0));
    assert_eq!(number_prefix("1epx"), Some(1.0));
    assert_eq!(number_prefix("50%"), Some(50.0));
    assert_eq!(number_prefix("-0"), Some(-0.0));
    assert_eq!(number_prefix("px"), None);
  }
}
