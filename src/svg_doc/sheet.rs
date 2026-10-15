//! Author style sheets: `<style>` elements and `style=""` attributes.
//!
//! Blink's order for author declarations (CSS Cascade 5), lowest first:
//!   presentation attributes (before every rule)
//!   < normal rules: layers in declaration order, unlayered last; then
//!     specificity; then order
//!   < style attribute, normal
//!   < important rules: unlayered first, then layers in reverse order
//!   < style attribute, important
//! (measured in Chrome 155).

use cssparser::{
  AtRuleParser, CowRcStr, DeclarationParser, Delimiter, ParseError, Parser, ParserState,
  QualifiedRuleParser, RuleBodyItemParser, RuleBodyParser, StyleSheetParser, Token,
};
use selectors::parser::SelectorList;

use super::select::{Impl, RuleIndex, SelectorParser, parse_selector_list};

#[derive(Clone, Debug)]
pub(crate) struct Decl {
  /// Lowercased, except custom properties, which keep their case.
  pub name: String,
  /// The value as written, trimmed, without `!important`.
  pub value: String,
  pub important: bool,
}

pub(crate) struct Rule {
  pub selectors: SelectorList<Impl>,
  pub decls: Vec<Decl>,
  /// Index into `Sheet::layers`; None for unlayered rules.
  pub layer: Option<usize>,
}

#[derive(Default)]
pub(crate) struct Sheet {
  /// In document order.
  pub rules: Vec<Rule>,
  /// Layer names in the order they were first declared.
  pub layers: Vec<String>,
  pub index: RuleIndex,
  anonymous_layers: u32,
}

/// What media queries and `@supports` see.
pub(crate) struct Env<'a> {
  /// The SVG image's viewport in px (Chrome evaluates width and height
  /// queries against it).
  pub viewport: (f32, f32),
  pub supports: &'a dyn Fn(&str, &str) -> bool,
}

impl Sheet {
  pub(crate) fn add_sheet(&mut self, css: &str, env: &Env) {
    let mut parser = Parser::new(css);
    let mut top = TopParser {
      sheet: self,
      env,
      layer: None,
      selector_parser: SelectorParser::default(),
    };
    for _ in StyleSheetParser::new(&mut parser, &mut top) {}
  }

  fn layer_index(&mut self, name: &str) -> usize {
    if let Some(i) = self.layers.iter().position(|l| l == name) {
      return i;
    }
    self.layers.push(name.to_owned());
    self.layers.len() - 1
  }

  fn push_rule(&mut self, rule: Rule) {
    self.index.add(self.rules.len() as u32, &rule.selectors);
    self.rules.push(rule);
  }
}

pub(crate) enum Prelude {
  Media(bool),
  Supports(bool),
  Layer(Vec<String>),
  Namespace(Option<String>, String),
  Ignore,
}

struct TopParser<'s, 'e> {
  sheet: &'s mut Sheet,
  env: &'e Env<'e>,
  layer: Option<String>,
  selector_parser: SelectorParser,
}

impl<'i> QualifiedRuleParser<'i> for TopParser<'_, '_> {
  type Prelude = SelectorList<Impl>;
  type QualifiedRule = ();
  type Error = ();

  fn parse_prelude(&mut self, input: &mut Parser<'i>) -> Result<Self::Prelude, ParseError<()>> {
    parse_selector_list(&self.selector_parser, input).ok_or_else(|| ParseError::custom(()))
  }

  fn parse_block(
    &mut self,
    prelude: Self::Prelude,
    _start: &ParserState,
    input: &mut Parser<'i>,
  ) -> Result<(), ParseError<()>> {
    let decls = parse_declaration_block(input);
    let layer = self.layer.clone().map(|l| self.sheet.layer_index(&l));
    self.sheet.push_rule(Rule {
      selectors: prelude,
      decls,
      layer,
    });
    Ok(())
  }
}

impl<'i> AtRuleParser<'i> for TopParser<'_, '_> {
  type Prelude = Prelude;
  type AtRule = ();
  type Error = ();

