//! The cascade: presentation attributes, style sheets and `style=""` in
//! Blink's order, CSS-wide keywords, inheritance, and custom properties with
//! `var()`.

use std::borrow::Cow;
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::hash::Hash;
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

/// How many bytes of new substituted text one SVG image (its nested SVG
/// images included) may build; past that, what `var()` would build is
/// invalid (a custom property is guaranteed-invalid, a property is invalid
/// at computed-value time). Values shared or reused from the memos below
/// cost nothing. Blink has no such budget: it copies every substituted
/// value until its renderer runs out of memory (decision 13 Q10, G4).
pub(crate) const VAR_TEXT_BUDGET: usize = 256 << 20;

/// What the memos of one cascade may hold (keys, in declarations) before
/// they start over.
const MEMO_LIMIT: usize = 1 << 16;

/// The custom properties an element declares, over the ones it inherits.
/// Elements that declare none share their parent's scope.
pub(crate) struct CustomScope {
  /// Unique in its cascade: what the memos key on.
  id: u64,
  parent: Option<Rc<CustomScope>>,
  /// None is the guaranteed-invalid value.
  vars: HashMap<Rc<str>, Option<Rc<str>>>,
}

fn scope_id(scope: &Option<Rc<CustomScope>>) -> u64 {
  scope.as_ref().map_or(0, |s| s.id)
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

/// A declaration that applies to an element. Name and value borrow from
/// the document, the sheet or a parsed style attribute where they can.
struct Candidate<'a> {
  priority: Priority,
  layer: LayerKey,
  /// None for a custom property.
  prop: Option<Prop>,
  name: Cow<'a, str>,
  value: Cow<'a, str>,
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

/// Where a declaration's text is. Borrowed text is in the document, the
/// sheet or a parsed style attribute of the cascade, none of which moves or
/// goes away while the cascade lives, so its address names it.
type TextId = (usize, usize);

impl Candidate<'_> {
  /// `text` is the value or a part of it.
  fn value_id(&self, text: &str) -> Option<TextId> {
    matches!(self.value, Cow::Borrowed(_)).then_some((text.as_ptr() as usize, text.len()))
  }

  fn name_id(&self) -> Option<TextId> {
    matches!(self.name, Cow::Borrowed(_)).then_some((self.name.as_ptr() as usize, self.name.len()))
  }
}

