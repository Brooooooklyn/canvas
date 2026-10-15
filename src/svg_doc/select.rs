//! Selector matching on the SVG tree with the `selectors` crate (the crate
//! family of our cssparser dependency). XML rules: element names, ids and
//! classes match case-sensitively. User-action and link pseudo-classes parse
//! but never match: an SVG image is inert (Chrome 155: `:link`, `:any-link`
//! and `:hover` measured not matching).

use std::borrow::Borrow;
use std::collections::HashMap;
use std::fmt;

use cssparser::{CowRcStr, ParseError, ToCss};
use precomputed_hash::PrecomputedHash;
use selectors::attr::{AttrSelectorOperation, CaseSensitivity, NamespaceConstraint};
use selectors::bloom::BloomFilter;
use selectors::context::{
  MatchingContext, MatchingForInvalidation, MatchingMode, NeedsSelectorFlags, QuirksMode,
  SelectorCaches,
};
use selectors::matching::ElementSelectorFlags;
use selectors::parser::{
  AncestorHashes, Component, ParseRelative, Selector, SelectorList, SelectorParseErrorKind,
};
use selectors::{Element, OpaqueElement};

use super::dom::{Doc, NodeData, NodeId, Ns, SVG_NS, XLINK_NS, XML_NS};

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub(crate) struct Ident(pub String);

impl<'a> From<&'a str> for Ident {
  fn from(s: &'a str) -> Self {
    Ident(s.to_owned())
  }
}

impl ToCss for Ident {
  fn to_css<W: fmt::Write>(&self, dest: &mut W) -> fmt::Result {
    cssparser::serialize_identifier(&self.0, dest)
  }
}

/// FNV-1a: the hash the ancestor bloom filter files names under.
fn name_hash(s: &str) -> u32 {
  let mut hash: u32 = 0x811c_9dc5;
  for byte in s.bytes() {
    hash = (hash ^ byte as u32).wrapping_mul(0x0100_0193);
  }
  hash
}

impl PrecomputedHash for Ident {
  fn precomputed_hash(&self) -> u32 {
    name_hash(&self.0)
  }
}

impl Borrow<str> for Ident {
  fn borrow(&self) -> &str {
    &self.0
  }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AttrValue(pub String);

impl<'a> From<&'a str> for AttrValue {
  fn from(s: &'a str) -> Self {
    AttrValue(s.to_owned())
  }
}

impl AsRef<str> for AttrValue {
  fn as_ref(&self) -> &str {
    &self.0
  }
}

impl ToCss for AttrValue {
  fn to_css<W: fmt::Write>(&self, dest: &mut W) -> fmt::Result {
    cssparser::serialize_string(&self.0, dest)
  }
}

/// A pseudo-class Blink parses that can never match in an SVG image.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NeverPseudoClass(String);

impl ToCss for NeverPseudoClass {
  fn to_css<W: fmt::Write>(&self, dest: &mut W) -> fmt::Result {
    write!(dest, ":{}", self.0)
  }
}

impl selectors::parser::NonTSPseudoClass for NeverPseudoClass {
  fn is_active_or_hover(&self) -> bool {
    false
  }

  fn is_user_action_state(&self) -> bool {
    false
  }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NeverPseudoElement(String);

impl ToCss for NeverPseudoElement {
  fn to_css<W: fmt::Write>(&self, dest: &mut W) -> fmt::Result {
    write!(dest, "::{}", self.0)
  }
}

impl selectors::parser::PseudoElement for NeverPseudoElement {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Impl;

impl selectors::parser::SelectorImpl for Impl {
  type ExtraMatchingData<'a> = ();
  type AttrValue = AttrValue;
  type Identifier = Ident;
  type LocalName = Ident;
  type NamespaceUrl = Ident;
  type NamespacePrefix = Ident;
  type BorrowedNamespaceUrl = str;
  type BorrowedLocalName = str;
  type NonTSPseudoClass = NeverPseudoClass;
  type PseudoElement = NeverPseudoElement;
}

const NEVER_PSEUDO_CLASSES: &[&str] = &[
  "link",
  "visited",
  "any-link",
  "hover",
  "active",
  "focus",
  "focus-visible",
  "focus-within",
  "target",
  "target-within",
  "checked",
  "default",
  "disabled",
  "enabled",
  "indeterminate",
  "placeholder-shown",
  "autofill",
  "-webkit-autofill",
  "valid",
  "invalid",
  "required",
  "optional",
  "read-only",
  "read-write",
  "in-range",
  "out-of-range",
  "fullscreen",
  "modal",
  "picture-in-picture",
  "playing",
  "paused",
  "defined",
  "popover-open",
  "open",
  "closed",
  "user-valid",
  "user-invalid",
  "local-link",
  "scope",
  "past",
  "current",
  "future",
];

const NEVER_PSEUDO_ELEMENTS: &[&str] = &[
  "before",
  "after",
  "first-line",
  "first-letter",
  "marker",
  "placeholder",
  "selection",
  "backdrop",
  "file-selector-button",
  "-webkit-scrollbar",
  "cue",
  "target-text",
  "spelling-error",
  "grammar-error",
  "highlight",
];

/// Selector parsing with the namespaces of the sheet's `@namespace` rules.
#[derive(Default)]
pub(crate) struct SelectorParser {
  pub default_ns: Option<String>,
  pub prefixes: Vec<(String, String)>,
}

impl<'i> selectors::parser::Parser<'i> for SelectorParser {
  type Impl = Impl;
  type Error = SelectorParseErrorKind;

