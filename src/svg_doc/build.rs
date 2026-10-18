//! Writes the document SkSVGDOM draws: every element with its computed
//! presentation attributes, `<use>` instances expanded, Blink's rules for
//! what draws applied, and `<image>` turned into resources.
//!
//! The walk is iterative (a document may nest 5000 elements deep). A
//! reference to a resource is written as a patch, resolved once the whole
//! document is out: Blink ignores a reference to a resource that has no
//! layout object (one under `display: none`, or past the element budget).

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fmt::Write;
use std::rc::Rc;

use super::cascade::{Cascade, Style};
use super::dom::{Doc, MAX_TREE_DEPTH, NodeData, NodeId, Ns};
use super::props::{Mode, Prop, parse_value};
use super::sheet::{Env, Sheet, eval_media_list};
use super::values::*;
use super::{Loaded, Shared};
use crate::svg_size::{SvgSizing, layout_floor, root_length};

const SHAPES: &[&str] = &[
  "rect", "circle", "ellipse", "line", "polyline", "polygon", "path",
];
/// What a `<use>` in a `<clipPath>` may point at (svg_use_element.cc
/// IsDirectReference: no `<line>`).
const CLIP_DIRECT_REF: &[&str] = &[
  "path", "rect", "circle", "ellipse", "polygon", "polyline", "text",
];
const PAINT_SERVERS: &[&str] = &["linearGradient", "radialGradient", "pattern"];

/// The most primitives a `<filter>` keeps. SkSVG builds them into one
/// chain of image filters, which overflows the stack long before Chrome
/// stops drawing.
const MAX_FILTER_PRIMITIVES: usize = 1024;

/// Steps the resource cycle check may take for one document; past them a
/// reference counts as closing a cycle.
const CYCLE_CHECK_BUDGET: usize = 1 << 16;

/// Styles `style_at` keeps before starting over.
const STYLE_CACHE_LIMIT: usize = 4096;

pub(crate) enum Root {
  /// A top-level SVG image: laid out at whatever size it is drawn at.
  Top(SvgSizing),
  /// An SVG image in an `<image>`: its root laid out at this size.
  Nested((f32, f32)),
}

pub(crate) fn esc(s: &str) -> String {
  let mut o = String::with_capacity(s.len());
  for c in s.chars() {
    match c {
      '&' => o.push_str("&amp;"),
      '<' => o.push_str("&lt;"),
      '>' => o.push_str("&gt;"),
      '"' => o.push_str("&quot;"),
      '\n' => o.push_str("&#10;"),
      '\t' => o.push_str("&#9;"),
      '\r' => o.push_str("&#13;"),
      _ => o.push(c),
    }
  }
  o
}

/// An absolute URL: a scheme (RFC 3986) and ':'.
fn has_scheme(s: &str) -> bool {
  let Some(i) = s.find(':') else {
    return false;
  };
  let scheme = &s[..i];
  scheme
    .chars()
    .next()
    .is_some_and(|c| c.is_ascii_alphabetic())
    && scheme
      .chars()
      .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

/// color-interpolation-filters as SkSVG reads it: Blink filters work in
/// linearRGB only for `linearRGB`, `auto` is sRGB
/// (svg_filter_builder.cc:165-169).
fn filter_space(style: &Style) -> &'static str {
  if style.keyword(Prop::ColorInterpolationFilters) == "linearrgb" {
    "linearRGB"
  } else {
    "sRGB"
  }
}

/// svg_rect.cc SVGRect::Parse: four numbers, None when invalid.
pub(crate) fn parse_view_box(s: &str) -> Option<(f32, f32, f32, f32)> {
  let n: Vec<f32> = s
    .split(|c: char| c == ',' || c.is_ascii_whitespace())
    .filter(|s| !s.is_empty())
    .map(|s| s.parse::<f32>())
    .collect::<Result<_, _>>()
    .ok()?;
  (n.len() == 4 && n[2] >= 0.0 && n[3] >= 0.0).then(|| (n[0], n[1], n[2], n[3]))
}

/// An attribute written into an element's start tag.
#[derive(Clone, PartialEq)]
enum Piece {
  Attr(Cow<'static, str>, String),
  /// An attribute that depends on whether resource `target` was written:
  /// `ok` if it was, else `missing` (None drops the attribute).
  Ref {
    name: &'static str,
    target: NodeId,
    ok: String,
    missing: Option<String>,
  },
}

impl Piece {
  fn name(&self) -> &str {
    match self {
      Piece::Attr(n, _) => n,
      Piece::Ref { name, .. } => name,
    }
  }
}

fn attr(name: impl Into<Cow<'static, str>>, value: impl Into<String>) -> Piece {
  Piece::Attr(name.into(), value.into())
}

/// The inherited presentation attributes as written on an element (one
/// piece per name, in INHERITED_OUT order), for children to compare with.
type OutSet = Vec<Piece>;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Ctx {
  /// Drawn content.
  Normal,
  /// Inside `<defs>`, `<symbol>` or `<marker>` where they are defined:
  /// nothing draws, only resources (and paths a textPath may name) matter.
  Defs,
  /// The children of a `<clipPath>`.
  Clip,
  /// Inside a `<use>` in a `<clipPath>`: only its target.
  ClipUse,
  /// Inside `<text>`.
  Text,
}

enum Kids {
  /// The children of a node, from `next`.
  Children(NodeId, usize),
  /// One node.
  One(Option<NodeId>),
}

struct Frame {
  node: NodeId,
  style: Rc<Style>,
  out: Rc<OutSet>,
  kids: Kids,
  /// The `<use>` instance the children are in.
  kid_scope: Option<NodeId>,
  /// The children were borrowed from another element (a pattern's href):
  /// they carry no ids.
  no_ids: bool,
  ctx: Ctx,
  close: String,
  /// Leaving pops `Builder::resource_stack`.
  resource: bool,
}

impl Frame {
  fn next_kid(&mut self, doc: &Doc) -> Option<NodeId> {
    match &mut self.kids {
      Kids::Children(node, next) => {
        let kids = &doc.nodes[*node].children;
        while *next < kids.len() {
          let kid = kids[*next];
          *next += 1;
          if self.ctx == Ctx::Text || doc.is_element(kid) {
            return Some(kid);
          }
        }
        None
      }
      Kids::One(kid) => kid.take(),
    }
  }
}

/// What `enter` needs of the parent frame.
struct Parent {
  node: NodeId,
  style: Rc<Style>,
  out: Rc<OutSet>,
  scope: Option<NodeId>,
  no_ids: bool,
  ctx: Ctx,
}

struct Patch {
  at: usize,
  /// The resource whose content holds the reference.
  owner: Option<NodeId>,
  target: NodeId,
  ok: String,
  missing: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EdgeState {
  NeedCheck,
  PerformingCheck,
  NoCycle,
  HasCycle,
}

/// Blink's resource cycle solver (svg_resource.cc:138-194,
/// layout_svg_resource_container.cc:241-306) over the references the
/// resources' content makes. References are checked in document order;
/// the one that closes a cycle in that walk is dropped (Chrome 155:
/// safety.cjs clip_mutual and mask_mutual keep the first reference).
#[derive(Default)]
struct CycleSolver {
  /// The resources each resource's content references, in document order.
  edges: HashMap<NodeId, Vec<NodeId>>,
  state: HashMap<(NodeId, NodeId), EdgeState>,
  /// Resources referenced from outside any resource: checked once.
  roots: HashMap<NodeId, bool>,
  steps: usize,
  cycles_broken: bool,
}

impl CycleSolver {
  /// How deep the check follows references; deeper ones count as cycles.
  const MAX_DEPTH: usize = 256;

  fn get(&self, edge: (NodeId, NodeId)) -> EdgeState {
    self
      .state
      .get(&edge)
      .copied()
      .unwrap_or(EdgeState::NeedCheck)
  }

  /// SVGResource::ResourceContainer: whether the reference from the
  /// content of `owner` (None: outside any resource) to `target` is used.
  fn used(&mut self, owner: Option<NodeId>, target: NodeId) -> bool {
    let Some(owner) = owner else {
      if let Some(used) = self.roots.get(&target) {
        return *used;
      }
      let used = !self.check(target, 0);
      self.roots.insert(target, used);
      return used;
    };
    let edge = (owner, target);
    if self.get(edge) == EdgeState::NeedCheck {
      self.state.insert(edge, EdgeState::PerformingCheck);
      let cycle = self.check(target, 0);
      self.state.insert(
        edge,
        if cycle {
          EdgeState::HasCycle
        } else {
          EdgeState::NoCycle
        },
      );
    }
    self.get(edge) != EdgeState::HasCycle
  }

  /// FindCycle of resource `r`, its references in order.
  fn check(&mut self, r: NodeId, depth: usize) -> bool {
    if depth >= Self::MAX_DEPTH || self.steps >= CYCLE_CHECK_BUDGET {
      return true;
    }
    self.steps += 1;
    let targets = self.edges.get(&r).cloned().unwrap_or_default();
    targets
      .into_iter()
      .any(|t| self.find_cycle(r, t, depth + 1))
  }