/// The declarations of each custom property of an element, highest
/// priority first.
type CustomDecls<'r> = HashMap<&'r str, Vec<(LayerKey, &'r str, Option<TextId>)>>;

/// The name in `text` when it is exactly `var(--name)`: substituting it
/// gives that property's value as it is (see substitute_block), so the
/// value can be shared instead.
fn bare_var(text: &str) -> Option<String> {
  let mut p = Parser::new(text);
  match p.next_including_whitespace_and_comments() {
    Ok(Token::Function(name)) if name.eq_ignore_ascii_case("var") => {}
    _ => return None,
  }
  let name = p
    .parse_nested_block(|i| -> Result<String, ParseError<()>> {
      i.skip_whitespace();
      let name = i.expect_ident_cloned()?.to_string();
      i.skip_whitespace();
      i.expect_exhausted()?;
      Ok(name)
    })
    .ok()?;
  (name.starts_with("--") && p.next_including_whitespace_and_comments().is_err()).then_some(name)
}

/// A map that forgets everything once its keys reach MEMO_LIMIT.
struct Memo<K, V> {
  map: HashMap<K, V>,
  size: usize,
}

impl<K: Hash + Eq, V> Memo<K, V> {
  fn new() -> Self {
    Memo {
      map: HashMap::new(),
      size: 0,
    }
  }

  fn get(&self, key: &K) -> Option<&V> {
    self.map.get(key)
  }

  fn insert(&mut self, key: K, size: usize, value: V) {
    if self.size + size > MEMO_LIMIT {
      self.map.clear();
      self.size = 0;
    }
    self.size += size;
    self.map.insert(key, value);
  }
}

/// The parent's scope and the custom-property declarations of an element,
/// highest priority first.
type ScopeKey = (u64, Vec<(TextId, TextId, LayerKey)>);

/// A declaration with var() of a property: the text, the property, whether
/// it is a presentation attribute, the font size (em), the custom scope.
type ValueKey = (TextId, u8, bool, u32, u64);

pub(crate) struct Cascade<'a> {
  pub doc: &'a Doc,
  pub sheet: &'a Sheet,
  /// What percentages and viewport units resolve against.
  pub viewport: (f32, f32),
  /// Per `<use>` instance scope: nth-child caches key on the element, and
  /// an element matches differently inside an instance.
  caches: HashMap<Option<NodeId>, SelectorCaches>,
  ancestors: Ancestors,
  /// What is left of VAR_TEXT_BUDGET, shared with the cascades of nested
  /// SVG images.
  var_budget: Rc<Cell<usize>>,
  /// Parsed style attributes by text: elements with the same one share its
  /// declarations, and so the memos.
  inline: HashMap<&'a str, Rc<[Decl]>>,
  /// Custom property names, one copy each.
  names: HashSet<Rc<str>>,
  /// Custom property values without var(), by declaration: one copy each.
  plain: HashMap<TextId, Option<Rc<str>>>,
  /// Custom scopes by parent scope and declarations: siblings with the same
  /// custom properties share one (and the substitutions that use it).
  scopes: Memo<ScopeKey, Rc<CustomScope>>,
  /// What declarations with var() compute to (Blink reuses whole styles
  /// through its MatchedPropertiesCache).
  values: Memo<ValueKey, Option<Value>>,
  scope_ids: u64,
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
  pub(crate) fn new(
    doc: &'a Doc,
    sheet: &'a Sheet,
    viewport: (f32, f32),
    var_budget: Rc<Cell<usize>>,
  ) -> Self {
    Cascade {
      doc,
      sheet,
      viewport,
      caches: HashMap::new(),
      ancestors: Ancestors::new(),
      var_budget,
      inline: HashMap::new(),
      names: HashSet::new(),
      plain: HashMap::new(),
      scopes: Memo::new(),
      values: Memo::new(),
      scope_ids: 0,
    }
  }

  /// The declarations of element `id`'s style attribute.
  fn inline_decls(&mut self, id: NodeId) -> Option<Rc<[Decl]>> {
    let text = self.doc.attr(id, "style")?;
    Some(
      self
        .inline
        .entry(text)
        .or_insert_with(|| parse_style_attr(text).into())
        .clone(),
    )
  }

  fn push_decl<'c>(
    out: &mut Vec<Candidate<'c>>,
    name: Cow<'c, str>,
    value: Cow<'c, str>,
    priority: Priority,
    layer: LayerKey,
  ) {
    let mut push = |name: Cow<'c, str>, value: Cow<'c, str>| {
      let prop = Prop::from_name(&name);
      if prop.is_some() || name.starts_with("--") {
        out.push(Candidate {
          priority,
          layer,
          prop,
          name,
          value,
          mode: Mode::Css,
        });
      }
    };
    if name == "font" {
      for (name, value) in expand_font(&value).unwrap_or_default() {
        push(Cow::Borrowed(name), Cow::Owned(value));
      }
    } else {
      push(name, value);
    }
  }

  fn candidates<'c>(
    &mut self,
    id: NodeId,
    scope: Option<NodeId>,
    inline: Option<&'c [Decl]>,
  ) -> Vec<Candidate<'c>>
  where
    'a: 'c,
  {
    let doc = self.doc;
    let sheet = self.sheet;
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
        name: Cow::Borrowed(&attr.name),
        value: Cow::Borrowed(&attr.value),
        mode: Mode::Attr,
      });
    }
    let el = El { doc, id, scope };
    let layers = sheet.layers.len() as u32;
    let mut matched: Vec<(u32, u32)> = Vec::new();
    let mut lists = Vec::new();
    sheet.index.candidates(el, &mut lists);
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
        let rule_selectors = &sheet.rules[rule as usize].selectors;
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
      let rule_ref = &sheet.rules[rule as usize];
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
        Self::push_decl(
          &mut out,
          Cow::Borrowed(&decl.name),
          Cow::Borrowed(&decl.value),
          priority,
          layer_key,
        );
      }
    }
    for decl in inline.unwrap_or_default() {
      let priority = Priority {
        important: decl.important,
        origin: 2,
        layer: 0,
        specificity: 0,
        order: next(),
      };
      Self::push_decl(
        &mut out,
        Cow::Borrowed(&decl.name),
        Cow::Borrowed(&decl.value),
        priority,
        (2, 0),
      );
    }
    out.sort_by_key(|c| c.priority);
    out
  }

  /// The computed style of element `id` (in the `<use>` instance rooted at
  /// `scope`, if any) whose parent's style is `parent`.
  pub(crate) fn compute(&mut self, id: NodeId, scope: Option<NodeId>, parent: &Style) -> Style {
    let inline = self.inline_decls(id);
    let candidates = self.candidates(id, scope, inline.as_deref());
    // The candidates of each property, highest priority first: from
    // `top[prop]` down through `next[i]`, linked in one pass.
    const NONE: usize = usize::MAX;
    let mut top = [NONE; COUNT];
    let mut next = vec![NONE; candidates.len()];
    for (i, c) in candidates.iter().enumerate() {
      if let Some(prop) = c.prop {
        next[i] = top[prop as usize];
        top[prop as usize] = i;
      }
    }
    let declarations = |prop: Prop| {
      let first = top[prop as usize];
      std::iter::successors((first != NONE).then_some(first), |&i| {
        (next[i] != NONE).then_some(next[i])
      })
      .map(|i| &candidates[i])
    };

    let customs: Vec<&Candidate> = candidates
      .iter()
      .rev()
      .filter(|c| c.prop.is_none())
      .collect();
    let custom = if customs.is_empty() {
      parent.custom.clone()
    } else {
      Some(self.custom_scope(&parent.custom, &customs))
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
      for c in declarations(prop) {
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
        if let Some(value) = self.var_value(c, text, prop, &ctx, &style.custom) {
          // None is invalid at computed-value time: unset.
          declared = true;
          result = value;
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

  /// The scope of the custom properties `customs` (highest priority first)
  /// over `inherited`.
  fn custom_scope(
    &mut self,
    inherited: &Option<Rc<CustomScope>>,
    customs: &[&Candidate],
  ) -> Rc<CustomScope> {
    let key: Option<ScopeKey> = customs
      .iter()
      .map(|c| Some((c.name_id()?, c.value_id(&c.value)?, c.layer)))
      .collect::<Option<Vec<_>>>()
      .map(|decls| (scope_id(inherited), decls));
    if let Some(scope) = key.as_ref().and_then(|k| self.scopes.get(k)) {
      return scope.clone();
    }
    let mut raw: CustomDecls = HashMap::new();
    for c in customs {
      let id = c.value_id(&c.value);
      raw
        .entry(&c.name)
        .or_default()
        .push((c.layer, &c.value, id));
    }
    let mut resolver = VarResolver {
      raw: &raw,
      inherited,
      resolved: HashMap::new(),
      stack: Vec::new(),
      budget: &self.var_budget,
      names: &mut self.names,
      plain: &mut self.plain,
    };
    let names: Vec<&str> = raw.keys().copied().collect();
    for name in names {
      resolver.resolve(name);
    }
    let vars = resolver.resolved;
    self.scope_ids += 1;
    let scope = Rc::new(CustomScope {
      id: self.scope_ids,
      parent: inherited.clone(),
      vars,
    });
    if let Some(key) = key {
      let size = 1 + key.1.len();
      self.scopes.insert(key, size, scope.clone());
    }
    scope
  }

  /// What declaration `c` of `prop` (its trimmed value `text`) computes to
  /// when it has var(): None inside is invalid at computed-value time.
  fn var_value(
    &mut self,
    c: &Candidate,
    text: &str,
    prop: Prop,
    ctx: &LenCtx,
    custom: &Option<Rc<CustomScope>>,
  ) -> Option<Option<Value>> {
    let key = c.value_id(text).map(|id| {
      (
        id,
        prop as u8,
        c.mode == Mode::Attr,
        ctx.font_size.to_bits(),
        scope_id(custom),
      )
    });
    if let Some(value) = key.as_ref().and_then(|k| self.values.get(k)) {
      return Some(value.clone());
    }
    if !has_var(text) {
      return None;
    }
    let value =
      substitute(text, custom, &self.var_budget).and_then(|s| parse_value(prop, &s, c.mode, ctx));
    if let Some(key) = key {
      self.values.insert(key, 1, value.clone());
    }
    Some(value)
  }
}

struct VarResolver<'r> {
  raw: &'r CustomDecls<'r>,
  inherited: &'r Option<Rc<CustomScope>>,
  resolved: HashMap<Rc<str>, Option<Rc<str>>>,
  stack: Vec<&'r str>,
  budget: &'r Cell<usize>,
  names: &'r mut HashSet<Rc<str>>,
  plain: &'r mut HashMap<TextId, Option<Rc<str>>>,
}

fn intern(names: &mut HashSet<Rc<str>>, name: &str) -> Rc<str> {
  if let Some(n) = names.get(name) {
    return n.clone();
  }
  let n: Rc<str> = Rc::from(name);
  names.insert(n.clone());
  n
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
        let name = intern(self.names, s);
        self.resolved.insert(name, None);
      }
      return None;
    }
    // revert-layer rolls back to the highest declaration of a lower layer;
    // with none left, the property reverts.
    let mut below: Option<LayerKey> = None;
    let text = decls.iter().find_map(|&(layer, text, id)| {
      if below.is_some_and(|b| layer >= b) {
        return None;
      }
      if css_wide(text) == Some("revert-layer") {
        below = Some(layer);
        return None;
      }
      Some((text, id))
    });
    let value = match text.map(|(t, id)| (t, id, css_wide(t))) {
      Some((_, _, Some("initial"))) => None,
      // inherit, unset, and revert (no user or UA declarations to go back
      // to: unset, which inherits).
      None | Some((_, _, Some(_))) => lookup(self.inherited, name),
      Some((text, _, None))
        if text.len() > MAX_VARIABLE_BYTES || self.stack.len() >= MAX_VAR_DEPTH =>
      {
        None
      }
      // Built before from the same declaration, which has no var().
      Some((_, Some(id), None)) if self.plain.contains_key(&id) => self.plain[&id].clone(),
      Some((text, id, None)) => {
        let plain = !has_var(text);
        self.stack.push(key);
        let value = match bare_var(text) {
          // Exactly var(--x): --x's value, shared.
          Some(target) => self.resolve(&target),
          None => {
            let budget = self.budget;
            substitute_with(text, &mut |n| self.resolve(n), budget).map(Rc::from)
          }
        };
        self.stack.pop();
        let value = if self.resolved.get(key) == Some(&None) {
          None
        } else {
          value
        };
        if plain && let Some(id) = id {
          self.plain.insert(id, value.clone());
        }
        value
      }
    };
    let name = intern(self.names, key);
    self.resolved.insert(name, value.clone());
    value
  }
}