  fn parse_is_and_where(&self) -> bool {
    true
  }

  fn parse_has(&self) -> bool {
    true
  }

  fn parse_nth_child_of(&self) -> bool {
    true
  }

  fn parse_non_ts_pseudo_class(
    &self,
    name: CowRcStr<'i>,
  ) -> Result<NeverPseudoClass, ParseError<Self::Error>> {
    let lower = name.to_ascii_lowercase();
    if NEVER_PSEUDO_CLASSES.contains(&lower.as_str()) {
      return Ok(NeverPseudoClass(lower));
    }
    Err(ParseError::custom(
      SelectorParseErrorKind::UnsupportedPseudoClassOrElement,
    ))
  }

  fn parse_pseudo_element(
    &self,
    name: CowRcStr<'i>,
  ) -> Result<NeverPseudoElement, ParseError<Self::Error>> {
    let lower = name.to_ascii_lowercase();
    if NEVER_PSEUDO_ELEMENTS.contains(&lower.as_str()) {
      return Ok(NeverPseudoElement(lower));
    }
    Err(ParseError::custom(
      SelectorParseErrorKind::UnsupportedPseudoClassOrElement,
    ))
  }

  fn default_namespace(&self) -> Option<Ident> {
    self.default_ns.as_deref().map(Ident::from)
  }

  fn namespace_for_prefix(&self, prefix: &Ident) -> Option<Ident> {
    self
      .prefixes
      .iter()
      .find(|(p, _)| *p == prefix.0)
      .map(|(_, url)| Ident(url.clone()))
  }
}

pub(crate) fn parse_selector_list(
  parser: &SelectorParser,
  input: &mut cssparser::Parser,
) -> Option<SelectorList<Impl>> {
  SelectorList::parse(parser, input, ParseRelative::No).ok()
}

/// An element as selectors see it. Inside a `<use>` instance, `scope` is
/// the instance root: the root has no parent and no siblings, and nothing
/// outside the instance matches (Blink matches use shadow trees on their
/// own).
#[derive(Clone, Copy)]
pub(crate) struct El<'a> {
  pub doc: &'a Doc,
  pub id: NodeId,
  pub scope: Option<NodeId>,
}

impl fmt::Debug for El<'_> {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "El({}, {:?})", self.id, self.scope)
  }
}

impl El<'_> {
  fn with(&self, id: NodeId) -> Self {
    El {
      doc: self.doc,
      id,
      scope: self.scope,
    }
  }

  fn is_scope_root(&self) -> bool {
    self.scope == Some(self.id)
  }

  fn ns_url(&self) -> &'static str {
    match &self.doc.nodes[self.id].data {
      NodeData::Element { ns: Ns::Svg, .. } => SVG_NS,
      NodeData::Element { ns: Ns::None, .. } => "",
      _ => "\u{0}other",
    }
  }

  fn siblings(&self) -> Option<&[NodeId]> {
    if self.is_scope_root() {
      return None;
    }
    let parent = self.doc.nodes[self.id].parent?;
    Some(&self.doc.nodes[parent].children)
  }
}

fn attr_ns_url(ns: Ns) -> &'static str {
  match ns {
    Ns::None => "",
    Ns::Xlink => XLINK_NS,
    Ns::Xml => XML_NS,
    Ns::Svg => SVG_NS,
    Ns::Other => "\u{0}other",
  }
}

fn is_class_space(c: char) -> bool {
  matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0c')
}