  fn parse_prelude(
    &mut self,
    name: CowRcStr<'i>,
    input: &mut Parser<'i>,
  ) -> Result<Prelude, ParseError<()>> {
    match name.to_ascii_lowercase().as_str() {
      "media" => {
        let start = input.position();
        while input.next().is_ok() {}
        Ok(Prelude::Media(eval_media_list(
          input.slice_from(start),
          self.env,
        )))
      }
      "supports" => Ok(Prelude::Supports(eval_supports(input, self.env))),
      "layer" => {
        let mut names = Vec::new();
        loop {
          if let Ok(first) = input.try_parse(|i| i.expect_ident_cloned()) {
            let mut parts = vec![first.to_string()];
            while let Ok(part) = input.try_parse(|i| -> Result<_, ParseError<()>> {
              i.expect_delim('.')?;
              Ok(i.expect_ident_cloned()?.to_string())
            }) {
              parts.push(part);
            }
            names.push(parts.join("."));
          }
          if input.try_parse(|i| i.expect_comma()).is_err() {
            break;
          }
        }
        if !input.is_exhausted() {
          return Err(ParseError::custom(()));
        }
        Ok(Prelude::Layer(names))
      }
      "namespace" => {
        let prefix = input
          .try_parse(|i| i.expect_ident_cloned())
          .ok()
          .map(|s| s.to_string());
        let url = input
          .try_parse(|i| i.expect_url_or_string().map(|s| s.to_string()))
          .map_err(|_| ParseError::custom(()))?;
        Ok(Prelude::Namespace(prefix, url))
      }
      // @import (Chrome loads data: URL sheets; not done here), @font-face,
      // @keyframes, @page, @property and the like change nothing drawn here.
      _ => {
        while input.next().is_ok() {}
        Ok(Prelude::Ignore)
      }
    }
  }

  fn rule_without_block(&mut self, prelude: Prelude, _start: &ParserState) -> Result<(), ()> {
    match prelude {
      Prelude::Layer(names) => {
        for name in names {
          let full = match &self.layer {
            Some(parent) => format!("{parent}.{name}"),
            None => name,
          };
          self.sheet.layer_index(&full);
        }
      }
      Prelude::Namespace(prefix, url)
        // Only before every style rule; Blink drops later ones.
        if self.sheet.rules.is_empty() => {
          match prefix {
            Some(p) => self.selector_parser.prefixes.push((p, url)),
            None => self.selector_parser.default_ns = Some(url),
          }
        }
      _ => {}
    }
    Ok(())
  }

  fn parse_block(
    &mut self,
    prelude: Prelude,
    _start: &ParserState,
    input: &mut Parser<'i>,
  ) -> Result<(), ParseError<()>> {
    match prelude {
      Prelude::Media(true) | Prelude::Supports(true) => self.nested_rules(input, None),
      Prelude::Layer(names) => {
        let name = match names.len() {
          0 => {
            self.sheet.anonymous_layers += 1;
            format!("\u{0}anonymous{}", self.sheet.anonymous_layers)
          }
          1 => names[0].clone(),
          _ => return Err(ParseError::custom(())),
        };
        let full = match &self.layer {
          Some(parent) => format!("{parent}.{name}"),
          None => name,
        };
        self.nested_rules(input, Some(full))
      }
      _ => Ok(()),
    }
  }
}

impl TopParser<'_, '_> {
  fn nested_rules<'i>(
    &mut self,
    input: &mut Parser<'i>,
    layer: Option<String>,
  ) -> Result<(), ParseError<()>> {
    let saved = self.layer.clone();
    if let Some(layer) = layer {
      self.sheet.layer_index(&layer);
      self.layer = Some(layer);
    }
    for _ in StyleSheetParser::new(input, self) {}
    self.layer = saved;
    Ok(())
  }
}

struct DeclParser;

impl<'i> DeclarationParser<'i> for DeclParser {
  type Declaration = Option<Decl>;
  type Error = ();

  fn parse_value(
    &mut self,
    name: CowRcStr<'i>,
    input: &mut Parser<'i>,
    _start: &ParserState,
  ) -> Result<Option<Decl>, ParseError<()>> {
    let value = input.parse_until_before(Delimiter::Bang, |i| {
      let start = i.position();
      while i.next_including_whitespace_and_comments().is_ok() {}
      Ok::<_, ParseError<()>>(i.slice_from(start).to_owned())
    })?;
    let important = input.try_parse(cssparser::parse_important).is_ok();
    if !input.is_exhausted() {
      return Err(ParseError::custom(()));
    }
    let custom = name.starts_with("--");
    Ok(Some(Decl {
      name: if custom {
        name.to_string()
      } else {
        name.to_ascii_lowercase()
      },
      value: value.trim().to_owned(),
      important,
    }))
  }
}

impl<'i> AtRuleParser<'i> for DeclParser {
  type Prelude = ();
  type AtRule = Option<Decl>;
  type Error = ();
}

impl<'i> QualifiedRuleParser<'i> for DeclParser {
  type Prelude = ();
  type QualifiedRule = Option<Decl>;
  type Error = ();
}

impl<'i> RuleBodyItemParser<'i, Option<Decl>, ()> for DeclParser {
  fn parse_declarations(&self) -> bool {
    true
  }

  fn parse_qualified(&self) -> bool {
    false
  }
}

pub(crate) fn parse_declaration_block(input: &mut Parser) -> Vec<Decl> {
  let mut parser = DeclParser;
  RuleBodyParser::new(input, &mut parser)
    .flatten()
    .flatten()
    .collect()
}

/// A `style=""` attribute.
pub(crate) fn parse_style_attr(text: &str) -> Vec<Decl> {
  let mut parser = Parser::new(text);
  parse_declaration_block(&mut parser)
}