/// `text` with every `var()` replaced, or None when one has no value and no
/// fallback, the result is longer than MAX_VARIABLE_BYTES, or `budget` (in
/// bytes) runs out.
pub(crate) fn substitute(
  text: &str,
  custom: &Option<Rc<CustomScope>>,
  budget: &Cell<usize>,
) -> Option<String> {
  substitute_with(text, &mut |name| lookup(custom, name), budget)
}

/// What it builds, it takes from `budget`, whether it ends well or not.
fn substitute_with(
  text: &str,
  lookup: &mut dyn FnMut(&str) -> Option<Rc<str>>,
  budget: &Cell<usize>,
) -> Option<String> {
  let mut p = Parser::new(text);
  let mut out = Substituted::default();
  let ok = substitute_block(&mut p, lookup, &mut out, budget);
  budget.set(budget.get().saturating_sub(out.text.len()));
  ok.then_some(out.text)
}

/// A var() substituted: another property's value, or its fallback.
enum Piece {
  Value(Rc<str>),
  Fallback(String),
}

impl Piece {
  fn as_str(&self) -> &str {
    match self {
      Piece::Value(v) => v,
      Piece::Fallback(f) => f,
    }
  }
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
  budget: &Cell<usize>,
) -> bool {
  loop {
    if out.len() > MAX_VARIABLE_BYTES || out.text.len() > budget.get() {
      return false;
    }
    let start = p.position();
    let token = match p.next_including_whitespace_and_comments() {
      Ok(t) => t.clone(),
      Err(_) => return true,
    };
    match token {
      Token::Function(ref name) if name.eq_ignore_ascii_case("var") => {
        let value = p.parse_nested_block(|i| -> Result<Option<Piece>, ParseError<()>> {
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
            Some(v) => Some(Piece::Value(v)),
            None => fallback
              .and_then(|f| substitute_with(&f, lookup, budget))
              .map(Piece::Fallback),
          })
        });
        match value {
          // TokenSequence::Append (style_cascade.cc:1078-1084): a value that
          // would make the result longer than the cap is invalid.
          Ok(Some(v))
            if out.len() + v.as_str().len() <= MAX_VARIABLE_BYTES
              && out.text.len() + v.as_str().len() <= budget.get() =>
          {
            out.push_value(v.as_str());
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
          .parse_nested_block(|i| Ok::<_, ParseError<()>>(substitute_block(i, lookup, out, budget)))
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
    styles_with_budget(svg, VAR_TEXT_BUDGET).0
  }

  /// The computed styles of every element, and the bytes of substituted
  /// text built.
  fn styles_with_budget(svg: &str, budget: usize) -> (Vec<Style>, usize) {
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
    let left = Rc::new(Cell::new(budget));
    let mut cascade = Cascade::new(&doc, &sheet, (100.0, 100.0), left.clone());
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
    drop(cascade);
    (out, budget - left.get())
  }

  fn sub(text: &str, custom: &Option<Rc<CustomScope>>) -> Option<String> {
    substitute(text, custom, &Cell::new(usize::MAX))
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
        assert_eq!(sub("var(--e)", &s[1].custom).map(|t| t.len()), Some(len));
      }
    }
  }

  #[test]
  fn substituted_values_keep_their_tokens_apart() {
    let s = styles(&format!(
      r#"<svg xmlns="{SVG_NS}"><rect style="--n: 10; --c: blue"/></svg>"#
    ));
    let custom = &s[1].custom;
    assert_eq!(sub("var(--n)px", custom).as_deref(), Some("10 px"));
    assert_eq!(sub("var(--n)var(--n)", custom).as_deref(), Some("10 10"));
    assert_eq!(sub("var(--c)", custom).as_deref(), Some("blue"));
    assert_eq!(
      sub("rgb(var(--n),0,0)", custom).as_deref(),
      Some("rgb(10,0,0)")
    );
    assert_eq!(sub("a.b var(--c)", custom).as_deref(), Some("a.b blue"));
  }

  /// A valid color of `len` bytes: green.
  fn big_green(len: usize) -> String {
    format!("rgb(0, 128,{} 0)", " ".repeat(len - 14))
  }

  #[test]
  fn bare_var_aliases_share_the_value() {
    let big = "a".repeat(100_000);
    let (s, built) = styles_with_budget(
      &format!(
        r#"<svg xmlns="{SVG_NS}"><g style="--big: {big}; --a1: var(--big); --a2: var( --a1 )"><rect style="--a3: var(--a2); --f: var(--big, x)"/></g></svg>"#
      ),
      VAR_TEXT_BUDGET,
    );
    let (g, rect) = (&s[1].custom, &s[2].custom);
    let value = lookup(g, "--big").unwrap();
    for (scope, name) in [(g, "--a1"), (g, "--a2"), (rect, "--a3")] {
      assert!(Rc::ptr_eq(&value, &lookup(scope, name).unwrap()), "{name}");
    }
    // With a fallback it is substituted: a copy.
    let f = lookup(rect, "--f").unwrap();
    assert!(!Rc::ptr_eq(&value, &f));
    assert_eq!(f, value);
    // --big once, --f once.
    assert_eq!(built, 2 * big.len());
  }

  #[test]
  fn elements_with_the_same_style_reuse_one_substitution() {
    let big = big_green(100_000);
    // Siblings with the same custom properties.
    let rects = r#"<rect style="--a: var(--big); fill: var(--a)"/>"#.repeat(64);
    let (s, built) = styles_with_budget(
      &format!(r#"<svg xmlns="{SVG_NS}"><g style="--big: {big}">{rects}</g></svg>"#),
      VAR_TEXT_BUDGET,
    );
    assert!(s[2..].iter().all(|s| fill(s) == GREEN));
    assert!(Rc::ptr_eq(
      s[2].custom.as_ref().unwrap(),
      s[65].custom.as_ref().unwrap()
    ));
    // --big once, fill once.
    assert_eq!(built, 2 * big.len());

    // Children that inherit 64 aliases.
    let mut decls = format!("--big: {big};");
    for i in 0..64 {
      decls += &format!(" --a{i}: var(--big);");
    }
    let rects = r#"<rect style="fill: var(--a63)"/>"#.repeat(64);
    let (s, built) = styles_with_budget(
      &format!(r#"<svg xmlns="{SVG_NS}"><g style="{decls}">{rects}</g></svg>"#),
      VAR_TEXT_BUDGET,
    );
    assert!(s[2..].iter().all(|s| fill(s) == GREEN));
    assert_eq!(built, 2 * big.len());

    // The same declaration at another font size is computed again.
    let s = styles(&format!(
      r#"<svg xmlns="{SVG_NS}" style="--w: 1em"><g font-size="10"><rect style="stroke-width: var(--w)"/></g><g font-size="20"><rect style="stroke-width: var(--w)"/></g></svg>"#
    ));
    assert_eq!(s[2].len(Prop::StrokeWidth).unwrap().px, 10.0);
    assert_eq!(s[4].len(Prop::StrokeWidth).unwrap().px, 20.0);
  }

  #[test]
  fn past_the_budget_var_values_are_invalid() {
    // Each rect has its own custom properties, so each substitutes the
    // 1000-byte value: after --big, three fit in 4500 bytes.
    let big = big_green(1000);
    let mut rects = String::new();
    for i in 0..10 {
      rects += &format!(r#"<rect fill="red" style="--i: {i}; --a: var(--big); fill: var(--a)"/>"#);
    }
    rects += r#"<rect style="--a: var(--big); --c: x var(--big)"/>"#;
    let (s, built) = styles_with_budget(
      &format!(r#"<svg xmlns="{SVG_NS}"><g fill="blue" style="--big: {big}">{rects}</g></svg>"#),
      4500,
    );
    let fills: Vec<Paint> = s[2..12].iter().map(fill).collect();
    // Invalid at computed-value time: fill inherits the <g>'s blue.
    assert_eq!(fills[..3], [GREEN, GREEN, GREEN]);
    assert!(fills[3..].iter().all(|f| *f == BLUE), "{fills:?}");
    assert!(built <= 4500);
    let last = &s[12].custom;
    // Past the budget, a custom property that needs new text is
    // guaranteed-invalid; a shared one still works.
    assert!(lookup(last, "--c").is_none());
    let value = lookup(&s[1].custom, "--big").unwrap();
    assert!(Rc::ptr_eq(&value, &lookup(last, "--a").unwrap()));
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