  /// SVGResource::FindCycle for the reference from `owner` to `target`.
  fn find_cycle(&mut self, owner: NodeId, target: NodeId, depth: usize) -> bool {
    let edge = (owner, target);
    match self.get(edge) {
      EdgeState::NeedCheck => {
        self.state.insert(edge, EdgeState::PerformingCheck);
        let cycle = self.check(target, depth);
        self.state.insert(
          edge,
          if cycle {
            EdgeState::HasCycle
          } else {
            EdgeState::NoCycle
          },
        );
        // The cycle is broken here.
        false
      }
      EdgeState::NoCycle => {
        self.state.insert(edge, EdgeState::PerformingCheck);
        let cycle = self.check(target, depth);
        self.state.insert(edge, EdgeState::NoCycle);
        cycle
      }
      EdgeState::PerformingCheck => true,
      EdgeState::HasCycle => false,
    }
  }

  /// Whether the reference is dropped after all: SkSVG follows references
  /// with no cycle check, so any cycle left among the used ones (when the
  /// budget ran out) is broken at its first back edge.
  fn dropped(&mut self, owner: Option<NodeId>, target: NodeId) -> bool {
    let Some(owner) = owner else {
      return false;
    };
    if self.state.get(&(owner, target)) == Some(&EdgeState::HasCycle) {
      return true;
    }
    if !self.cycles_broken {
      self.break_cycles();
      self.cycles_broken = true;
    }
    self.state.get(&(owner, target)) == Some(&EdgeState::HasCycle)
  }

  /// Marks the back edges of a depth-first walk over the used references.
  fn break_cycles(&mut self) {
    // 0 unseen, 1 on the walk, 2 done.
    let mut color: HashMap<NodeId, u8> = HashMap::new();
    let mut starts: Vec<NodeId> = self.edges.keys().copied().collect();
    starts.sort_unstable();
    for start in starts {
      if color.get(&start).copied().unwrap_or(0) != 0 {
        continue;
      }
      color.insert(start, 1);
      let mut walk: Vec<(NodeId, usize)> = vec![(start, 0)];
      while let Some((r, i)) = walk.last().copied() {
        let next = self.edges.get(&r).and_then(|t| t.get(i)).copied();
        let Some(t) = next else {
          color.insert(r, 2);
          walk.pop();
          continue;
        };
        walk.last_mut().unwrap().1 += 1;
        if self.state.get(&(r, t)) == Some(&EdgeState::HasCycle) {
          continue;
        }
        match color.get(&t).copied().unwrap_or(0) {
          0 => {
            color.insert(t, 1);
            walk.push((t, 0));
          }
          1 => {
            self.state.insert((r, t), EdgeState::HasCycle);
          }
          _ => {}
        }
      }
    }
  }
}

struct Builder<'d, 's, 'u> {
  doc: &'d Doc,
  ids: HashMap<&'d str, NodeId>,
  cascade: Cascade<'d>,
  shared: &'s mut Shared<'u>,
  /// What percentages resolve against.
  viewport: (f32, f32),
  /// Whether `viewport` is exact; when not, percentages are written as
  /// percentages for SkSVG to resolve.
  fixed_viewport: bool,
  out: String,
  /// Clip paths this module makes, written before the root closes.
  defs: String,
  patches: Vec<Patch>,
  written: HashSet<NodeId>,
  uid: u32,
  alpha_mask_filter: bool,
  style_cache: HashMap<NodeId, Rc<Style>>,
  /// Resources whose content is being written: the last one owns the
  /// references written now.
  resource_stack: Vec<NodeId>,
}

/// @supports (name: value): a property this module knows must parse the
/// value; another must be one Blink knows.
fn supports(name: &str, value: &str) -> bool {
  let name = name.trim().to_ascii_lowercase();
  if name.starts_with("--") {
    return true;
  }
  let ctx = LenCtx {
    font_size: ROOT_FONT_SIZE,
    viewport: (0.0, 0.0),
  };
  match Prop::from_name(&name) {
    Some(prop) => {
      let v = value.trim();
      ["inherit", "initial", "unset", "revert", "revert-layer"]
        .iter()
        .any(|k| v.eq_ignore_ascii_case(k))
        || parse_value(prop, v, Mode::Css, &ctx).is_some()
    }
    None => OTHER_PROPERTIES.contains(&name.as_str()),
  }
}

/// CSS properties Blink knows that this module does not cascade (a short
/// list: the ones SVG documents test for).
const OTHER_PROPERTIES: &[&str] = &[
  "accent-color",
  "alignment-baseline",
  "aspect-ratio",
  "backdrop-filter",
  "background",
  "background-color",
  "baseline-shift",
  "border",
  "clip",
  "color-scheme",
  "contain",
  "cursor",
  "direction",
  "dominant-baseline",
  "font",
  "font-variant",
  "isolation",
  "letter-spacing",
  "margin",
  "marker",
  "marker-end",
  "marker-mid",
  "marker-start",
  "mask-image",
  "mix-blend-mode",
  "padding",
  "pointer-events",
  "position",
  "shape-rendering",
  "text-decoration",
  "text-rendering",
  "unicode-bidi",
  "vector-effect",
  "white-space",
  "will-change",
  "word-spacing",
  "writing-mode",
  "z-index",
];

fn collect_sheet(doc: &Doc, media_viewport: (f32, f32)) -> Sheet {
  let mut sheet = Sheet::default();
  let env = Env {
    viewport: media_viewport,
    supports: &supports,
  };
  let mut stack = vec![doc.root];
  while let Some(n) = stack.pop() {
    if doc.svg_name(n) == Some("style") {
      let ty = doc.attr(n, "type").unwrap_or("").trim();
      let media_ok = doc
        .attr(n, "media")
        .is_none_or(|m| eval_media_list(m, &env));
      if (ty.is_empty() || ty.eq_ignore_ascii_case("text/css")) && media_ok {
        sheet.add_sheet(&doc.text_content(n), &env);
      }
      continue;
    }
    stack.extend(
      doc
        .element_children(n)
        .collect::<Vec<_>>()
        .into_iter()
        .rev(),
    );
  }
  sheet
}

fn collect_ids(doc: &Doc) -> HashMap<&str, NodeId> {
  let mut ids = HashMap::new();
  let mut stack = vec![doc.root];
  while let Some(n) = stack.pop() {
    if let Some(id) = doc.attr(n, "id") {
      ids.entry(id).or_insert(n);
    }
    stack.extend(
      doc
        .element_children(n)
        .collect::<Vec<_>>()
        .into_iter()
        .rev(),
    );
  }
  ids
}

/// The document `doc` as SkSVGDOM should get it, or None when its root is
/// not drawn.
pub(crate) fn emit_document(doc: &Doc, root: Root, shared: &mut Shared) -> Option<String> {
  let view_box = doc
    .attr(doc.root, "viewBox")
    .and_then(parse_view_box)
    .filter(|v| v.2 > 0.0 && v.3 > 0.0);
  let width = doc
    .attr(doc.root, "width")
    .and_then(|w| root_length(w, shared.units));
  let height = doc
    .attr(doc.root, "height")
    .and_then(|h| root_length(h, shared.units));
  // The layout size: known for a nested image and for a sized root; else a
  // guess (the size against the default 300x150) that only media queries
  // and lengths mixing px and % see.
  let (layout, sized) = match &root {
    Root::Top(sizing) => {
      let (w, h) = sizing.concrete((300.0, 150.0));
      (
        (layout_floor(w), layout_floor(h)),
        width.is_some() && height.is_some(),
      )
    }
    Root::Nested(size) => (*size, true),
  };
  let viewport = view_box.map(|v| (v.2, v.3)).unwrap_or(layout);
  let sheet = collect_sheet(doc, layout);
  let mut b = Builder {
    doc,
    ids: collect_ids(doc),
    cascade: Cascade::new(doc, &sheet, viewport, shared.var_budget.clone()),
    shared,
    viewport,
    fixed_viewport: view_box.is_some() || sized,
    out: String::new(),
    defs: String::new(),
    patches: Vec::new(),
    written: HashSet::new(),
    uid: 0,
    alpha_mask_filter: false,
    style_cache: HashMap::new(),
    resource_stack: Vec::new(),
  };
  let root_size = match root {
    Root::Top(_) => None,
    Root::Nested(size) => Some(size),
  };
  b.emit_root(root_size, view_box.is_some(), width.zip(height));
  Some(b.finish())
}

impl<'d> Builder<'d, '_, '_> {
  fn finish(self) -> String {
    // A reference to a resource that was not written (not rendered) is
    // invalid; so is one Blink's cycle solver drops.
    let mut solver = CycleSolver::default();
    for p in &self.patches {
      if let Some(owner) = p.owner
        && self.written.contains(&p.target)
      {
        let targets = solver.edges.entry(owner).or_default();
        if !targets.contains(&p.target) {
          targets.push(p.target);
        }
      }
    }
    let used: Vec<bool> = self
      .patches
      .iter()
      .map(|p| self.written.contains(&p.target) && solver.used(p.owner, p.target))
      .collect();
    let mut s = String::with_capacity(self.out.len());
    let mut at = 0;
    for (p, used) in self.patches.iter().zip(used) {
      s.push_str(&self.out[at..p.at]);
      s.push_str(if used && !solver.dropped(p.owner, p.target) {
        &p.ok
      } else {
        &p.missing
      });
      at = p.at;
    }
    s.push_str(&self.out[at..]);
    s
  }

