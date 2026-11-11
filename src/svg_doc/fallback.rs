//! convertSVGTextToPath hands a document past svg_doc's work budgets to
//! SkSVG as written (main's path). `clean` first edits its bytes so SkSVG
//! does not loop and sees the references svg_doc saw:
//!
//! - A `<pattern>` href chain that runs into a cycle loops for ever in
//!   SkSVGPattern::resolveHref (no loop check; a cycle through the painted
//!   pattern ends there, as that one is borrowed). The reference that
//!   closes the cycle at the chain's entry is blanked, so a chain from
//!   outside walks the cycle once, as Blink's visited set does.
//! - SkSVG reads only an attribute spelled `xlink:href` (expat runs without
//!   namespaces). The href svg_doc reads on use, pattern, gradients and
//!   textPath (`href`, else an XLink `href` under any prefix) is renamed
//!   `xlink:href`, and any other `xlink:href` there is blanked. Main ignored
//!   those references, so SkSVG may now draw much more (a `<use href>`
//!   fan-out): the renames are made only when SkSVG's work and stack depth
//!   stay bounded (`Cost`), else none is.
//! - `<!ATTLIST>` declarations are blanked: expat applies their defaults,
//!   roxmltree (so svg_doc) does not.
//!
//! Every other byte is kept. What else svg_doc reads that SkSVG does not
//! (`<style>`, `<symbol>`, `<switch>`, font-family lists, Blink's rules for
//! `<use>` and `url()` cycles, first-wins ids) stays as on main.

use std::collections::HashMap;
use std::ops::Range;

use super::dom::{self, Doc, NodeData, NodeId};

/// The work the renames may add to SkSVG's, in element visits (a shape or a
/// text fragment costs 32 more, plus its path data or text length): about
/// 0.25 s (measured on main: 8^8 empty `<use>` visits take 0.54 s, 8^6
/// rects 0.2 s).
const WORK_LIMIT: u64 = 1 << 24;

/// The stack depth the renames may reach, past the document's own, in
/// `<use>` levels: SkSVG crashed (SIGSEGV) at 16000 `<use>` levels on main's
/// 8 MB stack, 8000 clip-path levels and 2000 nested patterns. 1024 leaves
/// room on a 4 MB worker stack.
const DEPTH_LIMIT: u32 = 1024;

/// Work and depth saturate here.
const CAP: u64 = 1 << 40;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Tag {
  Svg,
  G,
  Use,
  Shape,
  /// text and tspan.
  Text,
  TextPath,
  ClipPath,
  Mask,
  Pattern,
  Gradient,
  Filter,
  /// defs, stop, fe*, image: drawn as nothing.
  Leaf,
}

/// SkSVG's tag table (SkSVGDOM.cpp gTagFactories, plus `svg`), by raw QName.
fn tag(raw: &str) -> Option<Tag> {
  Some(match raw {
    "svg" => Tag::Svg,
    "a" | "g" => Tag::G,
    "use" => Tag::Use,
    "circle" | "ellipse" | "line" | "path" | "polygon" | "polyline" | "rect" => Tag::Shape,
    "text" | "tspan" => Tag::Text,
    "textPath" => Tag::TextPath,
    "clipPath" => Tag::ClipPath,
    "mask" => Tag::Mask,
    "pattern" => Tag::Pattern,
    "linearGradient" | "radialGradient" => Tag::Gradient,
    "filter" => Tag::Filter,
    "defs"
    | "stop"
    | "image"
    | "feBlend"
    | "feColorMatrix"
    | "feComponentTransfer"
    | "feComposite"
    | "feDiffuseLighting"
    | "feDisplacementMap"
    | "feDistantLight"
    | "feFlood"
    | "feFuncA"
    | "feFuncB"
    | "feFuncG"
    | "feFuncR"
    | "feGaussianBlur"
    | "feImage"
    | "feMerge"
    | "feMergeNode"
    | "feMorphology"
    | "feOffset"
    | "fePointLight"
    | "feSpecularLighting"
    | "feSpotLight"
    | "feTurbulence" => Tag::Leaf,
    _ => return None,
  })
}

/// A fill or stroke as SkSVG keeps it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Paint {
  /// Not set (or `inherit`): the parent's.
  Inherit,
  /// A colour or `none`.
  Plain,
  /// `url(#id)`, with its element.
  Url(Option<u32>),
}

/// A paint or reference as written, before ids are known.
#[derive(Clone, Debug)]
enum RawRef {
  Unset,
  Plain,
  Url(String),
}

/// An element SkSVG builds.
struct El {
  node: NodeId,
  tag: Tag,
  /// The elements SkSVG builds below this one, in order.
  children: Vec<u32>,
  /// Text fragments (text, tspan, textPath).
  fragments: u64,
  /// What drawing the element itself costs past its visit: 32 and the
  /// path data of a shape, 32 and the text of each fragment.
  own: u64,
  fill: Paint,
  stroke: Paint,
  clip: Option<u32>,
  mask: Option<u32>,
  filter: Option<u32>,
  /// The element `xlink:href` names, as written (0) and after the renames
  /// (1).
  href: [Option<u32>; 2],
  /// use, pattern, gradients, textPath: the attribute spelled
  /// `xlink:href`, and the one svg_doc reads (dom::Doc::href), as indices
  /// into the node's attributes.
  xlink: Option<usize>,
  chosen: Option<usize>,
}