impl Element for El<'_> {
  type Impl = Impl;

  fn opaque(&self) -> OpaqueElement {
    OpaqueElement::new(&self.doc.nodes[self.id])
  }

  fn parent_element(&self) -> Option<Self> {
    if self.is_scope_root() {
      return None;
    }
    self.doc.nodes[self.id].parent.map(|p| self.with(p))
  }

  fn parent_node_is_shadow_root(&self) -> bool {
    false
  }

  fn containing_shadow_host(&self) -> Option<Self> {
    None
  }

  fn is_pseudo_element(&self) -> bool {
    false
  }

  fn prev_sibling_element(&self) -> Option<Self> {
    let siblings = self.siblings()?;
    let at = siblings.iter().position(|c| *c == self.id)?;
    siblings[..at]
      .iter()
      .rev()
      .find(|c| self.doc.is_element(**c))
      .map(|c| self.with(*c))
  }

  fn next_sibling_element(&self) -> Option<Self> {
    let siblings = self.siblings()?;
    let at = siblings.iter().position(|c| *c == self.id)?;
    siblings[at + 1..]
      .iter()
      .find(|c| self.doc.is_element(**c))
      .map(|c| self.with(*c))
  }

  fn first_element_child(&self) -> Option<Self> {
    self
      .doc
      .element_children(self.id)
      .next()
      .map(|c| self.with(c))
  }

  fn is_html_element_in_html_document(&self) -> bool {
    false
  }

  fn has_local_name(&self, local_name: &str) -> bool {
    match &self.doc.nodes[self.id].data {
      NodeData::Element { name, .. } => name == local_name,
      NodeData::Text(_) => false,
    }
  }

  fn has_namespace(&self, ns: &str) -> bool {
    self.ns_url() == ns
  }

  fn is_same_type(&self, other: &Self) -> bool {
    match (
      &self.doc.nodes[self.id].data,
      &other.doc.nodes[other.id].data,
    ) {
      (NodeData::Element { ns: a, name: x, .. }, NodeData::Element { ns: b, name: y, .. }) => {
        a == b && x == y
      }
      _ => false,
    }
  }

  fn attr_matches(
    &self,
    ns: &NamespaceConstraint<&Ident>,
    local_name: &Ident,
    operation: &AttrSelectorOperation<&AttrValue>,
  ) -> bool {
    self.doc.attrs(self.id).iter().any(|a| {
      a.name == local_name.0
        && match ns {
          NamespaceConstraint::Any => true,
          NamespaceConstraint::Specific(url) => attr_ns_url(a.ns) == url.0,
        }
        && operation.eval_str(&a.value)
    })
  }

  fn match_non_ts_pseudo_class(
    &self,
    _pc: &NeverPseudoClass,
    _context: &mut MatchingContext<Impl>,
  ) -> bool {
    false
  }

  fn match_pseudo_element(
    &self,
    _pe: &NeverPseudoElement,
    _context: &mut MatchingContext<Impl>,
  ) -> bool {
    false
  }

  fn apply_selector_flags(&self, _flags: ElementSelectorFlags) {}

  fn is_link(&self) -> bool {
    false
  }

  fn is_html_slot_element(&self) -> bool {
    false
  }

  fn has_id(&self, id: &Ident, case_sensitivity: CaseSensitivity) -> bool {
    self
      .doc
      .attr(self.id, "id")
      .is_some_and(|v| case_sensitivity.eq(v.as_bytes(), id.0.as_bytes()))
  }

  fn has_class(&self, name: &Ident, case_sensitivity: CaseSensitivity) -> bool {
    self.doc.attr(self.id, "class").is_some_and(|v| {
      v.split(is_class_space)
        .any(|c| !c.is_empty() && case_sensitivity.eq(c.as_bytes(), name.0.as_bytes()))
    })
  }

  fn has_custom_state(&self, _name: &Ident) -> bool {
    false
  }

  fn imported_part(&self, _name: &Ident) -> Option<Ident> {
    None
  }

  fn is_part(&self, _name: &Ident) -> bool {
    false
  }

  fn is_empty(&self) -> bool {
    self.doc.nodes[self.id]
      .children
      .iter()
      .all(|c| match &self.doc.nodes[*c].data {
        NodeData::Text(t) => t.is_empty(),
        NodeData::Element { .. } => false,
      })
  }

  fn is_root(&self) -> bool {
    self.id == self.doc.root && self.scope.is_none()
  }

  fn add_element_unique_hashes(&self, _filter: &mut BloomFilter) -> bool {
    false
  }
}

/// The specificity of `selector` when it matches `el`. `ancestors` holds
/// the hashes of el's ancestors (`element_hashes`).
pub(crate) fn matches(
  selector: &Selector<Impl>,
  el: El,
  caches: &mut SelectorCaches,
  ancestors: &BloomFilter,
) -> Option<u32> {
  let mut context = MatchingContext::new(
    MatchingMode::Normal,
    Some(ancestors),
    caches,
    QuirksMode::NoQuirks,
    NeedsSelectorFlags::No,
    MatchingForInvalidation::No,
  );
  selectors::matching::matches_selector(selector, 0, None, &el, &mut context)
    .then(|| selector.specificity())
}