  fn target(&self, url: &str) -> Option<NodeId> {
    local_ref(url).and_then(|id| self.ids.get(id).copied())
  }

  fn target_of_type(&self, url: &str, types: &[&str]) -> Option<NodeId> {
    self
      .target(url)
      .filter(|t| self.doc.svg_name(*t).is_some_and(|n| types.contains(&n)))
  }

  fn out_id(&self, node: NodeId) -> String {
    format!("_{node}")
  }

  fn len_ctx(&self, style: &Style) -> LenCtx {
    LenCtx {
      font_size: style.font_size(),
      viewport: self.viewport,
    }
  }

  /// The normalized diagonal, what other percentages resolve against.
  fn diagonal(&self) -> f32 {
    let (w, h) = self.viewport;
    ((w * w + h * h) / 2.0).sqrt()
  }

  /// A length as SkSVG reads it: a percentage stays one unless it is mixed
  /// with px.
  fn len_out(&self, l: Len, reference: f32) -> String {
    if self.fixed_viewport || l.px == 0.0 || l.pct == 0.0 {
      l.to_svg(reference)
    } else {
      num(l.resolve(reference))
    }
  }

  /// A length resolved now; None when it needs a viewport we do not know.
  fn len_now(&self, l: Len, reference: f32) -> Option<f32> {
    (self.fixed_viewport || l.is_absolute()).then(|| l.resolve(reference))
  }

  /// A length attribute (`x1`, `x` of `<use>`, ...) in the element's units.
  fn attr_len(&self, n: NodeId, name: &str, style: &Style) -> Option<Len> {
    let ctx = self.len_ctx(style);
    self
      .doc
      .attr(n, name)
      .and_then(|t| parse_with(t, |p| parse_len(p, &ctx, true)))
  }

  fn resolve_color(style: &Style, c: &ColorValue) -> Rgba {
    match c {
      ColorValue::Rgba(c) => *c,
      ColorValue::CurrentColor => match style.get(Prop::Color) {
        Value::Color(ColorValue::Rgba(c)) => *c,
        _ => Rgba::BLACK,
      },
    }
  }

  /// The computed style of an element where it is in the document (not in
  /// a `<use>` instance).
  fn style_at(&mut self, node: NodeId) -> Rc<Style> {
    if let Some(s) = self.style_cache.get(&node) {
      return s.clone();
    }
    if self.style_cache.len() > STYLE_CACHE_LIMIT {
      self.style_cache.clear();
    }
    let mut chain = vec![node];
    chain.extend(self.doc.ancestors(node));
    let mut style = Rc::new(Style::initial());
    for n in chain.into_iter().rev() {
      style = match self.style_cache.get(&n) {
        Some(s) => s.clone(),
        None => {
          let s = Rc::new(self.cascade.compute(n, None, &style));
          self.style_cache.insert(n, s.clone());
          s
        }
      };
    }
    style
  }

  // --- Writing ------------------------------------------------------------

  fn write_pieces(&mut self, pieces: &[Piece]) {
    for piece in pieces {
      match piece {
        Piece::Attr(name, value) => {
          write!(self.out, " {name}=\"{}\"", esc(value)).unwrap();
        }
        Piece::Ref {
          name,
          target,
          ok,
          missing,
        } => {
          self.patches.push(Patch {
            at: self.out.len(),
            owner: self.resource_stack.last().copied(),
            target: *target,
            ok: format!(" {name}=\"{}\"", esc(ok)),
            missing: missing
              .as_ref()
              .map(|m| format!(" {name}=\"{}\"", esc(m)))
              .unwrap_or_default(),
          });
        }
      }
    }
  }

  fn open(&mut self, tag: &str, pieces: &[Piece]) {
    write!(self.out, "<{tag}").unwrap();
    self.write_pieces(pieces);
    self.out.push('>');
  }

  /// A paint as SkSVG reads it: (fill, fill-opacity) pieces.
  fn paint_pieces(
    &mut self,
    style: &Style,
    which: Prop,
    opacity: Prop,
    paint_name: &'static str,
    opacity_name: &'static str,
  ) -> [Piece; 2] {
    let op = style.number(opacity);
    let paint = match style.get(which) {
      Value::Paint(p) => p.clone(),
      _ => Paint::None,
    };
    let plain = |paint: &Paint| -> (String, f32) {
      match paint {
        Paint::Color(c) => {
          let c = Self::resolve_color(style, c);
          (c.hex(), op * c.a)
        }
        _ => ("none".into(), op),
      }
    };
    match &paint {
      Paint::Url(url) => {
        let fallback = plain(url.1.as_ref().unwrap_or(&Paint::None));
        let target = self.target_of_type(&url.0, PAINT_SERVERS);
        // A paint server that cannot paint (an empty pattern tile, ...)
        // gives the fallback color, or no paint without one
        // (svg_object_painter.cc PreparePaint); SkSVG uses the color after
        // the url, black when there is none.
        let fallback_color = match url.1.as_ref() {
          Some(Paint::Color(c)) => {
            let c = Self::resolve_color(style, c);
            if c.a >= 1.0 {
              c.hex()
            } else {
              let [r, g, b] = c.rgb;
              format!("rgba({r},{g},{b},{})", num(c.a))
            }
          }
          _ => "rgba(0,0,0,0)".into(),
        };
        match target {
          Some(t) => [
            Piece::Ref {
              name: paint_name,
              target: t,
              ok: format!("url(#{}) {fallback_color}", self.out_id(t)),
              missing: Some(fallback.0),
            },
            Piece::Ref {
              name: opacity_name,
              target: t,
              ok: num(op),
              missing: Some(num(fallback.1)),
            },
          ],
          None => [
            attr(paint_name, fallback.0),
            attr(opacity_name, num(fallback.1)),
          ],
        }
      }
      p => {
        let (v, o) = plain(p);
        [attr(paint_name, v), attr(opacity_name, num(o))]
      }
    }
  }

  /// The inherited presentation attributes of an element, as SkSVG reads
  /// them.
  fn inherited_out(&mut self, style: &Style) -> OutSet {
    let mut out = Vec::with_capacity(20);
    out.extend(self.paint_pieces(style, Prop::Fill, Prop::FillOpacity, "fill", "fill-opacity"));
    let mut stroke = self.paint_pieces(
      style,
      Prop::Stroke,
      Prop::StrokeOpacity,
      "stroke",
      "stroke-opacity",
    );
    // A zero stroke-width paints no stroke; SkSVG would draw a hairline.
    let width = style.len(Prop::StrokeWidth).unwrap_or(Len::px(1.0));
    if width.pct <= 0.0 && width.px <= 0.0 {
      stroke[0] = attr("stroke", "none");
    }
    out.extend(stroke);
    let diagonal = self.diagonal();
    let keyword = |p| style.keyword(p).to_string();
    out.push(attr("fill-rule", keyword(Prop::FillRule)));
    out.push(attr("clip-rule", keyword(Prop::ClipRule)));
    out.push(attr("stroke-width", self.len_out(width, diagonal)));
    out.push(attr(
      "stroke-dasharray",
      match style.get(Prop::StrokeDasharray) {
        Value::Dashes(Some(v)) => v
          .iter()
          .map(|l| self.len_out(*l, diagonal))
          .collect::<Vec<_>>()
          .join(" "),
        _ => "none".into(),
      },
    ));
    out.push(attr(
      "stroke-dashoffset",
      self.len_out(
        style.len(Prop::StrokeDashoffset).unwrap_or_default(),
        diagonal,
      ),
    ));
    out.push(attr("stroke-linecap", keyword(Prop::StrokeLinecap)));
    out.push(attr("stroke-linejoin", keyword(Prop::StrokeLinejoin)));
    out.push(attr(
      "stroke-miterlimit",
      num(style.number(Prop::StrokeMiterlimit)),
    ));
    let families = match style.get(Prop::FontFamily) {
      Value::Families(f) => f.clone(),
      _ => Rc::from(Vec::new()),
    };
    let key = self.shared.family_key(&families);
    out.push(attr("font-family", format!("napi-font:{key}")));
    out.push(attr("font-size", num(style.font_size())));
    out.push(attr("font-style", keyword(Prop::FontStyle)));
    // SkSVG takes 100 to 900 in steps of 100.
    let weight = match style.get(Prop::FontWeight) {
      Value::Number(w) => ((w / 100.0).round() * 100.0).clamp(100.0, 900.0),
      _ => 400.0,
    };
    out.push(attr("font-weight", num(weight)));
    out.push(attr("text-anchor", keyword(Prop::TextAnchor)));
    out.push(attr(
      "color-interpolation",
      if style.keyword(Prop::ColorInterpolation) == "linearrgb" {
        "linearRGB"
      } else {
        "sRGB"
      },
    ));
    out.push(attr("color-interpolation-filters", filter_space(style)));
    out
  }