struct Model<'t> {
  text: &'t str,
  els: Vec<El>,
}

/// The QName at `range` in the text, when it spells `local` (unprefixed or
/// under a prefix). roxmltree keeps a QName length in a u16.
fn raw_qname<'t>(text: &'t str, range: Range<usize>, local: &str) -> Option<&'t str> {
  let raw = text.get(range)?;
  (raw == local || raw.strip_suffix(local)?.ends_with(':') && raw.len() > local.len() + 1)
    .then_some(raw)
}

/// SkSVG's TrimmedString.
fn trim(s: &str) -> &str {
  s.trim_matches(|c: char| c <= ' ')
}

/// An IRI SkSVGAttributeParser takes as local: `#` and what follows up to a
/// `)`, after optional whitespace.
fn local_iri(value: &str) -> Option<&str> {
  let rest = value
    .trim_start_matches(|c: char| c.is_ascii_whitespace())
    .strip_prefix('#')?;
  let id = &rest[..rest.find(')').unwrap_or(rest.len())];
  (!id.is_empty()).then_some(id)
}

/// `url(#id)` as SkSVGAttributeParser::parseFuncIRI reads it.
fn func_iri(value: &str) -> Option<&str> {
  let ws = |c: char| c.is_ascii_whitespace();
  let rest = value
    .trim_start_matches(ws)
    .strip_prefix("url")?
    .trim_start_matches(ws)
    .strip_prefix('(')?;
  rest.contains(')').then_some(())?;
  local_iri(rest)
}

/// A fill or stroke value; None when SkSVG would not parse it (it keeps
/// the value it had). A colour keyword not checked here counts as not
/// parsed, so the element keeps inheriting: that only overcounts.
fn paint(value: &str) -> Option<RawRef> {
  let v = trim(value);
  if v == "inherit" {
    return Some(RawRef::Unset);
  }
  if v.starts_with("url") {
    return func_iri(v).map(|id| RawRef::Url(id.to_owned()));
  }
  let plain = v == "none"
    || v == "currentColor"
    || v.starts_with('#')
    || v.starts_with("rgb(")
    || v.starts_with("rgba(");
  plain.then_some(RawRef::Plain)
}

/// clip-path, mask, filter.
fn reference(value: &str) -> Option<RawRef> {
  let v = trim(value);
  match v {
    "inherit" | "none" => Some(RawRef::Unset),
    _ => func_iri(v).map(|id| RawRef::Url(id.to_owned())),
  }
}

#[derive(Default)]
struct Refs {
  id: Option<String>,
  fill: Option<RawRef>,
  stroke: Option<RawRef>,
  clip: Option<RawRef>,
  mask: Option<RawRef>,
  filter: Option<RawRef>,
  href: [Option<String>; 2],
}

impl Refs {
  /// One attribute or style="" declaration, as SkSVG sets it: a value it
  /// does not parse keeps the last one.
  fn set(&mut self, name: &str, value: &str) {
    let slot = match name {
      "fill" => (&mut self.fill, paint(value)),
      "stroke" => (&mut self.stroke, paint(value)),
      "clip-path" => (&mut self.clip, reference(value)),
      "mask" => (&mut self.mask, reference(value)),
      "filter" => (&mut self.filter, reference(value)),
      _ => return,
    };
    if let (slot, Some(v)) = slot {
      *slot = Some(v);
    }
  }
}