// Media queries: the subset Blink evaluates for an SVG image (a screen with
// the image's viewport, light color scheme, no motion or contrast
// preference).

pub(crate) fn eval_media_list(text: &str, env: &Env) -> bool {
  let text = text.trim();
  text.is_empty()
    || split_top_level_commas(text)
      .iter()
      .any(|q| eval_media_query(q.trim(), env))
}

fn split_top_level_commas(s: &str) -> Vec<String> {
  let mut out = Vec::new();
  let mut depth = 0i32;
  let mut current = String::new();
  for c in s.chars() {
    match c {
      '(' => depth += 1,
      ')' => depth -= 1,
      ',' if depth == 0 => {
        out.push(std::mem::take(&mut current));
        continue;
      }
      _ => {}
    }
    current.push(c);
  }
  out.push(current);
  out
}

fn eval_media_query(query: &str, env: &Env) -> bool {
  let mut p = Parser::new(query);
  let mut negate = false;
  let mut result = true;
  let mut first = true;
  while !p.is_exhausted() {
    if let Ok(ident) = p.try_parse(|i| i.expect_ident_cloned()) {
      match ident.to_ascii_lowercase().as_str() {
        "not" if first => negate = true,
        "only" if first => {}
        "and" | "all" | "screen" => {}
        "print" | "speech" | "tty" | "tv" | "projection" | "handheld" | "braille" | "embossed"
        | "aural" => result = false,
        _ => return false,
      }
      first = false;
      continue;
    }
    if p.try_parse(|i| i.expect_parenthesis_block()).is_ok() {
      let feature = p.parse_nested_block(|i| Ok::<_, ParseError<()>>(eval_media_feature(i, env)));
      result &= feature.unwrap_or(false);
      first = false;
      continue;
    }
    return false;
  }
  result != negate
}

fn eval_media_feature(p: &mut Parser, env: &Env) -> bool {
  let start = p.position();
  while p.next().is_ok() {}
  let text = p.slice_from(start).trim().to_ascii_lowercase();
  let (width, height) = env.viewport;
  let px = |v: &str| -> Option<f32> {
    let v = v.trim();
    if let Some(n) = v.strip_suffix("px") {
      n.trim().parse().ok()
    } else if let Some(n) = v.strip_suffix("em") {
      n.trim().parse::<f32>().ok().map(|x| x * 16.0)
    } else {
      v.parse().ok()
    }
  };
  let Some((name, value)) = text.split_once(':') else {
    return text == "color";
  };
  let value = value.trim();
  match name.trim() {
    "width" => px(value) == Some(width),
    "min-width" => px(value).is_some_and(|v| width >= v),
    "max-width" => px(value).is_some_and(|v| width <= v),
    "height" => px(value) == Some(height),
    "min-height" => px(value).is_some_and(|v| height >= v),
    "max-height" => px(value).is_some_and(|v| height <= v),
    "orientation" => (value == "portrait") == (height >= width),
    "prefers-color-scheme" => value == "light",
    "prefers-reduced-motion" | "prefers-contrast" => value == "no-preference",
    "forced-colors" => value == "none",
    _ => false,
  }
}

fn eval_supports(input: &mut Parser, env: &Env) -> bool {
  // not <in-parens> | <in-parens> [and | or <in-parens>]*
  if input.try_parse(|i| i.expect_ident_matching("not")).is_ok() {
    return !eval_supports_in_parens(input, env);
  }
  let mut result = eval_supports_in_parens(input, env);
  loop {
    if input.try_parse(|i| i.expect_ident_matching("and")).is_ok() {
      result &= eval_supports_in_parens(input, env);
    } else if input.try_parse(|i| i.expect_ident_matching("or")).is_ok() {
      result |= eval_supports_in_parens(input, env);
    } else {
      break;
    }
  }
  result && input.is_exhausted()
}

fn eval_supports_in_parens(input: &mut Parser, env: &Env) -> bool {
  match input.next() {
    Ok(Token::ParenthesisBlock) => input
      .parse_nested_block(|i| {
        let declaration = i.try_parse(|i| -> Result<bool, ParseError<()>> {
          let name = i.expect_ident_cloned()?;
          i.expect_colon()?;
          let start = i.position();
          while i.next().is_ok() {}
          Ok((env.supports)(
            &name.to_ascii_lowercase(),
            i.slice_from(start).trim(),
          ))
        });
        Ok::<_, ParseError<()>>(declaration.unwrap_or_else(|_| eval_supports(i, env)))
      })
      .unwrap_or(false),
    Ok(Token::Function(name)) if name.eq_ignore_ascii_case("selector") => input
      .parse_nested_block(|i| {
        let parser = SelectorParser::default();
        Ok::<_, ParseError<()>>(parse_selector_list(&parser, i).is_some() && i.is_exhausted())
      })
      .unwrap_or(false),
    _ => false,
  }
}
