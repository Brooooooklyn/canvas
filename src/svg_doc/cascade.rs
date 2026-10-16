//! The cascade: presentation attributes, style sheets and `style=""` in
//! Blink's order, CSS-wide keywords, inheritance, and custom properties with
//! `var()`.

use std::collections::HashMap;
use std::rc::Rc;

use cssparser::{ParseError, Parser, Token};
use selectors::Element;
use selectors::bloom::BloomFilter;
use selectors::context::SelectorCaches;

use super::dom::{Doc, NodeId, Ns};
use super::props::{ALL, COUNT, Mode, Prop, parse_value};
use super::select::{El, element_hashes, matches};
use super::sheet::{Decl, Sheet, parse_style_attr};
use super::values::{Len, LenCtx, ROOT_FONT_SIZE, Value};

/// CSSVariableData::kMaxVariableBytes (css_variable_data.h): a custom
/// property longer than this, as declared or after `var()` substitution, is
/// invalid (style_cascade.cc).
pub(crate) const MAX_VARIABLE_BYTES: usize = 2_097_152;

/// How deep `var()` references may chain through custom properties of one
/// element; deeper ones are invalid. Chrome has no such limit; it keeps the
/// recursion here off the native stack's end.
const MAX_VAR_DEPTH: usize = 256;

/// The custom properties an element declares, over the ones it inherits.
/// Elements that declare none share their parent's scope.
pub(crate) struct CustomScope {
  parent: Option<Rc<CustomScope>>,
  /// None is the guaranteed-invalid value.
  vars: HashMap<String, Option<Rc<str>>>,
}

fn lookup(scope: &Option<Rc<CustomScope>>, name: &str) -> Option<Rc<str>> {
  let mut scope = scope.as_ref();
  while let Some(s) = scope {
    if let Some(v) = s.vars.get(name) {
      return v.clone();
    }
    scope = s.parent.as_ref();
  }
  None
}

#[derive(Clone)]
pub(crate) struct Style {
  values: Vec<Value>,
  /// Bit per Prop: set by a declaration on this element.
  declared: u64,
  pub custom: Option<Rc<CustomScope>>,
}

impl Style {
  /// The initial values: what the root inherits from.
  pub(crate) fn initial() -> Style {
    Style {
      values: ALL.iter().map(|p| p.initial()).collect(),
      declared: 0,
      custom: None,
    }
  }

  pub(crate) fn get(&self, prop: Prop) -> &Value {
    &self.values[prop as usize]
  }

  pub(crate) fn declared(&self, prop: Prop) -> bool {
    self.declared & (1 << prop as u64) != 0
  }

  pub(crate) fn font_size(&self) -> f32 {
    match self.get(Prop::FontSize) {
      Value::Len(l) => l.px,
      _ => ROOT_FONT_SIZE,
    }
  }

  pub(crate) fn keyword(&self, prop: Prop) -> &'static str {
    match self.get(prop) {
      Value::Keyword(k) => k,
      _ => "",
    }
  }

  pub(crate) fn number(&self, prop: Prop) -> f32 {
    match self.get(prop) {
      Value::Number(v) => *v,
      _ => 1.0,
    }
  }

  pub(crate) fn len(&self, prop: Prop) -> Option<Len> {
    match self.get(prop) {
      Value::Len(l) => Some(*l),
      _ => None,
    }
  }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
struct Priority {
  important: bool,
  /// 0 presentation attribute, 1 style sheet, 2 style attribute.
  origin: u8,
  /// Normal: layers in order, unlayered last. Important: unlayered first,
  /// layers in reverse.
  layer: u32,
  specificity: u32,
  order: u32,
}

/// A cascade layer without importance (CascadePriority::ForLayerComparison,
/// cascade_priority.h): origin (0 presentation attribute, 1 style sheet, 2
/// style attribute), then the layer in normal order (unlayered last).
/// `revert-layer` rolls back to declarations below its own.
type LayerKey = (u8, u32);

struct Candidate {
  priority: Priority,
  layer: LayerKey,
  /// None for a custom property.
  prop: Option<Prop>,
  name: String,
  value: String,
  mode: Mode,
}