  /// The presentation attributes of an element: inherited ones that differ
  /// from `parent_out` (all when it is None), then opacity, clip-path, mask
  /// and filter.
  fn presentation(
    &mut self,
    style: &Style,
    parent_out: Option<&OutSet>,
    pieces: &mut Vec<Piece>,
  ) -> Rc<OutSet> {
    let mine = self.inherited_out(style);
    for (i, piece) in mine.iter().enumerate() {
      if parent_out.is_none_or(|p| p.get(i) != Some(piece)) {
        pieces.push(piece.clone());
      }
    }
    let opacity = style.number(Prop::Opacity);
    if opacity < 1.0 {
      pieces.push(attr("opacity", num(opacity)));
    }
    // A missing reference, or one to the wrong element, is as if the
    // property were none (Chrome 155: corpus3 url_*_missing).
    for (prop, ty, name) in [
      (Prop::ClipPath, "clipPath", "clip-path"),
      (Prop::Mask, "mask", "mask"),
      (Prop::Filter, "filter", "filter"),
    ] {
      if let Value::Url(Some(u)) = style.get(prop)
        && let Some(t) = self.target_of_type(u, &[ty])
      {
        pieces.push(Piece::Ref {
          name,
          target: t,
          ok: format!("url(#{})", self.out_id(t)),
          missing: None,
        });
      }
    }
    Rc::new(mine)
  }

  fn id_piece(&self, n: NodeId, parent: &Parent, pieces: &mut Vec<Piece>) {
    // Instances and borrowed content carry no ids: references go to the
    // element itself.
    if parent.scope.is_none() && !parent.no_ids && self.doc.attr(n, "id").is_some() {
      pieces.push(attr("id", self.out_id(n)));
    }
  }