impl<'t> Model<'t> {
  /// SkSVG's view of the tree: only elements it builds (an unknown tag
  /// drops its subtree), its last-wins ids, and the references it follows.
  fn read(doc: &Doc, text: &'t str) -> Model<'t> {
    let mut els: Vec<El> = Vec::new();
    let mut refs: Vec<Refs> = Vec::new();
    let mut ids: HashMap<String, u32> = HashMap::new();
    let mut stack = vec![(doc.root, None::<u32>)];
    while let Some((node, parent)) = stack.pop() {
      let NodeData::Element { name, attrs, .. } = &doc.nodes[node].data else {
        continue;
      };
      let start = doc.nodes[node].start;
      let raw = text.get(start + 1..).and_then(|rest| {
        let len = rest
          .find(|c: char| c.is_ascii_whitespace() || c == '/' || c == '>')
          .unwrap_or(rest.len());
        raw_qname(text, start + 1..start + 1 + len, name)
      });
      let Some(tag) = raw.and_then(tag) else {
        continue;
      };
      if text.as_bytes().get(start) != Some(&b'<') {
        continue;
      }
      let index = els.len() as u32;
      let mut r = Refs::default();
      let mut own = 0u64;
      let mut xlink = None;
      for (k, a) in attrs.iter().enumerate() {
        let Some(raw) = raw_qname(text, a.range.start..a.qname_end, &a.name) else {
          continue;
        };
        match raw {
          "id" => r.id = Some(a.value.clone()),
          "style" => {
            for decl in a.value.split(';') {
              let Some((n, v)) = decl.split_once(':') else {
                break;
              };
              let n = trim(n);
              if n.is_empty() {
                break;
              }
              r.set(n, v);
            }
          }
          "d" | "points" if tag == Tag::Shape => own = a.value.len() as u64,
          "xlink:href" => xlink = Some(k),
          _ => r.set(raw, &a.value),
        }
      }
      let hrefs = matches!(tag, Tag::Use | Tag::Pattern | Tag::Gradient | Tag::TextPath);
      let chosen = if hrefs {
        attrs
          .iter()
          .position(|a| a.ns == dom::Ns::None && a.name == "href")
          .or_else(|| {
            attrs
              .iter()
              .position(|a| a.ns == dom::Ns::Xlink && a.name == "href")
          })
      } else {
        None
      };
      let xlink = xlink.filter(|_| hrefs);
      r.href = [xlink, chosen].map(|k| {
        k.and_then(|k| local_iri(&attrs[k].value))
          .map(str::to_owned)
      });
      let mut fragments = 0;
      if matches!(tag, Tag::Text | Tag::TextPath) {
        for &c in &doc.nodes[node].children {
          if let NodeData::Text(t) = &doc.nodes[c].data {
            fragments += 1;
            own = own.saturating_add(32 + t.len() as u64);
          }
        }
      } else if tag == Tag::Shape {
        own += 32;
      }
      if let Some(id) = r.id.take() {
        ids.insert(id, index);
      }
      els.push(El {
        node,
        tag,
        children: Vec::new(),
        fragments,
        own,
        fill: Paint::Inherit,
        stroke: Paint::Inherit,
        clip: None,
        mask: None,
        filter: None,
        href: [None; 2],
        xlink,
        chosen,
      });
      refs.push(r);
      if let Some(p) = parent {
        els[p as usize].children.push(index);
      }
      for &c in doc.nodes[node].children.iter().rev() {
        stack.push((c, Some(index)));
      }
    }
    let find = |id: &str| ids.get(id).copied();
    let target = |r: &Option<RawRef>| match r {
      Some(RawRef::Url(id)) => find(id),
      _ => None,
    };
    let paint = |r: &Option<RawRef>| match r {
      None | Some(RawRef::Unset) => Paint::Inherit,
      Some(RawRef::Plain) => Paint::Plain,
      Some(RawRef::Url(id)) => Paint::Url(find(id)),
    };
    for (e, r) in els.iter_mut().zip(&refs) {
      e.fill = paint(&r.fill);
      e.stroke = paint(&r.stroke);
      e.clip = target(&r.clip);
      e.mask = target(&r.mask);
      e.filter = target(&r.filter);
      e.href = [0, 1].map(|v| r.href[v].as_deref().and_then(find));
    }
    Model { text, els }
  }

  fn tag(&self, i: u32) -> Tag {
    self.els[i as usize].tag
  }

  /// The pattern or gradient each one's href chain goes on to, in
  /// `variant`: a gradient with stops of its own does not follow it
  /// (SkSVGGradient::collectColorStops).
  fn chain(&self, variant: usize, broken: &[bool]) -> Vec<Option<u32>> {
    self
      .els
      .iter()
      .enumerate()
      .map(|(i, e)| {
        let t = e.href[variant]?;
        match e.tag {
          Tag::Pattern if !broken[i] && self.tag(t) == Tag::Pattern => Some(t),
          Tag::Gradient if e.children.is_empty() && self.tag(t) == Tag::Gradient => Some(t),
          _ => None,
        }
      })
      .collect()
  }
}

/// The patterns whose href closes a cycle a pattern outside it runs into:
/// at each such cycle, the one before its first entry (in document order).
/// A walk from outside then goes round the cycle once; a cycle nothing
/// runs into is left as it is (SkSVG stops at the painted pattern).
fn cycle_breaks(next: &[Option<u32>]) -> Vec<usize> {
  let n = next.len();
  // 0 new, 1 on this walk, 2 done.
  let mut state = vec![0u8; n];
  // The cycle an element is on, and the element before it there.
  let mut cycle = vec![u32::MAX; n];
  let mut before = vec![0u32; n];
  let mut cycles = 0u32;
  let mut path = Vec::new();
  for s in 0..n {
    path.clear();
    let mut x = Some(s as u32);
    while let Some(c) = x {
      if state[c as usize] != 0 {
        break;
      }
      state[c as usize] = 1;
      path.push(c);
      x = next[c as usize];
    }
    if let Some(c) = x
      && state[c as usize] == 1
    {
      let pos = path.iter().position(|&p| p == c).unwrap_or(0);
      let ring = &path[pos..];
      for (k, &p) in ring.iter().enumerate() {
        cycle[p as usize] = cycles;
        before[p as usize] = ring[(k + ring.len() - 1) % ring.len()];
      }
      cycles += 1;
    }
    for &p in &path {
      state[p as usize] = 2;
    }
  }
  let mut entry = vec![u32::MAX; cycles as usize];
  for (p, q) in next.iter().enumerate() {
    if let Some(q) = *q
      && cycle[p] == u32::MAX
      && cycle[q as usize] != u32::MAX
    {
      let e = &mut entry[cycle[q as usize] as usize];
      *e = (*e).min(q);
    }
  }
  entry
    .into_iter()
    .filter(|&e| e != u32::MAX)
    .map(|e| before[e as usize] as usize)
    .collect()
}

/// For each element on `next` (a function graph), how many elements a walk
/// from it visits before it ends or comes back to one it visited, and the
/// first of those `full` holds (SkSVGPattern::resolveHref's content node).
fn walks(next: &[Option<u32>], full: impl Fn(usize) -> bool) -> Vec<(u64, Option<u32>)> {
  let n = next.len();
  let mut out = vec![(0u64, None); n];
  let mut state = vec![0u8; n];
  let mut path = Vec::new();
  for s in 0..n {
    path.clear();
    let mut x = Some(s as u32);
    while let Some(c) = x {
      if state[c as usize] != 0 {
        break;
      }
      state[c as usize] = 1;
      path.push(c as usize);
      x = next[c as usize];
    }
    let mut tail = path.len();
    if let Some(c) = x
      && state[c as usize] == 1
    {
      tail = path.iter().position(|&p| p == c as usize).unwrap_or(0);
      let ring = &path[tail..];
      let mut content = None;
      // Twice round, so the first element sees the content after the last.
      for _ in 0..2 {
        for &p in ring.iter().rev() {
          if full(p) {
            content = Some(p as u32);
          }
          out[p] = (ring.len() as u64, content);
        }
      }
    }
    for &p in path[..tail].iter().rev() {
      let (len, content) = next[p].map_or((0, None), |q| out[q as usize]);
      out[p] = (len + 1, if full(p) { Some(p as u32) } else { content });
    }
    for &p in &path {
      state[p] = 2;
    }
  }
  out
}

/// SkSVG's work drawing a document, and its stack depth.
#[derive(Clone, Copy, Default, Debug)]
struct Val {
  /// The work, as `a + f * F + s * S`, where F and S are what painting
  /// once with the fill and the stroke the element inherits costs.
  a: u64,
  f: u64,
  s: u64,
  /// The stack depth, in `<use>` levels.
  d: u32,
}

fn add(x: u64, y: u64) -> u64 {
  x.saturating_add(y).min(CAP)
}

impl Val {
  fn plus(&mut self, x: Val) {
    self.a = add(self.a, x.a);
    self.f = add(self.f, x.f);
    self.s = add(self.s, x.s);
  }
}

/// What is computed per element: the work of drawing it (render), of its
/// outline (SkSVGNode::asPath, for clip paths and textPath), of painting
/// with it (asPaint), and of a clip path, mask or filter it is.
#[derive(Clone, Copy)]
enum Kind {
  Render = 0,
  Path = 1,
  Paint = 2,
  Clip = 3,
  Mask = 4,
  Filter = 5,
}

/// SkSVG's work and depth for one variant of the references, counted the
/// way SkSVG follows them: element visits, `<use>` targets, fill and stroke
/// paint servers per shape or text fragment (inherited along the render
/// path), pattern content and href chains, clip paths, masks, filters and
/// textPath outlines. A reference cycle (SkSVG cuts it, at a place this
/// does not follow) makes it unknown.
struct Cost<'m> {
  m: &'m Model<'m>,
  variant: usize,
  /// Pattern and gradient chains: length and content.
  walks: Vec<(u64, Option<u32>)>,
}