/// `font: [style || weight]? size[/line-height]? family`.
fn expand_font(value: &str) -> Option<Vec<(&'static str, String)>> {
  let words: Vec<&str> = value.split_ascii_whitespace().collect();
  let mut style = "normal".to_string();
  let mut weight = "normal".to_string();
  let mut i = 0;
  while i < words.len() {
    let word = words[i].to_ascii_lowercase();
    match word.as_str() {
      "italic" | "oblique" => style = word,
      "normal" => {}
      "bold" | "bolder" | "lighter" => weight = word,
      _ if word.parse::<f32>().is_ok() => weight = word,
      _ => break,
    }
    i += 1;
  }
  let size = words.get(i)?.split('/').next()?.to_string();
  let family = words.get(i + 1..)?.join(" ");
  if family.is_empty() {
    return None;
  }
  Some(vec![
    ("font-style", style),
    ("font-weight", weight),
    ("font-size", size),
    ("font-family", family),
  ])
}

const CSS_WIDE: &[&str] = &["inherit", "initial", "unset", "revert", "revert-layer"];

fn css_wide(text: &str) -> Option<&'static str> {
  CSS_WIDE
    .iter()
    .find(|k| text.eq_ignore_ascii_case(k))
    .copied()
}

fn has_var(text: &str) -> bool {
  text
    .as_bytes()
    .windows(4)
    .any(|w| w.eq_ignore_ascii_case(b"var("))
}

pub(crate) struct Cascade<'a> {
  pub doc: &'a Doc,
  pub sheet: &'a Sheet,
  /// What percentages and viewport units resolve against.
  pub viewport: (f32, f32),
  /// Per `<use>` instance scope: nth-child caches key on the element, and
  /// an element matches differently inside an instance.
  caches: HashMap<Option<NodeId>, SelectorCaches>,
  ancestors: Ancestors,
}

/// The ancestor bloom filter, holding the hashes of the ancestors of the
/// element being matched (as `El::parent_element` walks them). Kept from
/// one element to the next, so a document walked in order only adds and
/// removes the elements it enters and leaves.
struct Ancestors {
  filter: Box<BloomFilter>,
  /// The ancestors in the filter, root first, with the end of their hashes
  /// in `hashes`.
  chain: Vec<(NodeId, usize)>,
  hashes: Vec<u32>,
  path: Vec<NodeId>,
}

impl Ancestors {
  fn new() -> Self {
    Ancestors {
      filter: Box::default(),
      chain: Vec::new(),
      hashes: Vec::new(),
      path: Vec::new(),
    }
  }

  /// Makes the filter hold exactly the ancestors of `el`.
  fn enter(&mut self, el: El) {
    self.path.clear();
    let mut parent = el.parent_element();
    while let Some(p) = parent {
      self.path.push(p.id);
      parent = p.parent_element();
    }
    self.path.reverse();
    let keep = self
      .chain
      .iter()
      .zip(&self.path)
      .take_while(|((a, _), b)| a == *b)
      .count();
    while self.chain.len() > keep {
      self.chain.pop();
      let start = self.chain.last().map_or(0, |(_, end)| *end);
      for hash in self.hashes.drain(start..) {
        self.filter.remove_hash(hash);
      }
    }
    for &id in &self.path[keep..] {
      let start = self.hashes.len();
      element_hashes(el.doc, id, &mut self.hashes);
      for &hash in &self.hashes[start..] {
        self.filter.insert_hash(hash);
      }
      self.chain.push((id, self.hashes.len()));
    }
  }
}

impl<'a> Cascade<'a> {
  pub(crate) fn new(doc: &'a Doc, sheet: &'a Sheet, viewport: (f32, f32)) -> Self {
    Cascade {
      doc,
      sheet,
      viewport,
      caches: HashMap::new(),
      ancestors: Ancestors::new(),
    }
  }