/// The hashes of `id` that the ancestor bloom filter holds while its
/// descendants match: what `AncestorHashes` takes from a selector (element
/// name, namespace, id, classes).
pub(crate) fn element_hashes(doc: &Doc, id: NodeId, out: &mut Vec<u32>) {
  let el = El {
    doc,
    id,
    scope: None,
  };
  let NodeData::Element { name, .. } = &doc.nodes[id].data else {
    return;
  };
  out.push(name_hash(name));
  out.push(name_hash(el.ns_url()));
  if let Some(v) = doc.attr(id, "id") {
    out.push(name_hash(v));
  }
  if let Some(classes) = doc.attr(id, "class") {
    out.extend(
      classes
        .split(is_class_space)
        .filter(|c| !c.is_empty())
        .map(name_hash),
    );
  }
}

/// Where a selector's subject is filed: its rightmost compound's id, else
/// a class, else its element name (Blink's RuleSet buckets). Others go to
/// the universal list.
enum Bucket {
  Id(String),
  Class(String),
  Tag(String),
  Universal,
}

fn bucket_of(selector: &Selector<Impl>) -> Bucket {
  let mut class = None;
  let mut tag = None;
  for component in selector.iter() {
    match component {
      Component::ID(id) => return Bucket::Id(id.0.clone()),
      Component::Class(c) if class.is_none() => class = Some(c.0.clone()),
      Component::LocalName(l) if tag.is_none() => tag = Some(l.name.0.clone()),
      _ => {}
    }
  }
  class
    .map(Bucket::Class)
    .or(tag.map(Bucket::Tag))
    .unwrap_or(Bucket::Universal)
}

/// A selector of a sheet: `rule` and its index in the rule's list, with
/// the hashes of the ancestors it needs.
#[derive(Clone)]
pub(crate) struct Entry {
  pub rule: u32,
  pub selector: u32,
  hashes: AncestorHashes,
}

impl Entry {
  /// False when the selector needs an ancestor that none of the ancestors
  /// in `ancestors` (`element_hashes`) can be: Blink's and Servo's ancestor
  /// bloom filter, which rejects most selectors without matching them.
  pub(crate) fn may_match(&self, ancestors: &BloomFilter) -> bool {
    selectors::matching::selector_may_match(&self.hashes, ancestors)
  }
}

/// The selectors of a sheet filed by subject, each list in sheet order.
#[derive(Default)]
pub(crate) struct RuleIndex {
  ids: HashMap<String, Vec<Entry>>,
  classes: HashMap<String, Vec<Entry>>,
  tags: HashMap<String, Vec<Entry>>,
  universal: Vec<Entry>,
}

impl RuleIndex {
  pub(crate) fn add(&mut self, rule: u32, list: &SelectorList<Impl>) {
    for (i, selector) in list.slice().iter().enumerate() {
      let entry = Entry {
        rule,
        selector: i as u32,
        hashes: AncestorHashes::new(selector, QuirksMode::NoQuirks),
      };
      match bucket_of(selector) {
        Bucket::Id(id) => self.ids.entry(id).or_default().push(entry),
        Bucket::Class(c) => self.classes.entry(c).or_default().push(entry),
        Bucket::Tag(t) => self.tags.entry(t).or_default().push(entry),
        Bucket::Universal => self.universal.push(entry),
      }
    }
  }

  /// The lists of selectors that may match `el`, into `out`. Each list is
  /// in sheet order and a selector is in one list only.
  pub(crate) fn candidates<'s>(&'s self, el: El, out: &mut Vec<&'s [Entry]>) {
    out.clear();
    let doc = el.doc;
    out.push(&self.universal);
    if let Some(list) = doc.attr(el.id, "id").and_then(|id| self.ids.get(id)) {
      out.push(list);
    }
    if let Some(classes) = doc.attr(el.id, "class") {
      let mut seen: Vec<&str> = Vec::new();
      for class in classes.split(is_class_space).filter(|c| !c.is_empty()) {
        if seen.contains(&class) {
          continue;
        }
        seen.push(class);
        if let Some(list) = self.classes.get(class) {
          out.push(list);
        }
      }
    }
    if let NodeData::Element { name, .. } = &doc.nodes[el.id].data
      && let Some(list) = self.tags.get(name)
    {
      out.push(list);
    }
    out.retain(|l| !l.is_empty());
  }
}