type Get<'g> = &'g mut dyn FnMut(Kind, u32) -> Val;

/// `x`, `w` levels below `v`.
fn below(v: &mut Val, x: Val, w: u32) -> Val {
  v.d = v.d.max(x.d.saturating_add(w));
  x
}

impl Cost<'_> {
  fn new<'m>(m: &'m Model<'m>, variant: usize, broken: &[bool]) -> Cost<'m> {
    let walks = walks(&m.chain(variant, broken), |i| !m.els[i].children.is_empty());
    Cost { m, variant, walks }
  }

  /// The element's own clip-path, mask and filter, applied when it is
  /// drawn, outlined or painted with (SkSVGNode::onPrepareToRender).
  fn prepare(&self, i: usize, v: &mut Val, get: Get) {
    let e = &self.m.els[i];
    if let Some(c) = e.clip.filter(|&c| self.m.tag(c) == Tag::ClipPath) {
      let x = below(v, get(Kind::Clip, c), 2);
      v.a = add(v.a, x.a);
    }
    if let Some(k) = e.mask.filter(|&k| self.m.tag(k) == Tag::Mask) {
      let x = below(v, get(Kind::Mask, k), 2);
      v.plus(x);
    }
    if let Some(f) = e.filter.filter(|&f| self.m.tag(f) == Tag::Filter) {
      let x = below(v, get(Kind::Filter, f), 1);
      v.a = add(v.a, x.a);
    }
  }

  /// Paints once with `p`; None when it is inherited.
  fn paint(&self, p: Paint, v: &mut Val, get: Get) -> Option<u64> {
    match p {
      Paint::Inherit => None,
      Paint::Plain | Paint::Url(None) => Some(0),
      Paint::Url(Some(t)) => Some(below(v, get(Kind::Paint, t), 1).a),
    }
  }

  /// Applies the element's own fill and stroke to the paints below it.
  fn fold(&self, i: usize, v: &mut Val, get: Get) {
    let e = &self.m.els[i];
    if let Some(c) = self.paint(e.fill, v, get) {
      v.a = add(v.a, v.f.saturating_mul(c));
      v.f = 0;
    }
    if let Some(c) = self.paint(e.stroke, v, get) {
      v.a = add(v.a, v.s.saturating_mul(c));
      v.s = 0;
    }
  }

  fn eval(&self, kind: Kind, i: usize, get: Get) -> Val {
    let e = &self.m.els[i];
    let href = e.href[self.variant];
    let mut v = Val {
      a: 1,
      ..Val::default()
    };
    match kind {
      Kind::Render => {
        match e.tag {
          Tag::Shape | Tag::Text | Tag::TextPath => {
            v.a = add(v.a, e.own);
            v.f = e.fragments.max((e.tag == Tag::Shape) as u64);
            v.s = v.f;
          }
          Tag::Use => {
            if let Some(t) = href {
              let x = below(&mut v, get(Kind::Render, t), 1);
              v.plus(x);
            }
          }
          _ => {}
        }
        if matches!(e.tag, Tag::Svg | Tag::G | Tag::Text | Tag::TextPath) {
          for &c in &e.children {
            let x = below(&mut v, get(Kind::Render, c), 1);
            v.plus(x);
          }
        }
        if e.tag == Tag::TextPath
          && let Some(t) = href
        {
          let x = below(&mut v, get(Kind::Path, t), 1);
          v.a = add(v.a, x.a);
        }
        self.prepare(i, &mut v, get);
        self.fold(i, &mut v, get);
      }
      Kind::Path => {
        match e.tag {
          Tag::Shape | Tag::Text | Tag::TextPath => v.a = add(v.a, e.own),
          Tag::Use => {
            if let Some(t) = href {
              let x = below(&mut v, get(Kind::Path, t), 1);
              v.a = add(v.a, x.a);
            }
          }
          _ => {}
        }
        if matches!(e.tag, Tag::Svg | Tag::G | Tag::Text | Tag::TextPath) {
          for &c in &e.children {
            let x = below(&mut v, get(Kind::Path, c), 1);
            v.a = add(v.a, x.a);
          }
        }
        if e.tag == Tag::TextPath
          && let Some(t) = href
        {
          let x = below(&mut v, get(Kind::Path, t), 1);
          v.a = add(v.a, x.a);
        }
        self.prepare(i, &mut v, get);
      }
      Kind::Paint => {
        self.prepare(i, &mut v, get);
        let (len, content) = self.walks[i];
        match e.tag {
          Tag::Pattern => {
            v.a = add(v.a, len);
            if let Some(c) = content {
              // Drawn in a fresh context with the pattern's own fill and
              // stroke (SkSVGRenderContext::commonPaint).
              let mut content_val = Val::default();
              for &k in &self.m.els[c as usize].children {
                let x = below(&mut content_val, get(Kind::Render, k), 8);
                content_val.plus(x);
              }
              self.fold(i, &mut content_val, get);
              v.a = add(v.a, content_val.a);
              v.d = v.d.max(content_val.d);
            }
          }
          Tag::Gradient => {
            // collectColorStops recurses along the chain.
            v.a = add(v.a, len);
            v.d = v.d.max(len.min(CAP) as u32);
            if let Some(c) = content {
              v.a = add(v.a, self.m.els[c as usize].children.len() as u64);
            }
          }
          _ => {}
        }
      }
      Kind::Clip => {
        self.prepare(i, &mut v, get);
        for &c in &e.children {
          let x = below(&mut v, get(Kind::Path, c), 1);
          v.a = add(v.a, x.a);
        }
      }
      Kind::Mask => {
        for &c in &e.children {
          let x = below(&mut v, get(Kind::Render, c), 1);
          v.plus(x);
        }
        self.prepare(i, &mut v, get);
        self.fold(i, &mut v, get);
      }
      Kind::Filter => {
        self.prepare(i, &mut v, get);
        for &c in &e.children {
          v.a = add(v.a, 1);
          self.prepare(c as usize, &mut v, get);
        }
      }
    }
    if !matches!(kind, Kind::Render | Kind::Mask) {
      v.f = 0;
      v.s = 0;
    }
    v
  }

  /// The root's work and depth, None when a reference cycle is in the way.
  /// Depth first without recursion, each (kind, element) once.
  fn total(&self) -> Option<Val> {
    let n = self.m.els.len();
    if n == 0 {
      return Some(Val::default());
    }
    let key = |kind: Kind, i: u32| kind as usize * n + i as usize;
    let kinds = [
      Kind::Render,
      Kind::Path,
      Kind::Paint,
      Kind::Clip,
      Kind::Mask,
      Kind::Filter,
    ];
    // 0 new, 1 on the current path, 2 done.
    let mut state = vec![0u8; 6 * n];
    let mut done: HashMap<usize, Val> = HashMap::new();
    let mut stack = vec![(0usize, false)];
    let mut deps = Vec::new();
    while let Some((k, ready)) = stack.pop() {
      let (kind, i) = (kinds[k / n], k % n);
      if ready {
        let v = self.eval(kind, i, &mut |kind, j| done[&key(kind, j)]);
        done.insert(k, v);
        state[k] = 2;
        continue;
      }
      match state[k] {
        2 => continue,
        1 => return None,
        _ => {}
      }
      state[k] = 1;
      stack.push((k, true));
      deps.clear();
      self.eval(kind, i, &mut |kind, j| {
        deps.push(key(kind, j));
        Val::default()
      });
      for &d in &deps {
        match state[d] {
          1 => return None,
          0 => stack.push((d, false)),
          _ => {}
        }
      }
    }
    done.get(&0).copied()
  }
}