  fn push_decl(out: &mut Vec<Candidate>, decl: &Decl, priority: Priority, layer: LayerKey) {
    let mut push = |name: &str, value: String| {
      let prop = Prop::from_name(name);
      if prop.is_some() || name.starts_with("--") {
        out.push(Candidate {
          priority,
          layer,
          prop,
          name: name.to_owned(),
          value,
          mode: Mode::Css,
        });
      }
    };
    if decl.name == "font" {
      for (name, value) in expand_font(&decl.value).unwrap_or_default() {
        push(name, value);
      }
    } else {
      push(&decl.name, decl.value.clone());
    }
  }

  fn candidates(&mut self, id: NodeId, scope: Option<NodeId>) -> Vec<Candidate> {
    let doc = self.doc;
    let mut out = Vec::new();
    let Some(element) = doc.svg_name(id) else {
      return out;
    };
    let mut order = 0;
    let mut next = || {
      order += 1;
      order
    };
    for attr in doc.attrs(id).iter().filter(|a| a.ns == Ns::None) {
      let Some(prop) = Prop::from_name(&attr.name) else {
        continue;
      };
      if prop != Prop::Transform && !prop.is_presentation_attr_of(element) {
        continue;
      }
      out.push(Candidate {
        priority: Priority {
          important: false,
          origin: 0,
          layer: 0,
          specificity: 0,
          order: next(),
        },
        layer: (0, 0),
        prop: Some(prop),
        name: attr.name.clone(),
        value: attr.value.clone(),
        mode: Mode::Attr,
      });
    }
    let el = El { doc, id, scope };
    let layers = self.sheet.layers.len() as u32;
    let mut matched: Vec<(u32, u32)> = Vec::new();
    let mut lists = Vec::new();
    self.sheet.index.candidates(el, &mut lists);
    if !lists.is_empty() {
      self.ancestors.enter(el);
      let filter = &self.ancestors.filter;
      let mut entries: Vec<_> = lists
        .iter()
        .flat_map(|list| list.iter())
        .filter(|e| e.may_match(filter))
        .collect();
      if lists.len() > 1 {
        entries.sort_unstable_by_key(|e| (e.rule, e.selector));
      }
      let caches = self.caches.entry(scope).or_default();
      for entry in entries {
        let rule = entry.rule;
        let rule_selectors = &self.sheet.rules[rule as usize].selectors;
        let selector = &rule_selectors.slice()[entry.selector as usize];
        if let Some(spec) = matches(selector, el, caches, filter) {
          match matched.last_mut() {
            Some((r, s)) if *r == rule => *s = (*s).max(spec),
            _ => matched.push((rule, spec)),
          }
        }
      }
    }
    for (rule, specificity) in matched {
      let rule_ref = &self.sheet.rules[rule as usize];
      for decl in &rule_ref.decls {
        let layer = match (rule_ref.layer, decl.important) {
          (Some(l), false) => l as u32,
          (None, false) => layers,
          (Some(l), true) => layers - l as u32,
          (None, true) => 0,
        };
        let priority = Priority {
          important: decl.important,
          origin: 1,
          layer,
          specificity,
          order: next(),
        };
        let layer_key = (1, rule_ref.layer.map_or(layers, |l| l as u32));
        Self::push_decl(&mut out, decl, priority, layer_key);
      }
    }
    if let Some(style) = doc.attr(id, "style") {
      for decl in parse_style_attr(style) {
        let priority = Priority {
          important: decl.important,
          origin: 2,
          layer: 0,
          specificity: 0,
          order: next(),
        };
        Self::push_decl(&mut out, &decl, priority, (2, 0));
      }
    }
    out.sort_by_key(|c| c.priority);
    out
  }