  fn raw_pieces(&self, n: NodeId, names: &[&'static str], pieces: &mut Vec<Piece>) {
    for name in names {
      if let Some(v) = self.doc.attr(n, name) {
        pieces.push(attr(*name, v.to_owned()));
      }
    }
  }

  /// transform-box: the reference box (x, y, width, height).
  fn reference_box(&self, n: NodeId, style: &Style) -> (f32, f32, f32, f32) {
    let (vw, vh) = self.viewport;
    if style.keyword(Prop::TransformBox) == "fill-box" {
      let g = |p| style.len(p).map(|l| l.resolve(vw)).unwrap_or(0.0);
      match self.doc.svg_name(n) {
        Some("rect") | Some("image") => {
          let h = |p| style.len(p).map(|l| l.resolve(vh)).unwrap_or(0.0);
          return (g(Prop::X), h(Prop::Y), g(Prop::Width), h(Prop::Height));
        }
        Some("circle") => {
          let r = style
            .len(Prop::R)
            .map(|l| l.resolve(self.diagonal()))
            .unwrap_or(0.0);
          let cy = style.len(Prop::Cy).map(|l| l.resolve(vh)).unwrap_or(0.0);
          return (g(Prop::Cx) - r, cy - r, 2.0 * r, 2.0 * r);
        }
        _ => {}
      }
    }
    (0.0, 0.0, vw, vh)
  }

  /// The transform as SkSVG reads it: the attribute as written when the
  /// computed value is the attribute's, else one matrix with the origin
  /// folded in.
  fn transform_value(&self, n: NodeId, style: &Style) -> Option<String> {
    let Value::Transform(Some(list)) = style.get(Prop::Transform) else {
      return None;
    };
    let origin = match style.get(Prop::TransformOrigin) {
      Value::Origin(x, y) => (*x, *y),
      _ => (Len::default(), Len::default()),
    };
    let zero_origin = origin == (Len::default(), Len::default());
    if zero_origin && let Some(attr) = self.doc.attr(n, "transform") {
      let from_attr = parse_svg_transform(attr).filter(|l| !l.is_empty());
      if from_attr.as_deref() == Some(&list[..]) {
        return Some(attr.to_owned());
      }
    }
    let rb = self.reference_box(n, style);
    let ox = origin.0.resolve(rb.2) + rb.0;
    let oy = origin.1.resolve(rb.3) + rb.1;
    let m = transform_matrix(list, rb);
    let m = multiply(
      &multiply(&[1.0, 0.0, 0.0, 1.0, ox, oy], &m),
      &[1.0, 0.0, 0.0, 1.0, -ox, -oy],
    );
    Some(matrix_attr(&m))
  }

  fn transform_matrix_of(&self, n: NodeId, style: &Style) -> [f32; 6] {
    self
      .transform_value(n, style)
      .and_then(|t| parse_svg_transform(&t))
      .map(|l| transform_matrix(&l, (0.0, 0.0, 0.0, 0.0)))
      .unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
  }

  // --- The walk -------------------------------------------------------------

  fn emit_root(
    &mut self,
    nested: Option<(f32, f32)>,
    has_view_box: bool,
    size: Option<(f32, f32)>,
  ) {
    let doc = self.doc;
    let root = doc.root;
    let style = Rc::new(self.cascade.compute(root, None, &Style::initial()));
    self.shared.take_element();
    let mut pieces = vec![
      attr("xmlns", super::dom::SVG_NS),
      attr("xmlns:xlink", super::dom::XLINK_NS),
    ];
    if let Some((w, h)) = nested {
      pieces.push(attr("width", num(w)));
      pieces.push(attr("height", num(h)));
    }
    match size {
      // SVGSVGElement::CurrentViewBoxRect: the root of an SVG image with no
      // viewBox and an absolute width and height gets one from them.
      Some((w, h)) if !has_view_box && w > 0.0 && h > 0.0 => {
        pieces.push(attr("viewBox", format!("0 0 {} {}", num(w), num(h))));
        pieces.push(attr("preserveAspectRatio", "none"));
      }
      _ => self.raw_pieces(root, &["viewBox", "preserveAspectRatio"], &mut pieces),
    }
    let out = self.presentation(&style, None, &mut pieces);
    self.open("svg", &pieces);
    let frame = Frame {
      node: root,
      style,
      out,
      kids: Kids::Children(root, 0),
      kid_scope: None,
      no_ids: false,
      ctx: Ctx::Normal,
      close: String::new(),
      resource: false,
    };
    self.walk(frame);
    if self.alpha_mask_filter {
      // mask-type: alpha as a luminance mask of white with the content's
      // alpha.
      self.out.push_str(
        "<filter id=\"__napi_a2l\" filterUnits=\"userSpaceOnUse\" x=\"-1e7\" y=\"-1e7\" \
         width=\"2e7\" height=\"2e7\" color-interpolation-filters=\"sRGB\"><feColorMatrix \
         type=\"matrix\" values=\"0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0\"/></filter>",
      );
    }
    let defs = std::mem::take(&mut self.defs);
    self.out.push_str(&defs);
    self.out.push_str("</svg>");
  }

  fn walk(&mut self, root: Frame) {
    let doc = self.doc;
    let mut frames = vec![root];
    while let Some(top) = frames.last_mut() {
      match top.next_kid(doc) {
        Some(kid) => {
          let top = frames.last().unwrap();
          let parent = Parent {
            node: top.node,
            style: top.style.clone(),
            out: top.out.clone(),
            scope: top.kid_scope,
            no_ids: top.no_ids,
            ctx: top.ctx,
          };
          // Deeper than Chrome parses: only `<use>` instances get here.
          if frames.len() >= MAX_TREE_DEPTH {
            continue;
          }
          if let Some(frame) = self.enter(kid, &parent, &frames) {
            frames.push(frame);
          }
        }
        None => {
          let frame = frames.pop().unwrap();
          self.out.push_str(&frame.close);
          if frame.resource {
            self.resource_stack.pop();
          }
        }
      }
    }
  }

  fn frame(
    &self,
    node: NodeId,
    style: Rc<Style>,
    out: Rc<OutSet>,
    parent: &Parent,
    ctx: Ctx,
    close: &str,
  ) -> Frame {
    Frame {
      node,
      style,
      out,
      kids: Kids::Children(node, 0),
      kid_scope: parent.scope,
      no_ids: parent.no_ids,
      ctx,
      close: close.to_owned(),
      resource: false,
    }
  }

  fn enter(&mut self, n: NodeId, parent: &Parent, path: &[Frame]) -> Option<Frame> {
    let doc = self.doc;
    let name = match &doc.nodes[n].data {
      NodeData::Text(text) => {
        if parent.ctx == Ctx::Text {
          let text = esc(text);
          self.out.push_str(&text);
        }
        return None;
      }
      NodeData::Element {
        ns: Ns::Svg, name, ..
      } => name.as_str(),
      NodeData::Element { .. } => return None,
    };
    match parent.ctx {
      Ctx::Text => {
        if name != "tspan" && name != "textPath" {
          return None;
        }
        let style = Rc::new(self.cascade.compute(n, parent.scope, &parent.style));
        if style.keyword(Prop::Display) == "none" || !self.shared.take_element() {
          return None;
        }
        let mut pieces = Vec::new();
        self.raw_pieces(
          n,
          &["x", "y", "dx", "dy", "rotate", "startOffset"],
          &mut pieces,
        );
        if name == "textPath"
          && let Some(t) = doc.href(n).and_then(|h| self.target(h))
        {
          pieces.push(attr("xlink:href", format!("#{}", self.out_id(t))));
        }
        let out = self.presentation(&style, Some(&parent.out), &mut pieces);
        self.open(name, &pieces);
        return Some(self.frame(n, style, out, parent, Ctx::Text, &format!("</{name}>")));
      }
      Ctx::Clip | Ctx::ClipUse => return self.enter_clip_child(n, name, parent, path),
      Ctx::Normal | Ctx::Defs => {}
    }

    match name {
      "linearGradient" | "radialGradient" | "pattern" | "clipPath" | "mask" | "filter" => {
        // An instance's resources are the element's own: not written again.
        if parent.scope.is_some() || parent.no_ids {
          return None;
        }
        return self.enter_resource(n, name, parent);
      }
      "title" | "desc" | "metadata" | "style" | "script" | "foreignObject" => return None,
      _ => {}
    }
    if parent.ctx == Ctx::Defs {
      return self.enter_defs_child(n, name, parent);
    }
    let style = Rc::new(self.cascade.compute(n, parent.scope, &parent.style));
    if name != "defs" && style.keyword(Prop::Display) == "none" {
      return None;
    }
    if !self.shared.take_element() {
      return None;
    }
    let hidden = style.keyword(Prop::Visibility) != "visible";
    match name {
      "defs" | "symbol" | "marker" => {
        self.out.push_str("<defs>");
        Some(self.frame(n, style, parent.out.clone(), parent, Ctx::Defs, "</defs>"))
      }
      "g" | "a" | "switch" => {
        let mut pieces = Vec::new();
        self.id_piece(n, parent, &mut pieces);
        if let Some(t) = self.transform_value(n, &style) {
          pieces.push(attr("transform", t));
        }
        let out = self.presentation(&style, Some(&parent.out), &mut pieces);
        self.open("g", &pieces);
        let mut frame = self.frame(n, style, out, parent, Ctx::Normal, "</g>");
        if name == "switch" {
          frame.kids = Kids::One(self.switch_child(n));
        }
        Some(frame)
      }
      "svg" => self.enter_nested_svg(n, style, parent, None),
      "use" => self.enter_use(n, style, parent, path),
      "image" => {
        if !hidden {
          self.emit_image(n, &style, parent);
        }
        None
      }
      "text" => {
        let mut pieces = Vec::new();
        self.id_piece(n, parent, &mut pieces);
        self.raw_pieces(
          n,
          &["x", "y", "dx", "dy", "rotate", "textLength", "lengthAdjust"],
          &mut pieces,
        );
        if let Some(space) = doc
          .attrs(n)
          .iter()
          .find(|a| a.ns == Ns::Xml && a.name == "space")
        {
          pieces.push(attr("xml:space", space.value.clone()));
        }
        if let Some(t) = self.transform_value(n, &style) {
          pieces.push(attr("transform", t));
        }
        let out = self.presentation(&style, Some(&parent.out), &mut pieces);
        if hidden {
          pieces.push(attr("visibility", "hidden"));
        }
        self.open("text", &pieces);
        Some(self.frame(n, style, out, parent, Ctx::Text, "</text>"))
      }
      s if SHAPES.contains(&s) => {
        self.emit_shape(n, s, &style, parent, hidden, false);
        None
      }
      _ => None,
    }
  }

  /// Inside `<defs>` (or a symbol or marker where it is defined): look for
  /// resources, and keep paths a textPath may name.
  fn enter_defs_child(&mut self, n: NodeId, name: &str, parent: &Parent) -> Option<Frame> {
    match name {
      "g" | "a" | "defs" | "svg" | "switch" | "symbol" | "marker" => {
        let style = Rc::new(self.cascade.compute(n, parent.scope, &parent.style));
        Some(self.frame(n, style, parent.out.clone(), parent, Ctx::Defs, ""))
      }
      "path" if self.doc.attr(n, "id").is_some() => {
        let style = Rc::new(self.cascade.compute(n, parent.scope, &parent.style));
        if self.shared.take_element() {
          self.emit_shape(n, name, &style, parent, false, false);
        }
        None
      }
      _ => None,
    }
  }

  /// Blink's clipPath content (LayoutSVGResourceClipper): shapes and text
  /// that display and are visible, and `<use>` of one of those.
  fn enter_clip_child(
    &mut self,
    n: NodeId,
    name: &str,
    parent: &Parent,
    path: &[Frame],
  ) -> Option<Frame> {
    let doc = self.doc;
    let in_use = parent.ctx == Ctx::ClipUse;
    let allowed = if in_use {
      CLIP_DIRECT_REF.contains(&name)
    } else {
      SHAPES.contains(&name) || name == "text" || name == "use"
    };
    if !allowed {
      return None;
    }
    let style = Rc::new(self.cascade.compute(n, parent.scope, &parent.style));
    if style.keyword(Prop::Display) == "none" {
      return None;
    }
    if name == "use" {
      let t = doc.href(n).and_then(|h| self.target(h))?;
      if t == n
        || path.iter().any(|f| f.node == t)
        || !doc
          .svg_name(t)
          .is_some_and(|tn| CLIP_DIRECT_REF.contains(&tn))
        || !self.shared.take_element()
      {
        return None;
      }
      let (x, y) = self.use_offset(n, &style);
      let m = multiply(
        &self.transform_matrix_of(n, &style),
        &[1.0, 0.0, 0.0, 1.0, x, y],
      );
      let mut pieces = Vec::new();
      if m != [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] {
        pieces.push(attr("transform", matrix_attr(&m)));
      }
      let out = self.presentation(&style, Some(&parent.out), &mut pieces);
      pieces.retain(|p| !matches!(p.name(), "opacity" | "mask" | "filter"));
      self.open("g", &pieces);
      let mut frame = self.frame(n, style, out, parent, Ctx::ClipUse, "</g>");
      frame.kids = Kids::One(Some(t));
      frame.kid_scope = Some(t);
      return Some(frame);
    }
    if style.keyword(Prop::Visibility) != "visible" || !self.shared.take_element() {
      return None;
    }
    if name == "text" {
      let mut pieces = Vec::new();
      self.raw_pieces(
        n,
        &["x", "y", "dx", "dy", "rotate", "textLength", "lengthAdjust"],
        &mut pieces,
      );
      if let Some(t) = self.transform_value(n, &style) {
        pieces.push(attr("transform", t));
      }
      let out = self.presentation(&style, Some(&parent.out), &mut pieces);
      self.open("text", &pieces);
      return Some(self.frame(n, style, out, parent, Ctx::Text, "</text>"));
    }
    self.emit_shape(n, name, &style, parent, false, true);
    None
  }

  /// SVGSwitchElement: the first child that passes conditional processing.
  /// systemLanguage matches the browser's languages (en-US).
  fn switch_child(&self, n: NodeId) -> Option<NodeId> {
    let doc = self.doc;
    doc.element_children(n).find(|&c| {
      let Some(name) = doc.svg_name(c) else {
        return false;
      };
      if matches!(name, "title" | "desc" | "metadata" | "style" | "script") {
        return false;
      }
      if let Some(ext) = doc.attr(c, "requiredExtensions")
        && (ext.trim().is_empty()
          || !ext.split_whitespace().all(|e| {
            e == "http://www.w3.org/1999/xhtml" || e == "http://www.w3.org/1998/Math/MathML"
          }))
      {
        return false;
      }
      if let Some(lang) = doc.attr(c, "systemLanguage") {
        let ok = lang
          .split(',')
          .map(|l| l.trim().to_ascii_lowercase())
          .any(|l| {
            !l.is_empty() && (l == "en" || l == "en-us" || "en-us".starts_with(&format!("{l}-")))
          });
        if !ok {
          return false;
        }
      }
      true
    })
  }

  fn use_offset(&self, n: NodeId, style: &Style) -> (f32, f32) {
    let (vw, vh) = self.viewport;
    let x = self
      .attr_len(n, "x", style)
      .map(|l| l.resolve(vw))
      .unwrap_or(0.0);
    let y = self
      .attr_len(n, "y", style)
      .map(|l| l.resolve(vh))
      .unwrap_or(0.0);
    (x, y)
  }

  fn enter_use(
    &mut self,
    n: NodeId,
    style: Rc<Style>,
    parent: &Parent,
    path: &[Frame],
  ) -> Option<Frame> {
    let doc = self.doc;
    let t = doc.href(n).and_then(|h| self.target(h))?;
    // A use that is, or is inside, what it references draws nothing
    // (SVGUseElement::HasCycleUseReferencing).
    if t == n || parent.node == t || path.iter().any(|f| f.node == t) {
      return None;
    }
    let target_name = doc.svg_name(t)?;
    let (x, y) = self.use_offset(n, &style);
    let m = multiply(
      &self.transform_matrix_of(n, &style),
      &[1.0, 0.0, 0.0, 1.0, x, y],
    );
    let mut pieces = Vec::new();
    if m != [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] {
      pieces.push(attr("transform", matrix_attr(&m)));
    }
    let out = self.presentation(&style, Some(&parent.out), &mut pieces);
    self.open("g", &pieces);
    let use_parent = Parent {
      node: n,
      style: style.clone(),
      out: out.clone(),
      scope: Some(t),
      no_ids: false,
      ctx: Ctx::Normal,
    };
    let width = doc.attr(n, "width").map(str::to_owned);
    let height = doc.attr(n, "height").map(str::to_owned);
    match target_name {
      "symbol" => {
        let symbol_style = Rc::new(self.cascade.compute(t, Some(t), &style));
        if symbol_style.keyword(Prop::Display) == "none" || !self.shared.take_element() {
          self.out.push_str("</g>");
          return None;
        }
        let w = width.unwrap_or_else(|| "100%".into());
        let h = height.unwrap_or_else(|| "100%".into());
        self.uid += 1;
        let clip = format!("__napi_vp{}", self.uid);
        write!(
          self.defs,
          "<clipPath id=\"{clip}\"><rect width=\"{}\" height=\"{}\"/></clipPath>",
          esc(&w),
          esc(&h)
        )
        .unwrap();
        write!(self.out, "<g clip-path=\"url(#{clip})\">").unwrap();
        let mut pieces = vec![attr("width", w), attr("height", h)];
        self.raw_pieces(t, &["viewBox", "preserveAspectRatio"], &mut pieces);
        let symbol_out = self.presentation(&symbol_style, Some(&out), &mut pieces);
        self.open("svg", &pieces);
        let mut frame = self.frame(
          t,
          symbol_style,
          symbol_out,
          &use_parent,
          Ctx::Normal,
          "</svg></g></g>",
        );
        frame.kid_scope = Some(t);
        Some(frame)
      }
      "svg" => {
        let style_t = Rc::new(self.cascade.compute(t, Some(t), &style));
        if style_t.keyword(Prop::Display) == "none" || !self.shared.take_element() {
          self.out.push_str("</g>");
          return None;
        }
        let frame = self.enter_nested_svg(t, style_t, &use_parent, Some((width, height)));
        match frame {
          Some(mut f) => {
            f.close.push_str("</g>");
            f.kid_scope = Some(t);
            Some(f)
          }
          None => {
            self.out.push_str("</g>");
            None
          }
        }
      }
      _ => {
        let mut frame = self.frame(n, style, out, &use_parent, Ctx::Normal, "</g>");
        frame.kids = Kids::One(Some(t));
        frame.kid_scope = Some(t);
        Some(frame)
      }
    }
  }

  fn enter_nested_svg(
    &mut self,
    n: NodeId,
    style: Rc<Style>,
    parent: &Parent,
    size: Option<(Option<String>, Option<String>)>,
  ) -> Option<Frame> {
    let (vw, vh) = self.viewport;
    let mut xywh: Vec<(&'static str, String)> = Vec::new();
    for (prop, reference, default) in [
      (Prop::X, vw, "0"),
      (Prop::Y, vh, "0"),
      (Prop::Width, vw, "100%"),
      (Prop::Height, vh, "100%"),
    ] {
      let v = style
        .len(prop)
        .map(|l| self.len_out(l, reference))
        .unwrap_or_else(|| default.into());
      xywh.push((prop.name(), v));
    }
    if let Some((w, h)) = size {
      if let Some(w) = w {
        xywh[2].1 = w;
      }
      if let Some(h) = h {
        xywh[3].1 = h;
      }
    }
    let mut pieces = Vec::new();
    self.id_piece(n, parent, &mut pieces);
    for (name, v) in &xywh {
      pieces.push(attr(*name, v.clone()));
    }
    self.raw_pieces(n, &["viewBox", "preserveAspectRatio"], &mut pieces);
    let out = self.presentation(&style, Some(&parent.out), &mut pieces);
    // UA style svg:not(:root) { overflow: hidden }: inner viewports clip,
    // which SkSVG never does.
    let overflow = style.keyword(Prop::Overflow);
    let clip = !style.declared(Prop::Overflow) || !matches!(overflow, "visible" | "auto");
    let mut close = String::from("</svg>");
    if clip {
      self.uid += 1;
      let id = format!("__napi_vp{}", self.uid);
      write!(
        self.defs,
        "<clipPath id=\"{id}\"><rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\"/></clipPath>",
        esc(&xywh[0].1),
        esc(&xywh[1].1),
        esc(&xywh[2].1),
        esc(&xywh[3].1)
      )
      .unwrap();
      write!(self.out, "<g clip-path=\"url(#{id})\">").unwrap();
      close.push_str("</g>");
    }
    self.open("svg", &pieces);
    Some(self.frame(n, style, out, parent, Ctx::Normal, &close))
  }

  /// A shape. `in_clip`: as clipPath content (geometry and clip-rule only
  /// matter).
  fn emit_shape(
    &mut self,
    n: NodeId,
    name: &str,
    style: &Style,
    parent: &Parent,
    hidden: bool,
    in_clip: bool,
  ) {
    let (vw, vh) = self.viewport;
    let diagonal = self.diagonal();
    let len = |p| style.len(p);
    // A zero (or negative) size disables rendering.
    let positive = |l: Option<Len>| l.is_some_and(|l| l.px > 0.0 || l.pct > 0.0);
    let mut geometry: Vec<Piece> = Vec::new();
    let tag = match name {
      "rect" => {
        if !positive(len(Prop::Width)) || !positive(len(Prop::Height)) {
          return;
        }
        for (prop, reference) in [
          (Prop::X, vw),
          (Prop::Y, vh),
          (Prop::Width, vw),
          (Prop::Height, vh),
        ] {
          if let Some(l) = len(prop) {
            geometry.push(attr(prop.name(), self.len_out(l, reference)));
          }
        }
        // rx / ry: auto takes the other.
        let rx = len(Prop::Rx).map(|l| self.len_out(l, vw));
        let ry = len(Prop::Ry).map(|l| self.len_out(l, vh));
        if let Some(v) = rx.clone().or(ry.clone()) {
          geometry.push(attr("rx", v));
        }
        if let Some(v) = ry.or(rx) {
          geometry.push(attr("ry", v));
        }
        "rect"
      }
      "circle" => {
        if !positive(len(Prop::R)) {
          return;
        }
        for (prop, reference) in [(Prop::Cx, vw), (Prop::Cy, vh), (Prop::R, diagonal)] {
          if let Some(l) = len(prop) {
            geometry.push(attr(prop.name(), self.len_out(l, reference)));
          }
        }
        "circle"
      }
      "ellipse" => {
        let (rx, ry) = (len(Prop::Rx), len(Prop::Ry));
        let (rx, ry) = (rx.or(ry), ry.or(rx));
        if !positive(rx) || !positive(ry) {
          return;
        }
        let cx = len(Prop::Cx).unwrap_or_default();
        let cy = len(Prop::Cy).unwrap_or_default();
        let (rx, ry) = (rx.unwrap(), ry.unwrap());
        match (
          self.len_now(cx, vw),
          self.len_now(cy, vh),
          self.len_now(rx, vw),
          self.len_now(ry, vh),
        ) {
          // SkSVGEllipse has no object bounding box (objectBoundingBox
          // gradients, clips and masks collapse on it). A rect with radii of
          // half its size is an oval that SkCanvas draws as one, as Blink
          // does (SVGShapePainter::FillShape kEllipse).
          (Some(cx), Some(cy), Some(rx), Some(ry)) => {
            geometry.push(attr("x", num(cx - rx)));
            geometry.push(attr("y", num(cy - ry)));
            geometry.push(attr("width", num(2.0 * rx)));
            geometry.push(attr("height", num(2.0 * ry)));
            geometry.push(attr("rx", num(rx)));
            geometry.push(attr("ry", num(ry)));
            "rect"
          }
          _ => {
            geometry.push(attr("cx", self.len_out(cx, vw)));
            geometry.push(attr("cy", self.len_out(cy, vh)));
            geometry.push(attr("rx", self.len_out(rx, vw)));
            geometry.push(attr("ry", self.len_out(ry, vh)));
            "ellipse"
          }
        }
      }
      "line" => {
        let get = |a| self.attr_len(n, a, style).unwrap_or_default();
        let (x1, y1, x2, y2) = (get("x1"), get("y1"), get("x2"), get("y2"));
        match (
          self.len_now(x1, vw),
          self.len_now(y1, vh),
          self.len_now(x2, vw),
          self.len_now(y2, vh),
        ) {
          // Blink paints a line as a path; SkSVG's drawLine strokes thin
          // lines differently (corpus2 g_hairline).
          (Some(x1), Some(y1), Some(x2), Some(y2)) => {
            geometry.push(attr(
              "d",
              format!("M{} {}L{} {}", num(x1), num(y1), num(x2), num(y2)),
            ));
            "path"
          }
          _ => {
            for (a, l, r) in [
              ("x1", x1, vw),
              ("y1", y1, vh),
              ("x2", x2, vw),
              ("y2", y2, vh),
            ] {
              geometry.push(attr(a, self.len_out(l, r)));
            }
            "line"
          }
        }
      }
      "path" => {
        let Value::Path(Some(d)) = style.get(Prop::D) else {
          return;
        };
        if d.trim().is_empty() {
          return;
        }
        geometry.push(attr("d", d.to_string()));
        "path"
      }
      _ => {
        let points = self.doc.attr(n, "points").unwrap_or("");
        geometry.push(attr("points", points.to_owned()));
        if name == "polygon" {
          "polygon"
        } else {
          "polyline"
        }
      }
    };
    let mut pieces = Vec::new();
    self.id_piece(n, parent, &mut pieces);
    if let Some(t) = self.transform_value(n, style) {
      pieces.push(attr("transform", t));
    }
    pieces.extend(geometry);
    self.presentation(style, Some(&parent.out), &mut pieces);
    if hidden {
      pieces.push(attr("visibility", "hidden"));
    }
    let painted = |pieces: &[Piece], which: &str| {
      pieces.iter().any(|p| {
        p.name() == which
          && match p {
            Piece::Attr(_, v) => v != "none",
            Piece::Ref { .. } => true,
          }
      }) || (!pieces.iter().any(|p| p.name() == which)
        && parent
          .out
          .iter()
          .any(|p| p.name() == which && !matches!(p, Piece::Attr(_, v) if v == "none")))
    };
    let stroke_first = style.keyword(Prop::PaintOrder) == "stroke";
    if in_clip
      || hidden
      || !stroke_first
      || !painted(&pieces, "fill")
      || !painted(&pieces, "stroke")
    {
      self.open(tag, &pieces);
      write!(self.out, "</{tag}>").unwrap();
      return;
    }
    // paint-order: stroke before fill (SVGShapePainter::Paint), both under
    // the shape's one transform and paint state.
    let mut group = Vec::new();
    pieces.retain(|p| {
      if matches!(
        p.name(),
        "transform" | "opacity" | "clip-path" | "mask" | "filter"
      ) {
        group.push(p.clone());
        false
      } else {
        true
      }
    });
    self.open("g", &group);
    for (part, off) in [("stroke", "fill"), ("fill", "stroke")] {
      let mut p = pieces.clone();
      if part == "fill" {
        p.retain(|x| x.name() != "id");
      }
      p.retain(|x| x.name() != off);
      p.push(attr(off, "none"));
      self.open(tag, &p);
      write!(self.out, "</{tag}>").unwrap();
    }
    self.out.push_str("</g>");
  }

  // --- Resources ----------------------------------------------------------

  fn href_chain(&self, n: NodeId, types: &[&str]) -> Vec<NodeId> {
    let mut chain = vec![n];
    let mut current = n;
    // Blink stops at an element already in the chain
    // (SVGGradientElement::CollectGradientAttributes).
    while let Some(t) = self.doc.href(current).and_then(|h| self.target(h)) {
      if chain.contains(&t) || !self.doc.svg_name(t).is_some_and(|x| types.contains(&x)) {
        break;
      }
      chain.push(t);
      current = t;
    }
    chain
  }

  fn enter_resource(&mut self, n: NodeId, name: &str, parent: &Parent) -> Option<Frame> {
    if !self.shared.take_element() {
      return None;
    }
    self.written.insert(n);
    match name {
      "linearGradient" | "radialGradient" => {
        self.emit_gradient(n, name);
        None
      }
      "filter" => {
        self.emit_filter(n);
        None
      }
      "pattern" => self.enter_pattern(n, parent),
      "clipPath" => self.enter_clip_path(n, parent),
      _ => self.enter_mask(n, parent),
    }
  }

  fn emit_gradient(&mut self, n: NodeId, name: &str) {
    let doc = self.doc;
    let chain = self.href_chain(n, &["linearGradient", "radialGradient"]);
    let own: &[&'static str] = if name == "linearGradient" {
      &["x1", "y1", "x2", "y2"]
    } else {
      &["cx", "cy", "r", "fx", "fy", "fr"]
    };
    let mut pieces = vec![attr("id", self.out_id(n))];
    for a in own
      .iter()
      .chain(["gradientUnits", "gradientTransform", "spreadMethod"].iter())
    {
      let value = chain.iter().find_map(|g| {
        // Geometry comes only from gradients of the same kind.
        if own.contains(a) && doc.svg_name(*g) != Some(name) {
          return None;
        }
        doc.attr(*g, a)
      });
      if let Some(v) = value {
        pieces.push(attr(*a, v.to_owned()));
      }
    }
    self.open(name, &pieces);
    let stops_from = chain.iter().copied().find(|g| {
      doc
        .element_children(*g)
        .any(|c| doc.svg_name(c) == Some("stop"))
    });
    if let Some(g) = stops_from {
      let gradient_style = self.style_at(g);
      let stops: Vec<NodeId> = doc
        .element_children(g)
        .filter(|c| doc.svg_name(*c) == Some("stop"))
        .collect();
      for s in stops {
        if !self.shared.take_element() {
          break;
        }
        let style = self.cascade.compute(s, None, &gradient_style);
        let mut pieces = Vec::new();
        self.raw_pieces(s, &["offset"], &mut pieces);
        let c = match style.get(Prop::StopColor) {
          Value::Color(c) => Self::resolve_color(&style, c),
          _ => Rgba::BLACK,
        };
        pieces.push(attr("stop-color", c.hex()));
        pieces.push(attr(
          "stop-opacity",
          num(style.number(Prop::StopOpacity) * c.a),
        ));
        self.open("stop", &pieces);
        self.out.push_str("</stop>");
      }
    }
    write!(self.out, "</{name}>").unwrap();
  }

  fn enter_pattern(&mut self, n: NodeId, parent: &Parent) -> Option<Frame> {
    let doc = self.doc;
    let chain = self.href_chain(n, &["pattern"]);
    let mut pieces = vec![attr("id", self.out_id(n))];
    for a in [
      "x",
      "y",
      "width",
      "height",
      "patternUnits",
      "patternContentUnits",
      "patternTransform",
      "viewBox",
      "preserveAspectRatio",
    ] {
      if let Some(v) = chain.iter().find_map(|g| doc.attr(*g, a)) {
        pieces.push(attr(a, v.to_owned()));
      }
    }
    self.open("pattern", &pieces);
    let Some(content) = chain
      .iter()
      .copied()
      .find(|g| doc.element_children(*g).next().is_some())
    else {
      self.out.push_str("</pattern>");
      return None;
    };
    // Pattern content inherits from the pattern element where it is
    // written, not from what it fills.
    let style = self.style_at(content);
    self.resource_stack.push(n);
    let mut pieces = Vec::new();
    let out = self.presentation(&style, None, &mut pieces);
    pieces.retain(|p| !matches!(p.name(), "opacity" | "clip-path" | "mask" | "filter"));
    self.open("g", &pieces);
    let mut frame = self.frame(content, style, out, parent, Ctx::Normal, "</g></pattern>");
    frame.no_ids = content != n;
    frame.resource = true;
    Some(frame)
  }

  fn enter_clip_path(&mut self, n: NodeId, parent: &Parent) -> Option<Frame> {
    let style = self.style_at(n);
    self.resource_stack.push(n);
    let mut pieces = vec![attr("id", self.out_id(n))];
    self.raw_pieces(n, &["clipPathUnits"], &mut pieces);
    if let Some(t) = self.transform_value(n, &style) {
      pieces.push(attr("transform", t));
    }
    if let Value::Url(Some(u)) = style.get(Prop::ClipPath)
      && let Some(t) = self.target_of_type(u, &["clipPath"])
    {
      pieces.push(Piece::Ref {
        name: "clip-path",
        target: t,
        ok: format!("url(#{})", self.out_id(t)),
        missing: None,
      });
    }
    self.open("clipPath", &pieces);
    // Clip content writes every inherited property: SkSVG resolves it in
    // the referencing element's context.
    let mut frame = self.frame(
      n,
      style,
      Rc::new(Vec::new()),
      parent,
      Ctx::Clip,
      "</clipPath>",
    );
    frame.resource = true;
    Some(frame)
  }

  fn enter_mask(&mut self, n: NodeId, parent: &Parent) -> Option<Frame> {
    let style = self.style_at(n);
    let mut pieces = vec![attr("id", self.out_id(n))];
    self.raw_pieces(
      n,
      &["x", "y", "width", "height", "maskUnits", "maskContentUnits"],
      &mut pieces,
    );
    let mut content = Vec::new();
    let out = self.presentation(&style, None, &mut content);
    content.retain(|p| !matches!(p.name(), "opacity" | "clip-path" | "mask" | "filter"));
    // SkSVGMask linearizes the mask layer with the mask's own
    // color-interpolation.
    if let Some(ci) = content.iter().find(|p| p.name() == "color-interpolation") {
      pieces.push(ci.clone());
    }
    self.resource_stack.push(n);
    self.open("mask", &pieces);
    if style.keyword(Prop::MaskType) == "alpha" {
      self.alpha_mask_filter = true;
      content.push(attr("filter", "url(#__napi_a2l)"));
    }
    self.open("g", &content);
    let mut frame = self.frame(n, style, out, parent, Ctx::Normal, "</g></mask>");
    frame.resource = true;
    Some(frame)
  }

  /// A filter as SkSVG draws it (Blink's filter graph is not done here).
  fn emit_filter(&mut self, n: NodeId) {
    let doc = self.doc;
    let style = self.style_at(n);
    let mut pieces = vec![attr("id", self.out_id(n))];
    self.raw_pieces(
      n,
      &["x", "y", "width", "height", "filterUnits", "primitiveUnits"],
      &mut pieces,
    );
    pieces.push(attr("color-interpolation-filters", filter_space(&style)));
    self.open("filter", &pieces);
    let mut primitives = 0;
    // (node, parent style, closing tag); None closes.
    let mut stack: Vec<Option<(NodeId, Rc<Style>)>> = doc
      .element_children(n)
      .map(|c| Some((c, style.clone())))
      .collect();
    stack.reverse();
    let mut closes: Vec<String> = Vec::new();
    while let Some(item) = stack.pop() {
      let Some((c, parent_style)) = item else {
        let close = closes.pop().unwrap_or_default();
        self.out.push_str(&close);
        continue;
      };
      let Some(name) = doc.svg_name(c) else {
        continue;
      };
      if !name.starts_with("fe")
        || primitives >= MAX_FILTER_PRIMITIVES
        || !self.shared.take_element()
      {
        continue;
      }
      primitives += 1;
      let style = Rc::new(self.cascade.compute(c, None, &parent_style));
      let mut pieces = Vec::new();
      for a in doc.attrs(c) {
        // x, y, width and height are properties on shapes, plain
        // attributes on primitives and light sources.
        let geometry = matches!(a.name.as_str(), "x" | "y" | "width" | "height");
        if a.ns == Ns::None
          && !matches!(a.name.as_str(), "style" | "class" | "id" | "href")
          && (geometry || Prop::from_name(&a.name).is_none())
        {
          pieces.push(attr(a.name.clone(), a.value.clone()));
        }
      }
      pieces.push(attr("color-interpolation-filters", filter_space(&style)));
      if matches!(name, "feFlood" | "feDropShadow") {
        let c = match style.get(Prop::FloodColor) {
          Value::Color(cv) => Self::resolve_color(&style, cv),
          _ => Rgba::BLACK,
        };
        pieces.push(attr("flood-color", c.hex()));
        pieces.push(attr(
          "flood-opacity",
          num(style.number(Prop::FloodOpacity) * c.a),
        ));
      }
      if matches!(name, "feDiffuseLighting" | "feSpecularLighting") {
        let c = match style.get(Prop::LightingColor) {
          Value::Color(cv) => Self::resolve_color(&style, cv),
          _ => Rgba::BLACK,
        };
        pieces.push(attr("lighting-color", c.hex()));
      }
      if name == "feImage" {
        // SkSVG loads nothing for a feImage (as before); the image keys are
        // this module's.
        if let Some(h) = doc.href(c).filter(|h| {
          !h.trim_start()
            .get(..5)
            .is_some_and(|p| p.eq_ignore_ascii_case("napi-"))
        }) {
          pieces.push(attr("xlink:href", h.to_owned()));
        }
      }
      self.open(name, &pieces);
      closes.push(format!("</{name}>"));
      stack.push(None);
      let mut kids: Vec<_> = doc
        .element_children(c)
        .map(|k| Some((k, style.clone())))
        .collect();
      kids.reverse();
      stack.extend(kids);
    }
    self.out.push_str("</filter>");
  }

  // --- <image> ------------------------------------------------------------

  fn emit_image(&mut self, n: NodeId, style: &Style, parent: &Parent) {
    let doc = self.doc;
    let Some(href) = doc.href(n) else {
      return;
    };
    let (vw, vh) = self.viewport;
    let x = style.len(Prop::X).map(|l| l.resolve(vw)).unwrap_or(0.0);
    let y = style.len(Prop::Y).map(|l| l.resolve(vh)).unwrap_or(0.0);
    let width = style.len(Prop::Width).map(|l| l.resolve(vw));
    let height = style.len(Prop::Height).map(|l| l.resolve(vh));
    let par = doc.attr(n, "preserveAspectRatio").map(str::to_owned);
    let par_none = par
      .as_deref()
      .is_some_and(|p| p.split_ascii_whitespace().next() == Some("none"));
    // ComputedStyle::GetInterpolationQuality.
    let quality = match style.keyword(Prop::ImageRendering) {
      "pixelated" | "crisp-edges" => 0,
      "-webkit-optimize-contrast" => 1,
      _ => 2,
    };
    // What loading gives, measured in Chrome 155 for an SVG image from a
    // data: URL (img4.cjs): a URL relative to the data: document loads
    // nothing; a fragment, any other scheme, or a failed decode shows the
    // broken-image icon.
    let trimmed = href.trim_matches(|c: char| c.is_ascii_whitespace());
    let loaded = if trimmed.starts_with('#') {
      Rc::new(Loaded::Broken)
    } else if !has_scheme(trimmed) {
      return;
    } else if crate::data_url::is_data_url(trimmed.as_bytes()) {
      let url: Rc<str> = Rc::from(trimmed);
      self.shared.load(&url)
    } else {
      Rc::new(Loaded::Broken)
    };
    // LayoutSVGImage: an auto side comes from the natural size.
    let (natural, ratio, concrete) = match &*loaded {
      Loaded::Raster(_, (w, h)) => {
        let (w, h) = (*w as f32, *h as f32);
        (true, Some(w / h), (w, h))
      }
      Loaded::Svg(_, sizing) => {
        let (_, _, ratio) = sizing.parts();
        (
          true,
          ratio.map(|(w, h)| w / h),
          sizing.concrete((300.0, 150.0)),
        )
      }
      Loaded::Broken => (false, None, (0.0, 0.0)),
    };
    let (bw, bh) = match (width, height) {
      (Some(w), Some(h)) => (w, h),
      (Some(w), None) => (w, ratio.map(|r| w / r).unwrap_or(concrete.1)),
      (None, Some(h)) => (ratio.map(|r| h * r).unwrap_or(concrete.0), h),
      (None, None) if natural => concrete,
      (None, None) => return,
    };
    if !(bw > 0.0 && bh > 0.0) {
      return;
    }
    let (key, image_par) = match &*loaded {
      Loaded::Svg(nested, sizing) => {
        // SVGImagePainter::ComputeImageViewportSize.
        let container = if par_none {
          sizing.concrete((bw, bh))
        } else {
          (bw, bh)
        };
        let url: Rc<str> = Rc::from(trimmed);
        let Some(k) = self.shared.nested_svg(&url, nested, container) else {
          return;
        };
        // The frame always fills the box (SVGImage::DrawForContainer).
        (format!("napi-svg:{k}"), Some("none".to_owned()))
      }
      Loaded::Raster(data, size) => {
        let url: Rc<str> = Rc::from(trimmed);
        let Some(k) = self.shared.raster(&url, data, *size, quality) else {
          return;
        };
        (format!("napi-img:{k}"), par)
      }
      Loaded::Broken => {
        // ComputeImageViewportSize is empty for a broken image with
        // preserveAspectRatio none.
        if par_none {
          return;
        }
        let Some(k) = self.shared.broken_image(quality) else {
          return;
        };
        (format!("napi-img:{k}"), par)
      }
    };
    if !self.shared.take_element() {
      return;
    }
    let mut pieces = Vec::new();
    if let Some(t) = self.transform_value(n, style) {
      pieces.push(attr("transform", t));
    }
    self.presentation(style, Some(&parent.out), &mut pieces);
    // SkSVG folds a leaf's opacity into its fill, which an image never
    // uses; with no fill and no stroke it takes a layer.
    pieces.retain(|p| !matches!(p.name(), "fill" | "stroke"));
    pieces.push(attr("fill", "none"));
    pieces.push(attr("stroke", "none"));
    // SkSVGImage draws a sliced image unclipped; Blink clips it to the
    // image viewport.
    let slice = image_par.as_deref().is_some_and(|p| p.contains("slice"));
    if slice {
      self.uid += 1;
      let id = format!("__napi_ic{}", self.uid);
      write!(
        self.defs,
        "<clipPath id=\"{id}\"><rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\"/></clipPath>",
        num(x),
        num(y),
        num(bw),
        num(bh)
      )
      .unwrap();
      // In the image's user space, under its transform.
      let mut group = Vec::new();
      pieces.retain(|p| {
        if p.name() == "transform" {
          group.push(p.clone());
          false
        } else {
          true
        }
      });
      group.push(attr("clip-path", format!("url(#{id})")));
      self.open("g", &group);
    }
    pieces.extend([
      attr("x", num(x)),
      attr("y", num(y)),
      attr("width", num(bw)),
      attr("height", num(bh)),
      attr("xlink:href", key),
    ]);
    if let Some(p) = image_par {
      pieces.push(attr("preserveAspectRatio", p));
    }
    self.open("image", &pieces);
    self.out.push_str("</image>");
    if slice {
      self.out.push_str("</g>");
    }
  }
}