/// A byte edit: blank (spaces) or, with `rename`, `xlink:href`.
#[derive(Clone, PartialEq, Eq, Debug)]
struct Edit {
  range: Range<usize>,
  rename: bool,
}

impl Model<'_> {
  /// Blanks attribute `k` of element `i`, as written.
  fn blank(&self, i: usize, k: usize, doc: &Doc) -> Option<Edit> {
    let a = &doc.attrs(self.els[i].node)[k];
    let raw = raw_qname(self.text, a.range.start..a.qname_end, &a.name)?;
    let whole = self.text.get(a.range.clone())?;
    (whole.starts_with(raw) && (whole.ends_with('"') || whole.ends_with('\''))).then(|| Edit {
      range: a.range.clone(),
      rename: false,
    })
  }

  /// Renames attribute `k` of element `i` `xlink:href`; None when it is
  /// spelled so.
  fn rename(&self, i: usize, k: usize, doc: &Doc) -> Option<Option<Edit>> {
    let a = &doc.attrs(self.els[i].node)[k];
    let raw = raw_qname(self.text, a.range.start..a.qname_end, "href")?;
    Some((raw != "xlink:href").then_some(Edit {
      range: a.range.start..a.qname_end,
      rename: true,
    }))
  }

  /// The edits of the href attributes: `variant` 0 keeps them as written,
  /// 1 makes svg_doc's href the `xlink:href`; `broken` patterns lose it.
  fn href_edits(&self, variant: usize, broken: &[bool], doc: &Doc) -> Option<Vec<Edit>> {
    let mut edits = Vec::new();
    for (i, e) in self.els.iter().enumerate() {
      let read = if variant == 0 { e.xlink } else { e.chosen };
      if let Some(k) = read {
        if broken[i] {
          edits.push(self.blank(i, k, doc)?);
        } else if variant == 1
          && let Some(edit) = self.rename(i, k, doc)?
        {
          edits.push(edit);
        }
      }
      if variant == 1
        && let Some(k) = e.xlink
        && e.chosen != Some(k)
      {
        edits.push(self.blank(i, k, doc)?);
      }
    }
    Some(edits)
  }
}