  /// The computed style of element `id` (in the `<use>` instance rooted at
  /// `scope`, if any) whose parent's style is `parent`.
  pub(crate) fn compute(&mut self, id: NodeId, scope: Option<NodeId>, parent: &Style) -> Style {
    let candidates = self.candidates(id, scope);

    // Custom properties: the declarations of each, highest priority first.
    let mut raw: HashMap<&str, Vec<(LayerKey, &str)>> = HashMap::new();
    for c in candidates.iter().rev().filter(|c| c.prop.is_none()) {
      raw.entry(&c.name).or_default().push((c.layer, &c.value));
    }
    let custom = if raw.is_empty() {
      parent.custom.clone()
    } else {
      let mut resolver = VarResolver {
        raw: &raw,
        inherited: &parent.custom,
        resolved: HashMap::new(),
        stack: Vec::new(),
      };
      let names: Vec<&str> = raw.keys().copied().collect();
      for name in names {
        resolver.resolve(name);
      }
      Some(Rc::new(CustomScope {
        parent: parent.custom.clone(),
        vars: resolver.resolved,
      }))
    };

    let mut style = Style {
      values: Vec::with_capacity(COUNT),
      declared: 0,
      custom,
    };
    let mut values: Vec<Option<Value>> = vec![None; COUNT];
    let parent_font_size = parent.font_size();
    // font-size first: em in the others is this element's font size.
    let order =
      std::iter::once(Prop::FontSize).chain(ALL.iter().copied().filter(|p| *p != Prop::FontSize));
    for prop in order {
      let font_size = if prop == Prop::FontSize {
        parent_font_size
      } else {
        match &values[Prop::FontSize as usize] {
          Some(Value::Len(l)) => l.px,
          _ => parent_font_size,
        }
      };
      let ctx = LenCtx {
        font_size,
        viewport: self.viewport,
      };
      let mut result = None;
      let mut declared = false;
      // Set by revert-layer: only declarations of lower layers are left.
      let mut below: Option<LayerKey> = None;
      for c in candidates.iter().rev().filter(|c| c.prop == Some(prop)) {
        if below.is_some_and(|b| c.layer >= b) {
          continue;
        }
        let text = c.value.trim();
        if let Some(keyword) = css_wide(text) {
          match keyword {
            // StyleCascade::ResolveRevertLayer: the highest declaration of
            // a lower layer applies; with none, the property reverts.
            "revert-layer" => {
              below = Some(c.layer);
              continue;
            }
            // Back to the user and UA origins: as if no author declared
            // it (the UA sheet's part is the caller's, see `declared`).
            "revert" => {}
            "inherit" => {
              declared = true;
              result = Some(parent.get(prop).clone());
            }
            "initial" => {
              declared = true;
              result = Some(prop.initial());
            }
            // unset
            _ => declared = true,
          }
          break;
        }
        if has_var(text) {
          // Invalid at computed-value time: unset.
          declared = true;
          result =
            substitute(text, &style.custom).and_then(|s| parse_value(prop, &s, c.mode, &ctx));
          break;
        }
        if let Some(v) = parse_value(prop, text, c.mode, &ctx) {
          declared = true;
          result = Some(v);
          break;
        }
        // Invalid at parse time: as if not declared.
      }
      let value = result.unwrap_or_else(|| {
        if prop.inherited() {
          parent.get(prop).clone()
        } else {
          prop.initial()
        }
      });
      if declared {
        style.declared |= 1 << prop as u64;
      }
      values[prop as usize] = Some(value);
    }
    style.values = values.into_iter().map(Option::unwrap).collect();

    // bolder / lighter against the parent's weight (font_description.cc).
    if let Value::Keyword(k) = style.values[Prop::FontWeight as usize] {
      let parent_weight = match parent.get(Prop::FontWeight) {
        Value::Number(n) => *n,
        _ => 400.0,
      };
      let weight = if k == "bolder" {
        if parent_weight < 350.0 {
          400.0
        } else if parent_weight < 550.0 {
          700.0
        } else {
          parent_weight.max(900.0)
        }
      } else if parent_weight < 550.0 {
        parent_weight.min(100.0)
      } else if parent_weight < 750.0 {
        400.0
      } else {
        700.0
      };
      style.values[Prop::FontWeight as usize] = Value::Number(weight);
    }
    style
  }
}

struct VarResolver<'r> {
  raw: &'r HashMap<&'r str, Vec<(LayerKey, &'r str)>>,
  inherited: &'r Option<Rc<CustomScope>>,
  resolved: HashMap<String, Option<Rc<str>>>,
  stack: Vec<&'r str>,
}

impl<'r> VarResolver<'r> {
  fn resolve(&mut self, name: &str) -> Option<Rc<str>> {
    if let Some(v) = self.resolved.get(name) {
      return v.clone();
    }
    let Some((&key, decls)) = self.raw.get_key_value(name) else {
      return lookup(self.inherited, name);
    };
    if self.stack.contains(&key) {
      // A cycle: every property in it is guaranteed-invalid.
      let start = self.stack.iter().position(|s| *s == key).unwrap_or(0);
      for s in &self.stack[start..] {
        self.resolved.insert((*s).to_owned(), None);
      }
      return None;
    }
    // revert-layer rolls back to the highest declaration of a lower layer;
    // with none left, the property reverts.
    let mut below: Option<LayerKey> = None;
    let text = decls.iter().find_map(|&(layer, text)| {
      if below.is_some_and(|b| layer >= b) {
        return None;
      }
      if css_wide(text) == Some("revert-layer") {
        below = Some(layer);
        return None;
      }
      Some(text)
    });
    let value = match text.map(|t| (t, css_wide(t))) {
      Some((_, Some("initial"))) => None,
      // inherit, unset, and revert (no user or UA declarations to go back
      // to: unset, which inherits).
      None | Some((_, Some(_))) => lookup(self.inherited, name),
      Some((text, None))
        if text.len() > MAX_VARIABLE_BYTES || self.stack.len() >= MAX_VAR_DEPTH =>
      {
        None
      }
      Some((text, None)) => {
        self.stack.push(key);
        let substituted = substitute_with(text, &mut |n| self.resolve(n));
        self.stack.pop();
        if self.resolved.get(key) == Some(&None) {
          None
        } else {
          substituted.map(Rc::from)
        }
      }
    };
    self.resolved.insert(key.to_owned(), value.clone());
    value
  }
}

/// `text` with every `var()` replaced, or None when one has no value and no
/// fallback, or the result is longer than MAX_VARIABLE_BYTES.
pub(crate) fn substitute(text: &str, custom: &Option<Rc<CustomScope>>) -> Option<String> {
  substitute_with(text, &mut |name| lookup(custom, name))
}

fn substitute_with(text: &str, lookup: &mut dyn FnMut(&str) -> Option<Rc<str>>) -> Option<String> {
  let mut p = Parser::new(text);
  let mut out = Substituted::default();
  substitute_block(&mut p, lookup, &mut out).then_some(out.text)
}

#[derive(Default)]
struct Substituted {
  text: String,
  /// The spaces put between a substituted value and its neighbours.
  padding: usize,
  /// The text ends with a substituted value.
  after_value: bool,
}

impl Substituted {
  /// About the length Blink checks against MAX_VARIABLE_BYTES: Blink puts
  /// "/**/" where tokens would merge, this puts a space and does not count
  /// it.
  fn len(&self) -> usize {
    self.text.len() - self.padding
  }

  /// Text of the declaration.
  fn push_str(&mut self, s: &str) {
    if self.after_value {
      self.pad_before(s);
      self.after_value = false;
    }
    self.text.push_str(s);
  }

  /// A substituted value.
  fn push_value(&mut self, v: &str) {
    self.pad_before(v);
    self.text.push_str(v);
    self.after_value = !v.is_empty() || self.after_value;
  }

  /// A space where the end of the text and `next` could read as one token
  /// (TokenSequence::Append's NeedsInsertedComment, style_cascade.cc).
  fn pad_before(&mut self, next: &str) {
    let apart = |c: char, closing: bool| {
      c.is_whitespace()
        || matches!(c, ',' | ';' | ':' | '"' | '\'' | '!')
        || (closing && matches!(c, ')' | ']' | '}'))
        || (!closing && matches!(c, '(' | '[' | '{'))
    };
    if let (Some(last), Some(first)) = (self.text.chars().next_back(), next.chars().next())
      && !apart(last, false)
      && !apart(first, true)
    {
      self.text.push(' ');
      self.padding += 1;
    }
  }
}