/// The `<!ATTLIST>` declarations of the internal DTD subset, before the
/// root element at `end`.
fn attlists(text: &str, end: usize) -> Vec<Edit> {
  let b = &text.as_bytes()[..end.min(text.len())];
  if !text[..b.len()].contains("<!ATTLIST") {
    return Vec::new();
  }
  let find = |from: usize, pat: &[u8]| {
    b[from.min(b.len())..]
      .windows(pat.len())
      .position(|w| w == pat)
      .map_or(b.len(), |p| from + p + pat.len())
  };
  // A declaration's end: its `>`, past quoted literals.
  let decl_end = |from: usize| {
    let mut j = from;
    while j < b.len() {
      match b[j] {
        q @ (b'"' | b'\'') => {
          j = b[j + 1..]
            .iter()
            .position(|&c| c == q)
            .map_or(b.len(), |p| j + 1 + p);
        }
        b'>' => return j + 1,
        _ => {}
      }
      j += 1;
    }
    b.len()
  };
  let mut edits = Vec::new();
  let mut i = 0;
  let mut subset = false;
  while i < b.len() {
    if b[i].is_ascii_whitespace() {
      i += 1;
    } else if b[i..].starts_with(b"<?") {
      i = find(i + 2, b"?>");
    } else if b[i..].starts_with(b"<!--") {
      i = find(i + 4, b"-->");
    } else if !subset && b[i..].starts_with(b"<!DOCTYPE") {
      // To the subset's `[`, past the external id's literals.
      let mut j = i + 9;
      while j < b.len() && b[j] != b'[' && b[j] != b'>' {
        if let q @ (b'"' | b'\'') = b[j] {
          j = b[j + 1..]
            .iter()
            .position(|&c| c == q)
            .map_or(b.len(), |p| j + 1 + p);
        }
        j += 1;
      }
      if j >= b.len() || b[j] == b'>' {
        break;
      }
      subset = true;
      i = j + 1;
    } else if subset && b[i..].starts_with(b"<!") {
      let end = decl_end(i + 2);
      if b[i..].starts_with(b"<!ATTLIST") {
        edits.push(Edit {
          range: i..end,
          rename: false,
        });
      }
      i = end;
    } else {
      break;
    }
  }
  edits
}

/// The document for SkSVG: `Ok(None)` when it needs no edit, `Err` when a
/// pattern cycle SkSVG would loop on cannot be broken.
pub(crate) fn clean(doc: &Doc, text: &str) -> Result<Option<Vec<u8>>, ()> {
  let m = Model::read(doc, text);
  let n = m.els.len();
  let no_breaks = vec![false; n];
  let broken = |variant: usize| {
    let mut next = m.chain(variant, &no_breaks);
    for (x, e) in next.iter_mut().zip(&m.els) {
      if e.tag != Tag::Pattern {
        *x = None;
      }
    }
    let mut b = vec![false; n];
    for i in cycle_breaks(&next) {
      b[i] = true;
    }
    b
  };
  let renames = m.els.iter().any(|e| e.chosen != e.xlink);
  let mut edits = None;
  if renames {
    let new_breaks = broken(1);
    let new = Cost::new(&m, 1, &new_breaks).total();
    let main = Cost::new(&m, 0, &broken(0)).total();
    let (work, depth) = main.map_or((0, 0), |v| (v.a, v.d));
    let bounded = new.is_some_and(|v| {
      v.a < CAP && v.a <= work.saturating_add(WORK_LIMIT) && v.d <= depth.max(DEPTH_LIMIT)
    });
    if bounded {
      edits = m.href_edits(1, &new_breaks, doc);
    }
  }
  let mut edits = match edits {
    Some(edits) => edits,
    None => m.href_edits(0, &broken(0), doc).ok_or(())?,
  };
  edits.extend(attlists(text, doc.nodes[doc.root].start));
  if edits.is_empty() {
    return Ok(None);
  }
  // An element from an entity is in the text once, for each time the
  // entity is used: one blank of an attribute wins over a rename of it.
  edits.sort_by_key(|e| (e.range.start, e.range.end));
  let mut merged: Vec<Edit> = Vec::with_capacity(edits.len());
  for e in edits {
    match merged.last_mut() {
      Some(last) if *last == e => {}
      Some(last) if last.range.end > e.range.start => {
        if e.rename || last.range.start != e.range.start {
          return Err(());
        }
        *last = e;
      }
      _ => merged.push(e),
    }
  }
  let edits = merged;
  let mut out = Vec::with_capacity(text.len() + 6 * edits.len());
  let mut at = 0;
  for e in &edits {
    out.extend_from_slice(&text.as_bytes()[at..e.range.start]);
    if e.rename {
      out.extend_from_slice(b"xlink:href");
    } else {
      out.resize(out.len() + e.range.len(), b' ');
    }
    at = e.range.end;
  }
  out.extend_from_slice(&text.as_bytes()[at..]);
  Ok(Some(out))
}