fn substitute_block(
  p: &mut Parser,
  lookup: &mut dyn FnMut(&str) -> Option<Rc<str>>,
  out: &mut Substituted,
) -> bool {
  loop {
    if out.len() > MAX_VARIABLE_BYTES {
      return false;
    }
    let start = p.position();
    let token = match p.next_including_whitespace_and_comments() {
      Ok(t) => t.clone(),
      Err(_) => return true,
    };
    match token {
      Token::Function(ref name) if name.eq_ignore_ascii_case("var") => {
        let value = p.parse_nested_block(|i| -> Result<Option<String>, ParseError<()>> {
          i.skip_whitespace();
          let name = i.expect_ident_cloned()?.to_string();
          if !name.starts_with("--") {
            return Err(ParseError::custom(()));
          }
          i.skip_whitespace();
          let fallback = if i.try_parse(|i| i.expect_comma()).is_ok() {
            let start = i.position();
            while i.next_including_whitespace_and_comments().is_ok() {}
            Some(i.slice_from(start).to_owned())
          } else {
            if !i.is_exhausted() {
              return Err(ParseError::custom(()));
            }
            None
          };
          Ok(match lookup(&name) {
            Some(v) => Some(v.to_string()),
            None => fallback.and_then(|f| substitute_with(&f, lookup)),
          })
        });
        match value {
          // TokenSequence::Append (style_cascade.cc:1078-1084): a value that
          // would make the result longer than the cap is invalid.
          Ok(Some(v)) if out.len() + v.len() <= MAX_VARIABLE_BYTES => {
            out.push_value(&v);
          }
          _ => return false,
        }
      }
      Token::Function(_)
      | Token::ParenthesisBlock
      | Token::SquareBracketBlock
      | Token::CurlyBracketBlock => {
        out.push_str(p.slice_from(start));
        let close = match token {
          Token::SquareBracketBlock => "]",
          Token::CurlyBracketBlock => "}",
          _ => ")",
        };
        let ok = p
          .parse_nested_block(|i| Ok::<_, ParseError<()>>(substitute_block(i, lookup, out)))
          .unwrap_or(false);
        if !ok {
          return false;
        }
        out.push_str(close);
      }
      _ => out.push_str(p.slice_from(start)),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::svg_doc::dom::SVG_NS;
  use crate::svg_doc::sheet::Env;
  use crate::svg_doc::values::{ColorValue, Paint, Rgba};

  fn styles(svg: &str) -> Vec<Style> {
    let doc = Doc::parse(svg).unwrap();
    let mut sheet = Sheet::default();
    let env = Env {
      viewport: (100.0, 100.0),
      supports: &|_, _| true,
    };
    for id in 0..doc.nodes.len() {
      if doc.svg_name(id) == Some("style") {
        sheet.add_sheet(&doc.text_content(id), &env);
      }
    }
    let mut cascade = Cascade::new(&doc, &sheet, (100.0, 100.0));
    let mut out: Vec<Style> = Vec::new();
    let mut parents = vec![(doc.root, Style::initial())];
    // Depth first, in document order.
    let mut stack = vec![doc.root];
    let mut computed: HashMap<NodeId, Style> = HashMap::new();
    while let Some(id) = stack.pop() {
      let parent = doc.nodes[id]
        .parent
        .and_then(|p| computed.get(&p).cloned())
        .unwrap_or_else(Style::initial);
      let style = cascade.compute(id, None, &parent);
      out.push(style.clone());
      computed.insert(id, style);
      stack.extend(
        doc
          .element_children(id)
          .collect::<Vec<_>>()
          .into_iter()
          .rev(),
      );
    }
    parents.clear();
    out
  }

  fn fill(style: &Style) -> Paint {
    match style.get(Prop::Fill) {
      Value::Paint(p) => p.clone(),
      _ => panic!(),
    }
  }

  const BLUE: Paint = Paint::Color(ColorValue::Rgba(Rgba {
    rgb: [0, 0, 255],
    a: 1.0,
  }));
  const RED: Paint = Paint::Color(ColorValue::Rgba(Rgba {
    rgb: [255, 0, 0],
    a: 1.0,
  }));

  #[test]
  fn blink_order() {
    let s = styles(&format!(
      r#"<svg xmlns="{SVG_NS}"><style>rect {{ fill: red }} #a {{ fill: blue }} .i {{ fill: blue !important }}</style>
      <rect id="a" fill="green"/><rect fill="green" style="fill: blue"/><rect class="i" style="fill: red"/></svg>"#
    ));
    assert_eq!(fill(&s[2]), BLUE);
    assert_eq!(fill(&s[3]), BLUE);
    assert_eq!(fill(&s[4]), BLUE);
  }

  const GREEN: Paint = Paint::Color(ColorValue::Rgba(Rgba {
    rgb: [0, 128, 0],
    a: 1.0,
  }));
  const BLACK: Paint = Paint::Color(ColorValue::Rgba(Rgba::BLACK));

  /// The style of a `<rect {attrs}>` in a `<g style="--c: green">`, with
  /// `<style>{css}</style>`.
  fn rect_style(css: &str, attrs: &str) -> Style {
    let s = styles(&format!(
      r#"<svg xmlns="{SVG_NS}"><style>{css}</style><g style="--c: green"><rect {attrs}/></g></svg>"#
    ));
    s[3].clone()
  }

  #[test]
  fn revert_layer_rolls_back_like_blink() {
    // Chrome 155: revert-layer goes to the highest declaration of a lower
    // layer, layers compared without importance; presentation attributes
    // are below every layer and style="" above all of them.
    let cases = [
      (
        "@layer a,b; @layer a{rect{fill:red}} @layer b{rect{fill:revert-layer}}",
        "",
        RED,
      ),
      (
        "@layer a{rect{fill:revert-layer}}",
        r#"fill="green""#,
        GREEN,
      ),
      (
        "@layer a{rect{fill:red}} rect{fill:blue}",
        r#"style="fill:revert-layer""#,
        BLUE,
      ),
      (
        "@layer a,b; @layer a{rect{fill:red}} @layer b{rect{fill:revert-layer !important}}",
        "",
        RED,
      ),
      (
        "@layer a,b; @layer b{rect{fill:red !important}} @layer a{rect{fill:revert-layer !important}}",
        "",
        BLACK,
      ),
      (
        "@layer a{rect{fill:red}} rect{fill:blue} rect{fill:revert-layer !important}",
        "",
        RED,
      ),
      (
        "@layer a{rect{fill:red !important}}",
        r#"style="fill:revert-layer !important""#,
        RED,
      ),
      (
        "@layer a,b,c; @layer a{rect{fill:red}} @layer b{rect{fill:revert-layer}} @layer c{rect{fill:revert-layer}}",
        "",
        RED,
      ),
      (
        "@layer a,b,c; @layer a{rect{fill:red}} @layer b{rect{fill:12px}} @layer c{rect{fill:revert-layer}}",
        "",
        RED,
      ),
      (
        "@layer a,b; @layer a{rect{fill:red}} @layer a{rect{fill:blue}} @layer b{rect{fill:REVERT-LAYER}}",
        "",
        BLUE,
      ),
      (
        "@layer a{rect{fill:red}} @layer a{rect{fill:revert-layer}}",
        "",
        BLACK,
      ),
      // Custom properties roll back too; with nothing below, they inherit.
      (
        "@layer a,b; @layer a{rect{--c:red}} @layer b{rect{--c:revert-layer}} rect{fill:var(--c,blue)}",
        "",
        RED,
      ),
      (
        "rect{--c:blue} rect{fill:var(--c)}",
        r#"style="--c:revert-layer""#,
        BLUE,
      ),
      (
        "@layer a,b; @layer a{rect{--c:red}} @layer b{rect{--c:revert-layer !important}} rect{fill:var(--c)}",
        "",
        RED,
      ),
      (
        "@layer a,b; @layer a{rect{--c:revert-layer}} @layer b{rect{--c:revert-layer}} rect{fill:var(--c,blue)}",
        "",
        GREEN,
      ),
      (
        "rect{--c:red} rect{--c:revert} rect{fill:var(--c,blue)}",
        "",
        GREEN,
      ),
    ];
    for (css, attrs, want) in cases {
      assert_eq!(fill(&rect_style(css, attrs)), want, "{css} {attrs}");
    }
  }

  #[test]
  fn revert_leaves_the_property_to_the_ua_sheet() {
    // Chrome 155 clips a nested <svg> whose overflow reverts (UA
    // overflow: hidden), and does not clip one whose overflow is unset or
    // reverts a layer down to overflow="visible".
    let declared = |css: &str, attrs: &str| {
      let s = styles(&format!(
        r#"<svg xmlns="{SVG_NS}"><style>{css}</style><svg {attrs}/></svg>"#
      ));
      s[2].declared(Prop::Overflow)
    };
    assert!(!declared(
      "",
      r#"overflow="visible" style="overflow:revert""#
    ));
    assert!(!declared("svg svg{overflow:revert-layer}", ""));
    assert!(declared(
      "svg svg{overflow:revert-layer}",
      r#"overflow="visible""#
    ));
    assert!(declared("svg svg{overflow:unset}", ""));
  }

  #[test]
  fn var_cycles_and_fallbacks() {
    let s = styles(&format!(
      r#"<svg xmlns="{SVG_NS}" style="--c: blue"><rect style="fill: var(--c)"/>
      <rect style="--a: var(--b); --b: var(--a); fill: var(--a, red)"/>
      <rect style="fill: var(--missing, var(--c))"/></svg>"#
    ));
    assert_eq!(fill(&s[1]), BLUE);
    assert_eq!(fill(&s[2]), RED);
    assert_eq!(fill(&s[3]), BLUE);
  }

  #[test]
  fn custom_properties_are_capped_like_blink() {
    // 28 doublings of "xx" pass MAX_VARIABLE_BYTES long before the end.
    let mut decls = String::from("--v0: xx;");
    for i in 1..=28 {
      decls.push_str(&format!("--v{i}: var(--v{}) var(--v{});", i - 1, i - 1));
    }
    let s = styles(&format!(
      r#"<svg xmlns="{SVG_NS}"><rect style="{decls} fill: var(--v28, red)"/></svg>"#
    ));
    assert_eq!(fill(&s[1]), RED);
    assert!(lookup(&s[1].custom, "--v28").is_none());
  }

  #[test]
  fn custom_property_cap_is_blinks_boundary() {
    // Chrome 155 (safety.cjs var_cap_*): a 2,097,152-byte value substitutes,
    // one byte more does not, also through another custom property.
    for (len, valid) in [(MAX_VARIABLE_BYTES, true), (MAX_VARIABLE_BYTES + 1, false)] {
      let value = "5".repeat(len);
      let s = styles(&format!(
        r#"<svg xmlns="{SVG_NS}"><rect style="--d: {value}; --e: var(--d)"/></svg>"#
      ));
      let e = lookup(&s[1].custom, "--e");
      assert_eq!(e.is_some(), valid, "{len}");
      if let Some(e) = e {
        assert_eq!(e.len(), len);
        assert_eq!(
          substitute("var(--e)", &s[1].custom).map(|t| t.len()),
          Some(len)
        );
      }
    }
  }

  #[test]
  fn substituted_values_keep_their_tokens_apart() {
    let s = styles(&format!(
      r#"<svg xmlns="{SVG_NS}"><rect style="--n: 10; --c: blue"/></svg>"#
    ));
    let custom = &s[1].custom;
    assert_eq!(substitute("var(--n)px", custom).as_deref(), Some("10 px"));
    assert_eq!(
      substitute("var(--n)var(--n)", custom).as_deref(),
      Some("10 10")
    );
    assert_eq!(substitute("var(--c)", custom).as_deref(), Some("blue"));
    assert_eq!(
      substitute("rgb(var(--n),0,0)", custom).as_deref(),
      Some("rgb(10,0,0)")
    );
    assert_eq!(
      substitute("a.b var(--c)", custom).as_deref(),
      Some("a.b blue")
    );
  }

  #[test]
  fn inherited_custom_properties_are_shared() {
    let big = "a".repeat(100_000);
    let s = styles(&format!(
      r#"<svg xmlns="{SVG_NS}"><g style="--big: {big}"><rect/><rect/></g></svg>"#
    ));
    let g = s[1].custom.as_ref().unwrap();
    assert!(Rc::ptr_eq(g, s[2].custom.as_ref().unwrap()));
    assert!(Rc::ptr_eq(g, s[3].custom.as_ref().unwrap()));
  }
}