#[cfg(test)]
mod tests {
  use super::*;

  const X: &str =
    r#"xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink""#;

  fn cleaned(body: &str) -> String {
    let text = format!("<svg {X}>{body}</svg>");
    let doc = Doc::parse(&text).unwrap();
    match clean(&doc, &text).unwrap() {
      Some(out) => {
        let out = String::from_utf8(out).unwrap();
        out[X.len() + 6..out.len() - 6].to_owned()
      }
      None => body.to_owned(),
    }
  }

  /// A `<g>` fan-out of `fan`^`levels` through `<use href>`, drawn once.
  fn fan_out(fan: usize, levels: usize) -> String {
    let mut s = String::from(r#"<defs><g id="l0"/>"#);
    for i in 1..=levels {
      s += &format!(r#"<g id="l{i}">"#);
      s += &format!(r##"<use href="#l{}"/>"##, i - 1).repeat(fan);
      s += "</g>";
    }
    s + &format!(r##"</defs><use href="#l{levels}"/>"##)
  }

  /// `body` with `attr` of the element ending in `owner` blanked.
  fn blanked(body: &str, owner: &str, attr: &str) -> String {
    let at = format!("{owner} {attr}");
    assert!(body.contains(&at), "{at}");
    body.replace(&at, &format!("{owner} {}", " ".repeat(attr.len())))
  }

  #[test]
  fn a_pattern_chain_into_a_cycle_walks_it_once() {
    // c -> a -> b -> a: b's href closes the cycle at a.
    let body = r##"<pattern id="c" xlink:href="#a"/><pattern id="a" xlink:href="#b"/><pattern id="b" xlink:href="#a"/>"##;
    assert_eq!(
      cleaned(body),
      blanked(body, r#"id="b""#, r##"xlink:href="#a""##)
    );
    // c -> a -> a.
    let body = r##"<pattern id="c" xlink:href="#a"/><pattern id="a" xlink:href="#a"/>"##;
    assert_eq!(
      cleaned(body),
      blanked(body, r#"id="a""#, r##"xlink:href="#a""##)
    );
    // Two ways in: the cycle closes at the first entry in document order.
    let body = r##"<pattern id="t" xlink:href="#b"/><pattern id="u" xlink:href="#a"/><pattern id="a" xlink:href="#b"/><pattern id="b" xlink:href="#a"/>"##;
    assert_eq!(
      cleaned(body),
      blanked(body, r#"id="b""#, r##"xlink:href="#a""##)
    );
  }

  #[test]
  fn a_cycle_nothing_runs_into_is_kept() {
    // SkSVG stops at the painted pattern, which is in the cycle.
    let body = r##"<pattern id="a" xlink:href="#b"/><pattern id="b" xlink:href="#a"/><rect width="5" height="5" fill="url(#a)"/>"##;
    assert_eq!(cleaned(body), body);
    // Gradients and <use> stop at the borrowed element.
    let body = r##"<linearGradient id="c" xlink:href="#a"/><linearGradient id="a" xlink:href="#a"/><use id="u" xlink:href="#u"/>"##;
    assert_eq!(cleaned(body), body);
  }

  #[test]
  fn svg2_href_becomes_xlink_href() {
    assert_eq!(
      cleaned(r##"<rect id="r" width="3" height="3"/><use href="#r" x="5"/>"##),
      r##"<rect id="r" width="3" height="3"/><use xlink:href="#r" x="5"/>"##
    );
    // href wins over xlink:href, as in svg_doc.
    let body = r##"<rect id="a"/><rect id="b"/><use xlink:href="#b" href="#a"/>"##;
    assert_eq!(
      cleaned(body),
      blanked(body, "<use", r##"xlink:href="#b""##)
        .replace(r##" href="#a""##, r##" xlink:href="#a""##)
    );
    // An XLink href under another prefix.
    assert_eq!(
      cleaned(r##"<rect id="r"/><use xmlns:l="http://www.w3.org/1999/xlink" l:href="#r"/>"##),
      r##"<rect id="r"/><use xmlns:l="http://www.w3.org/1999/xlink" xlink:href="#r"/>"##
    );
    // Not on elements SkSVG does not follow.
    let body = r##"<a href="#r"><rect id="r"/></a>"##;
    assert_eq!(cleaned(body), body);
  }

  #[test]
  fn an_xlink_prefix_of_another_namespace_is_blanked() {
    let body = r##"<rect id="r"/><use xmlns:xlink="urn:x" xlink:href="#r"/>"##;
    assert_eq!(
      cleaned(body),
      blanked(body, r#"xmlns:xlink="urn:x""#, r##"xlink:href="#r""##)
    );
  }

  #[test]
  fn a_renamed_pattern_cycle_is_broken_too() {
    // SkSVG ignored the SVG2 cycle; renamed, it would loop.
    let body =
      r##"<pattern id="c" href="#a"/><pattern id="a" href="#b"/><pattern id="b" href="#a"/>"##;
    assert_eq!(
      cleaned(body),
      blanked(body, r#"id="b""#, r##"href="#a""##).replace(" href=", " xlink:href=")
    );
  }

  #[test]
  fn renames_stay_within_the_work_and_depth_limits() {
    // 8^6 instances: renamed.
    let body = fan_out(8, 6);
    assert!(!cleaned(&body).contains(" href="));
    // 8^10: SkSVG would take minutes; left as on main.
    let body = fan_out(8, 10);
    assert_eq!(cleaned(&body), body);
    // A 2000-level <use> chain: deeper than the limit.
    let mut body = String::from(r#"<defs><g id="u0"/>"#);
    for i in 1..2000 {
      body += &format!(r##"<use id="u{i}" href="#u{}"/>"##, i - 1);
    }
    body += r##"</defs><use href="#u1999"/>"##;
    assert_eq!(cleaned(&body), body);
    // A pattern painting many shapes through an inherited fill counts once
    // per shape: 2^12 rects times 8^5 instances.
    let mut body = String::from(r#"<defs><g id="l0"/>"#);
    for i in 1..=5 {
      body += &format!(r#"<g id="l{i}">"#);
      body += &format!(r##"<use href="#l{}"/>"##, i - 1).repeat(8);
      body += "</g>";
    }
    body += r##"<pattern id="p" width="1" height="1"><use href="#l5"/></pattern></defs><g fill="url(#p)">"##;
    body += &r#"<rect width="1" height="1"/>"#.repeat(1 << 12);
    body += "</g>";
    assert_eq!(cleaned(&body), body);
    // A reference cycle the renames make: not renamed.
    let body = r##"<g id="g"><rect width="2" height="2"/><use href="#g"/></g>"##;
    assert_eq!(cleaned(body), body);
  }

  #[test]
  fn work_already_in_the_document_does_not_count() {
    // An xlink:href fan-out of 8^8 and one <use href>: renamed.
    let mut body = String::from(r#"<defs><g id="l0"/>"#);
    for i in 1..=8 {
      body += &format!(r#"<g id="l{i}">"#);
      body += &format!(r##"<use xlink:href="#l{}"/>"##, i - 1).repeat(8);
      body += "</g>";
    }
    body += r##"</defs><use xlink:href="#l8"/><rect id="r"/><use href="#r"/>"##;
    assert!(cleaned(&body).ends_with(r##"<rect id="r"/><use xlink:href="#r"/>"##));
  }

  #[test]
  fn attlist_defaults_are_blanked() {
    let text = format!(
      r##"<?xml version="1.0"?><!DOCTYPE svg [<!-- x --><!ATTLIST use xlink:href CDATA "#r">]><svg {X}><rect id="r"/><use/></svg>"##
    );
    let doc = Doc::parse(&text).unwrap();
    let out = String::from_utf8(clean(&doc, &text).unwrap().unwrap()).unwrap();
    let decl = r##"<!ATTLIST use xlink:href CDATA "#r">"##;
    assert_eq!(out, text.replace(decl, &" ".repeat(decl.len())));
  }

  #[test]
  fn entity_elements_are_edited_in_the_entity() {
    let text = format!(
      r##"<!DOCTYPE svg [<!ENTITY u '<use href="#r"/>'>]><svg {X}><rect id="r"/>&u;&u;</svg>"##
    );
    let doc = Doc::parse(&text).unwrap();
    let out = String::from_utf8(clean(&doc, &text).unwrap().unwrap()).unwrap();
    assert_eq!(out, text.replace("<use href", "<use xlink:href"));
  }

  #[test]
  fn a_blank_wins_over_a_rename_of_the_same_entity_text() {
    // Each use of the entity is a pattern with id p: the first runs into
    // the second, whose href to itself is the cycle. Both are one attribute
    // in the text: blanked.
    let text = format!(
      r##"<!DOCTYPE svg [<!ENTITY p '<pattern id="p" href="#p"/>'>]><svg {X}><use href="#r"/><rect id="r"/>&p;&p;</svg>"##
    );
    let doc = Doc::parse(&text).unwrap();
    let out = String::from_utf8(clean(&doc, &text).unwrap().unwrap()).unwrap();
    assert_eq!(
      out,
      text
        .replace(r##"id="p" href="#p""##, r#"id="p"          "#)
        .replace(r##"<use href"##, r##"<use xlink:href"##)
    );
  }

  #[test]
  fn walks_end_where_they_come_back() {
    // 0 -> 1 -> 2 -> 1, 3 alone; 2 holds content.
    let next = [Some(1), Some(2), Some(1), None];
    let w = walks(&next, |i| i == 2);
    assert_eq!(w, vec![(3, Some(2)), (2, Some(2)), (2, Some(2)), (1, None)]);
  }
}
