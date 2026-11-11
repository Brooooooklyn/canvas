//! convertSVGTextToPath hands a document past svg_doc's work budgets to
//! SkSVG as written (main's path). `clean` first edits its bytes so SkSVG
//! does not loop and sees the references svg_doc saw:
//!
//! - SkSVGPattern::resolveHref has no loop check. A walk from a painted
//!   pattern stops once x, y, width, height, patternTransform and the
//!   content are all found, at the end of the chain, or back at the painted
//!   pattern (it is borrowed); a walk into a cycle that finds none of these
//!   goes round for ever. `walk_cuts` runs these walks as SkSVG does and
//!   blanks one href on each cycle a walk would go round for ever, where
//!   that walk comes back (Blink's visited set), unless a walk that ends
//!   uses that href before its result is complete.
//! - SkSVG reads only an attribute spelled `xlink:href` (expat runs without
//!   namespaces). The href svg_doc reads on use, pattern, gradients and
//!   textPath (`href`, else an XLink `href` under any prefix) is renamed
//!   `xlink:href`, and any other `xlink:href` there is blanked. Main ignored
//!   those references, so SkSVG may now draw much more (a `<use href>`
//!   fan-out). The renames are made only when `Graph` bounds the work and
//!   stack depth they add (all or none). `Graph` over-approximates what
//!   SkSVG may follow, so a value SkSVG parses in a way this module does
//!   not model cannot hide a reference from it. A draw whose cost is not
//!   bounded by its bytes (clip content, a filter, a textPath's outline of
//!   anything but a `<path>`, a dashed stroke) may not be added at all. A
//!   textPath href is renamed only when it names a `<path>` (svg_doc, as
//!   Blink, draws no text along anything else).
//! - `<!ATTLIST>` declarations are blanked: expat applies their defaults,
//!   roxmltree (so svg_doc) does not. Any default may hide content (display,
//!   an empty viewBox, a pattern width of 0), so they are blanked only when
//!   `Graph` bounds the whole document; else the document is left as it is.
//!
//! Every other byte is kept. What else svg_doc reads that SkSVG does not
//! (`<style>`, `<symbol>`, `<switch>`, font-family lists, Blink's rules for
//! `<use>` and `url()` cycles, first-wins ids) stays as on main.

use std::collections::{HashMap, HashSet};
use std::ops::Range;

use super::dom::{self, Doc, NodeData, NodeId};
use super::values::local_ref;

/// The work the renames may add to SkSVG's, in element visits (a shape, a
/// text or an image costs 32 more, plus its attribute values and text):
/// about 0.25 s (measured on main: 8^8 empty `<use>` visits take 0.54 s,
/// 8^6 rects 0.2 s).
const WORK_LIMIT: u64 = 1 << 24;

/// The stack depth a call chain through a renamed reference may reach, in
/// `<use>` levels (a child or an href 1, a url() 8): SkSVG crashed
/// (SIGSEGV) at 16000 `<use>` levels on main's 8 MB stack, 8000 clip-path
/// levels and 2000 nested patterns. 1024 leaves room on a 4 MB worker
/// stack.
const DEPTH_LIMIT: u64 = 1024;

/// Counts and work saturate here.
const CAP: u64 = 1 << 50;

/// The work of a text byte, per call: a glyph outline is about 1.4 KB of
/// path data (8^4 `<use>` draws of 100 "W" went past 1 GB).
const GLYPH_WORK: u64 = 1024;

/// The work of a path data byte when the data has an arc command (`A` or
/// `a`, any byte): SkSVG makes up to 4 conics of an arc and the SVG canvas
/// writes each one as up to 32 quads, about 5 KB from an arc of 10 bytes
/// (512 `<use href>` draws of 400 arcs went past 1 GB).
const ARC_WORK: u64 = 1024;

/// The work of a draw of a rounded rect: SkSVGDevice::drawRRect writes
/// any rrect but an oval or a plain rect as path data, 4 conics of up to
/// 32 quads each, 2.5 to 7 KB a draw (Codex cleanup round 5: 8^6 `<use
/// href>` draws of a 24x24 icon with rx="4" went past 1 GB).
const RRECT_WORK: u64 = 1 << 14;

/// Whether a style value may declare `d` (SkSVG's StyleIterator trims a
/// name of bytes up to ' ' and, as a signed char, from 0x80): any `d`
/// before such bytes and a `:`, in any case.
fn may_declare_d(value: &str) -> bool {
  let b = value.as_bytes();
  (0..b.len()).any(|i| {
    b[i] | 0x20 == b'd'
      && b[i + 1..]
        .iter()
        .find(|&&c| !(c <= b' ' || c >= 0x80))
        .is_some_and(|&c| c == b':')
  })
}

/// Bytes the reference scan may compare; past them the references are not
/// known (no renames; every pattern counts as painted).
const SCAN_LIMIT: u64 = 1 << 26;

/// References the scan may keep.
const EDGE_LIMIT: usize = 1 << 24;

/// Steps the pattern walks may take; past them each cycle a painted
/// pattern's chain runs into is cut where the first walk into it comes
/// back (no hang; a walk that ends there may lose what it took past the
/// cut).
const WALK_LIMIT: u64 = 1 << 21;

/// Calls to the object bounding box of the element being drawn that one
/// call of a mask, clip path, filter, filter primitive or gradient may make
/// (SkSVGRenderContext::transformForCurrentOBB, resolveOBBRect: a mask
/// makes 2, a lighting primitive up to 4).
const OBB_CALLS: u64 = 4;

fn add(x: u64, y: u64) -> u64 {
  x.saturating_add(y).min(CAP)
}

fn mul(x: u64, y: u64) -> u64 {
  x.saturating_mul(y).min(CAP)
}

/// SkSVG's view of an element, by raw QName (SkSVGDOM.cpp gTagFactories,
/// plus `svg`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Tag {
  Pattern,
  Use,
  Gradient,
  TextPath,
  Other,
}

fn tag(raw: &str) -> Option<Tag> {
  Some(match raw {
    "pattern" => Tag::Pattern,
    "use" => Tag::Use,
    "linearGradient" | "radialGradient" => Tag::Gradient,
    "textPath" => Tag::TextPath,
    "svg"
    | "a"
    | "g"
    | "circle"
    | "ellipse"
    | "line"
    | "path"
    | "polygon"
    | "polyline"
    | "rect"
    | "text"
    | "tspan"
    | "clipPath"
    | "mask"
    | "filter"
    | "stop"
    | "defs"
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
    | "feTurbulence" => Tag::Other,
    _ => return None,
  })
}

/// The QName at `range` in the text, when it spells `local` (unprefixed or
/// under a prefix). roxmltree keeps a QName length in a u16.
fn raw_qname<'t>(text: &'t str, range: Range<usize>, local: &str) -> Option<&'t str> {
  let raw = text.get(range)?;
  (raw == local || raw.strip_suffix(local)?.ends_with(':') && raw.len() > local.len() + 1)
    .then_some(raw)
}

/// SkSVGAttributeParser's whitespace.
fn is_ws(c: u8) -> bool {
  (1..=32).contains(&c)
}

/// SkSVG's TrimmedString with an unsigned char: bytes up to ' '.
fn trim(s: &str) -> &str {
  s.trim_matches(|c: char| c <= ' ')
}

/// TrimmedString with a signed char (arm64 macOS, x86): bytes from 0x80 go
/// too. Only used to tell whether SkSVG may see an empty name.
fn trim_signed(s: &[u8]) -> &[u8] {
  let keep = |c: &u8| *c > b' ' && *c < 0x80;
  let start = s.iter().position(keep).unwrap_or(s.len());
  let end = s.iter().rposition(keep).map_or(start, |e| e + 1);
  &s[start..end]
}

/// The local id SkSVG's parse<SkSVGIRI> reads: `#` after whitespace, then
/// all up to a `)`.
fn sk_iri(value: &str) -> Option<&str> {
  let b = value.as_bytes();
  let start = b.iter().position(|&c| !is_ws(c))?;
  let rest = value.get(start..)?.strip_prefix('#')?;
  let id = &rest[..rest.find(')').unwrap_or(rest.len())];
  (!id.is_empty()).then_some(id)
}

/// SkSVG's StyleIterator over `style=""`, with a nested `style:` declaration
/// read again (set_string_attribute -> SetStyleAttributes), as `f(name,
/// value)`. Stops where SkSVG may stop (a name that may be empty).
fn style_decls(value: &str, f: &mut impl FnMut(&str, &str)) {
  let mut pending = vec![value];
  while let Some(s) = pending.pop() {
    let mut pos = 0;
    while pos <= s.len() {
      let rest = &s[pos..];
      let sep = rest.find(';').unwrap_or(rest.len());
      let Some(colon) = rest.find(':').filter(|&c| c < sep) else {
        break;
      };
      let name = trim(&rest[..colon]);
      if trim_signed(name.as_bytes()).is_empty() {
        break;
      }
      let v = trim(&rest[colon + 1..sep]);
      if name == "style" {
        pending.push(v);
      } else {
        f(name, v);
      }
      pos += sep + 1;
    }
  }
}

/// A value read as SkSVGAttributeParser reads it. `Err` is a form this does
/// not read (a number strtod reads as hex, inf or nan).
struct Parser<'v> {
  s: &'v str,
  at: usize,
}

type Known = Result<bool, ()>;

impl Parser<'_> {
  fn new(s: &str) -> Parser<'_> {
    Parser { s, at: 0 }
  }

  fn byte(&self, i: usize) -> Option<u8> {
    self.s.as_bytes().get(i).copied()
  }

  fn skip_ws(&self, mut i: usize) -> usize {
    while self.byte(i).is_some_and(is_ws) {
      i += 1;
    }
    i
  }

  fn ws(&mut self) -> bool {
    let start = self.at;
    self.at = self.skip_ws(self.at);
    self.at != start
  }

  /// parseSepToken.
  fn sep(&mut self) -> bool {
    let start = self.at;
    while self
      .byte(self.at)
      .is_some_and(|c| is_ws(c) || c == b',' || c == b';')
    {
      self.at += 1;
    }
    self.at != start
  }

  fn token(&mut self, t: &str) -> bool {
    let found = self.s.as_bytes()[self.at..].starts_with(t.as_bytes());
    if found {
      self.at += t.len();
    }
    found
  }

  fn eos(&self) -> bool {
    self.at == self.s.len()
  }

  fn digits(&self, i: usize) -> usize {
    self.s.as_bytes()[i.min(self.s.len())..]
      .iter()
      .take_while(|c| c.is_ascii_digit())
      .count()
  }

  /// SkParse::FindScalar (strtod): where the number after whitespace ends.
  fn find_scalar(&self) -> Result<Option<usize>, ()> {
    let mut i = self.skip_ws(self.at);
    if matches!(self.byte(i), Some(b'+' | b'-')) {
      i += 1;
    }
    let hex = self.byte(i) == Some(b'0') && matches!(self.byte(i + 1), Some(b'x' | b'X'));
    if hex || matches!(self.byte(i), Some(b'i' | b'I' | b'n' | b'N')) {
      return Err(());
    }
    let int = self.digits(i);
    let dot = self.byte(i + int) == Some(b'.');
    let frac = if dot { self.digits(i + int + 1) } else { 0 };
    if int + frac == 0 {
      return Ok(None);
    }
    i += int + if dot { 1 + frac } else { 0 };
    if matches!(self.byte(i), Some(b'e' | b'E')) {
      let sign = matches!(self.byte(i + 1), Some(b'+' | b'-')) as usize;
      let e = self.digits(i + 1 + sign);
      if e > 0 {
        i += 1 + sign + e;
      }
    }
    Ok(Some(i))
  }

  /// parseScalarToken.
  fn scalar(&mut self) -> Known {
    Ok(match self.find_scalar()? {
      Some(end) => {
        self.at = end;
        true
      }
      None => false,
    })
  }

  /// parseParenthesized: `prefix ( f )`, whitespace around each; the
  /// position is kept only on a match.
  fn parenthesized(&mut self, prefix: &str, f: impl FnOnce(&mut Self) -> Known) -> Known {
    let start = self.at;
    self.ws();
    let mut found = self.token(prefix) && {
      self.ws();
      self.token("(")
    };
    if found {
      self.ws();
      found = f(self)? && {
        self.ws();
        self.token(")")
      };
    }
    if !found {
      self.at = start;
    }
    Ok(found)
  }

  /// `sep scalar`, the separator kept when the scalar fails (as SkSVG's
  /// `parseSepToken() && parseScalarToken()`).
  fn sep_scalar(&mut self) -> Known {
    Ok(self.sep() && self.scalar()?)
  }

  /// One transform function (parseMatrixToken ... parseSkewYToken).
  fn transform_token(&mut self) -> Known {
    if self.parenthesized("matrix", |p| {
      for i in 0..6 {
        if !(p.scalar()? && (i > 4 || p.sep())) {
          return Ok(false);
        }
      }
      Ok(true)
    })? {
      return Ok(true);
    }
    if self.parenthesized("translate", |p| {
      p.ws();
      if !p.scalar()? {
        return Ok(false);
      }
      p.sep_scalar()?;
      Ok(true)
    })? {
      return Ok(true);
    }
    if self.parenthesized("scale", |p| {
      if !p.scalar()? {
        return Ok(false);
      }
      p.sep_scalar()?;
      Ok(true)
    })? {
      return Ok(true);
    }
    if self.parenthesized("rotate", |p| {
      if !p.scalar()? {
        return Ok(false);
      }
      if p.sep_scalar()? && !p.sep_scalar()? {
        return Ok(false);
      }
      Ok(true)
    })? {
      return Ok(true);
    }
    for skew in ["skewX", "skewY"] {
      if self.parenthesized(skew, |p| p.scalar())? {
        return Ok(true);
      }
    }
    Ok(false)
  }
}

/// Whether SkSVG's parse<SkSVGLength> surely takes `value`: a number, then
/// a unit, a separator or the end. A form this does not read is not sure.
fn sure_length(value: &str) -> bool {
  let p = Parser::new(value);
  let Ok(Some(end)) = p.find_scalar() else {
    return false;
  };
  let rest = &value.as_bytes()[end..];
  rest.is_empty()
    || is_ws(rest[0])
    || matches!(rest[0], b',' | b';')
    || ["%", "em", "ex", "px", "cm", "mm", "in", "pt", "pc"]
      .iter()
      .any(|u| rest.starts_with(u.as_bytes()))
}

/// Whether SkSVG's parse<SkSVGTransformType> surely takes `value`.
fn sure_transform(value: &str) -> bool {
  let mut p = Parser::new(value);
  let mut parsed = false;
  loop {
    match p.transform_token() {
      Ok(true) => parsed = true,
      Ok(false) => break,
      Err(()) => return false,
    }
    // parseCommaWspToken: whitespace, else one comma.
    if !p.ws() {
      p.token(",");
    }
  }
  p.ws();
  parsed && p.eos()
}

/// The attributes resolveHref inherits, as bits of a mask.
const PATTERN_ATTRS: [&str; 5] = ["x", "y", "width", "height", "patternTransform"];
const ALL_SET: u8 = 0b11111;

/// The bit of `name` when SkSVG surely sets it from `value`.
fn sure_set(name: &str, value: &str) -> u8 {
  match PATTERN_ATTRS.iter().position(|a| *a == name) {
    Some(4) if sure_transform(value) => 1 << 4,
    Some(k) if k < 4 && sure_length(value) => 1 << k,
    _ => 0,
  }
}

/// An element SkSVG builds.
struct SkEl {
  node: NodeId,
  tag: Tag,
  /// SkSVGContainer::hasChildren: an element it builds or text below.
  kids: bool,
  /// A pattern's attributes SkSVG surely sets (PATTERN_ATTRS bits).
  sets: u8,
  /// use, pattern, gradients, textPath: the attribute spelled
  /// `xlink:href`, and the one svg_doc reads (dom::Doc::href), as indices
  /// into the node's attributes. On a textPath, `chosen` is None when it is
  /// not `xlink` and does not name a `<path>` (see `Sk::read`).
  xlink: Option<usize>,
  chosen: Option<usize>,
}

/// SkSVG's tree: only elements it builds (an unknown tag drops its
/// subtree), in document order, and its last-wins ids.
struct Sk<'d> {
  text: &'d str,
  els: Vec<SkEl>,
  ids: HashMap<&'d str, u32>,
}

impl<'d> Sk<'d> {
  fn read(doc: &'d Doc, text: &'d str) -> Sk<'d> {
    let mut els: Vec<SkEl> = Vec::new();
    let mut ids: HashMap<&'d str, u32> = HashMap::new();
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
      let mut xlink = None;
      let mut sets = 0u8;
      for (k, a) in attrs.iter().enumerate() {
        let Some(raw) = raw_qname(text, a.range.start..a.qname_end, &a.name) else {
          continue;
        };
        match raw {
          "id" => {
            ids.insert(a.value.as_str(), index);
          }
          "xlink:href" => xlink = Some(k),
          "style" => style_decls(&a.value, &mut |n, v| sets |= sure_set(n, v)),
          _ => sets |= sure_set(raw, &a.value),
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
      let kids = doc.nodes[node]
        .children
        .iter()
        .any(|&c| matches!(&doc.nodes[c].data, NodeData::Text(t) if !t.is_empty()));
      if let Some(p) = parent {
        els[p as usize].kids = true;
      }
      els.push(SkEl {
        node,
        tag,
        kids,
        sets: if tag == Tag::Pattern { sets } else { 0 },
        xlink: xlink.filter(|_| hrefs),
        chosen,
      });
      for &c in doc.nodes[node].children.iter().rev() {
        stack.push((c, Some(index)));
      }
    }
    // SkSVG lays a textPath's text along the outline of any element
    // (SkSVGTextContext::PathData -> asPath); svg_doc, as Blink, only along
    // a <path>. A renamed href to anything else would draw text that both
    // leave out: it stays as written (SkSVG does not read it, and an
    // `xlink:href` svg_doc does not read goes). A <path> must be the
    // target in both id maps (SkSVG's last-wins, svg_doc's first-wins).
    let check: Vec<usize> = (0..els.len())
      .filter(|&i| {
        els[i].tag == Tag::TextPath && els[i].chosen.is_some() && els[i].chosen != els[i].xlink
      })
      .collect();
    if !check.is_empty() {
      let mut first: HashMap<&str, NodeId> = HashMap::new();
      for n in 0..doc.nodes.len() {
        if let Some(id) = doc.attr(n, "id") {
          first.entry(id).or_insert(n);
        }
      }
      for i in check {
        let Some(k) = els[i].chosen else { continue };
        let value = doc.attrs(els[i].node)[k].value.as_str();
        let sk = sk_iri(value)
          .and_then(|id| ids.get(id))
          .map(|&t| els[t as usize].node);
        let svg_doc = local_ref(value).and_then(|id| first.get(id).copied());
        let path = sk.is_some_and(|t| sk == svg_doc && doc.svg_name(t) == Some("path"));
        if !path {
          els[i].chosen = None;
        }
      }
    }
    Sk { text, els, ids }
  }

  /// The attribute SkSVG reads as the href in `variant` (0: as written, 1:
  /// renamed).
  fn read_href(&self, i: usize, variant: usize) -> Option<usize> {
    let e = &self.els[i];
    if variant == 0 { e.xlink } else { e.chosen }
  }

  /// The patterns, and each one's href target pattern in `variant`
  /// (SkSVGPattern::hrefTarget).
  fn pattern_graph(&self, doc: &Doc, variant: usize) -> (Vec<u32>, Vec<Option<u32>>) {
    let pats: Vec<u32> = (0..self.els.len() as u32)
      .filter(|&i| self.els[i as usize].tag == Tag::Pattern)
      .collect();
    let at: HashMap<u32, u32> = pats
      .iter()
      .enumerate()
      .map(|(k, &i)| (i, k as u32))
      .collect();
    let next = pats
      .iter()
      .map(|&i| {
        let k = self.read_href(i as usize, variant)?;
        let value = &doc.attrs(self.els[i as usize].node)[k].value;
        let t = *self.ids.get(sk_iri(value)?)?;
        at.get(&t).copied()
      })
      .collect();
    (pats, next)
  }
}

/// A resolveHref walk's state: the attributes found, and whether content
/// was.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
struct WalkState {
  sets: u8,
  content: bool,
}

impl WalkState {
  const START: WalkState = WalkState {
    sets: 0,
    content: false,
  };

  /// One step at a pattern: whether the walk stops there, the state after,
  /// and whether the result changed.
  fn step(self, sets: u8, kids: bool) -> (bool, WalkState, bool) {
    let did_inherit = self.sets != ALL_SET;
    let next = WalkState {
      sets: self.sets | sets,
      content: self.content || kids,
    };
    (next.content && !did_inherit, next, next != self)
  }
}

/// How a walk into a cycle at an entry goes on: whether it stops, and the
/// offset round the cycle (from the entry) of the last pattern that changed
/// its result.
#[derive(Clone, Copy, Debug)]
struct Lap {
  ends: bool,
  last: usize,
}

/// Where a walk from outside the cycles goes.
#[derive(Clone, Copy, Debug)]
enum Tail {
  /// Stops, or reaches the end of the chain, before any cycle.
  Ends,
  /// Runs into a cycle at this pattern, in this state.
  Enters(u32, WalkState),
}

struct Walks<'a> {
  next: &'a [Option<u32>],
  sets: &'a [u8],
  kids: &'a [bool],
  /// The cycle of each pattern (u32::MAX: none) and its place there.
  cycle: Vec<u32>,
  pos: Vec<u32>,
  rings: Vec<Vec<u32>>,
  steps: u64,
  tails: HashMap<(u32, WalkState), Tail>,
}

impl<'a> Walks<'a> {
  fn new(next: &'a [Option<u32>], sets: &'a [u8], kids: &'a [bool]) -> Walks<'a> {
    let n = next.len();
    let mut cycle = vec![u32::MAX; n];
    let mut pos = vec![0u32; n];
    let mut rings: Vec<Vec<u32>> = Vec::new();
    // 0 new, 1 on this walk, 2 done.
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
        path.push(c);
        x = next[c as usize];
      }
      if let Some(c) = x
        && state[c as usize] == 1
      {
        let at = path.iter().position(|&p| p == c).unwrap_or(0);
        let ring = path[at..].to_vec();
        for (k, &p) in ring.iter().enumerate() {
          cycle[p as usize] = rings.len() as u32;
          pos[p as usize] = k as u32;
        }
        rings.push(ring);
      }
      for &p in &path {
        state[p as usize] = 2;
      }
    }
    Walks {
      next,
      sets,
      kids,
      cycle,
      pos,
      rings,
      steps: 0,
      tails: HashMap::new(),
    }
  }

  fn spend(&mut self, n: u64) -> Result<(), ()> {
    self.steps += n;
    if self.steps > WALK_LIMIT {
      Err(())
    } else {
      Ok(())
    }
  }

  /// A walk from `p`, outside the cycles, in `state`.
  fn tail(&mut self, p: u32, state: WalkState) -> Result<Tail, ()> {
    let mut path = Vec::new();
    let (mut x, mut s) = (p, state);
    let out = loop {
      if self.cycle[x as usize] != u32::MAX {
        break Tail::Enters(x, s);
      }
      if let Some(&t) = self.tails.get(&(x, s)) {
        break t;
      }
      self.spend(1)?;
      path.push((x, s));
      let (stops, after, _) = s.step(self.sets[x as usize], self.kids[x as usize]);
      if stops {
        break Tail::Ends;
      }
      s = after;
      match self.next[x as usize] {
        Some(y) => x = y,
        None => break Tail::Ends,
      }
    };
    for key in path {
      self.tails.insert(key, out);
    }
    Ok(out)
  }

  /// A walk round cycle `c` from its member at `from`, in `state`: once
  /// round and back to `from` (`borrowed`: the walk began there, so it
  /// ends before it).
  fn lap(&mut self, c: u32, from: u32, state: WalkState, borrowed: bool) -> Result<Lap, ()> {
    let len = self.rings[c as usize].len();
    self.spend(len as u64 + 1)?;
    let mut s = state;
    let mut last = 0;
    let steps = if borrowed { len } else { len + 1 };
    for k in 0..steps {
      let p = self.rings[c as usize][(from as usize + k) % len] as usize;
      let (stops, after, changed) = s.step(self.sets[p], self.kids[p]);
      if changed {
        last = k;
      }
      if stops {
        return Ok(Lap { ends: true, last });
      }
      s = after;
    }
    Ok(Lap {
      ends: borrowed,
      last,
    })
  }
}

/// The patterns whose href is blanked so that no walk from a `painted`
/// pattern goes round a cycle for ever. None when the walks take more than
/// WALK_LIMIT steps.
fn walk_cuts(
  next: &[Option<u32>],
  sets: &[u8],
  kids: &[bool],
  painted: &[bool],
) -> Option<Vec<usize>> {
  let mut w = Walks::new(next, sets, kids);
  if w.rings.is_empty() {
    return Some(Vec::new());
  }
  let n = next.len();
  // Per cycle: the edges (from the member at offset k to the next) a walk
  // that ends uses before its result is complete, as a difference array;
  // and the walks that go round for ever: their entry and last change.
  let mut forbidden: Vec<Vec<i64>> = w.rings.iter().map(|r| vec![0; r.len() + 1]).collect();
  let mut loops: Vec<Vec<(u32, usize)>> = vec![Vec::new(); w.rings.len()];
  let mut forbid = |c: usize, from: usize, edges: usize, len: usize| {
    let f = &mut forbidden[c];
    if edges >= len {
      f[0] += 1;
      f[len] -= 1;
    } else if from + edges <= len {
      f[from] += 1;
      f[from + edges] -= 1;
    } else {
      f[from] += 1;
      f[len] -= 1;
      f[0] += 1;
      f[from + edges - len] -= 1;
    }
  };
  let mut seen: HashSet<(u32, WalkState)> = HashSet::new();
  for r in (0..n).filter(|&r| painted[r]) {
    let c = w.cycle[r];
    let (entry, state, borrowed) = if c != u32::MAX {
      (r as u32, WalkState::START, true)
    } else {
      match w.tail(r as u32, WalkState::START).ok()? {
        Tail::Ends => continue,
        Tail::Enters(e, s) => {
          if !seen.insert((e, s)) {
            continue;
          }
          (e, s, false)
        }
      }
    };
    let c = w.cycle[entry as usize] as usize;
    let from = w.pos[entry as usize] as usize;
    let lap = w.lap(c as u32, from as u32, state, borrowed).ok()?;
    let len = w.rings[c].len();
    if lap.ends {
      forbid(c, from, lap.last, len);
    } else {
      loops[c].push((entry, lap.last));
    }
  }
  let mut cuts = Vec::new();
  for (c, entries) in loops.iter_mut().enumerate() {
    if entries.is_empty() {
      continue;
    }
    let len = w.rings[c].len();
    let mut blocked = vec![false; len];
    let mut run = 0i64;
    for (k, b) in blocked.iter_mut().enumerate() {
      run += forbidden[c][k];
      *b = run > 0;
    }
    // In document order; one entry each, with its latest change.
    entries.sort_unstable();
    entries.dedup_by(|a, b| {
      if a.0 == b.0 {
        b.1 = b.1.max(a.1);
        true
      } else {
        false
      }
    });
    w.spend((entries.len() * entries.len().min(64)) as u64)
      .ok()?;
    let pos = |p: u32| w.pos[p as usize] as usize;
    // The cut at edge `j` keeps a walk's result (Blink's) when the walk has
    // seen all it changes on before the edge.
    let kept = |j: usize| {
      entries
        .iter()
        .filter(|(e, last)| (j + len - pos(*e)) % len >= *last)
        .count()
    };
    let closing = |e: u32| (pos(e) + len - 1) % len;
    let mut best: Option<(usize, usize)> = None;
    for &(e, _) in entries.iter().take(64) {
      let j = closing(e);
      if blocked[j] {
        continue;
      }
      let score = kept(j);
      if best.is_none_or(|(_, s)| score > s) {
        best = Some((j, score));
      }
    }
    let first = closing(entries[0].0);
    let j = match best {
      Some((j, _)) => j,
      // Latest edge before the first entry comes back that no ending walk
      // needs; else the first entry's (no hang wins).
      None => (0..len)
        .map(|d| (first + len - d) % len)
        .find(|&j| !blocked[j])
        .unwrap_or(first),
    };
    cuts.push(w.rings[c][j] as usize);
  }
  Some(cuts)
}

/// The patterns whose href closes a cycle a walk from a `painted` pattern
/// outside it runs into: at each such cycle, the one before its first
/// entry (in document order). Used when the walks are too long to run.
fn cycle_breaks(next: &[Option<u32>], painted: &[bool]) -> Vec<usize> {
  let w = Walks::new(next, &[], &[]);
  let mut entry = vec![u32::MAX; w.rings.len()];
  let mut walked = vec![false; next.len()];
  for s in (0..next.len()).filter(|&s| painted[s]) {
    let mut p = s;
    while w.cycle[p] == u32::MAX && !walked[p] {
      walked[p] = true;
      let Some(q) = next[p] else {
        break;
      };
      if w.cycle[q as usize] != u32::MAX {
        let e = &mut entry[w.cycle[q as usize] as usize];
        *e = (*e).min(q);
      }
      p = q as usize;
    }
  }
  entry
    .into_iter()
    .enumerate()
    .filter(|&(_, e)| e != u32::MAX)
    .map(|(c, e)| {
      let ring = &w.rings[c];
      ring[(w.pos[e as usize] as usize + ring.len() - 1) % ring.len()] as usize
    })
    .collect()
}

/// How a reference is written: an element child, a value that is an IRI
/// (`#id` first), a `clip-path`, `mask` or `filter` attribute (SkSVG reads
/// it once per call of its element and does not inherit it), or anything
/// else with `#id` in it (`url(#id)`, a paint some descendant may inherit).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Ek {
  Tree,
  Bare,
  Once,
  Url,
}

impl Ek {
  /// Stack depth, in `<use>` levels (a url() may be a pattern's content).
  fn weight(self) -> u64 {
    match self {
      Ek::Tree | Ek::Bare => 1,
      Ek::Once | Ek::Url => 8,
    }
  }
}

/// Every reference any attribute of any element may make, whatever SkSVG
/// makes of the value: each `#` starts an id that runs to a `)`, a `;` or
/// the end, trailing whitespace (and bytes from 0x80, which a signed char
/// trims) dropped or not. Elements are numbered in document order.
struct Scan {
  dense: Vec<u32>,
  nodes: Vec<NodeId>,
  /// Per element: (attribute, element named, how).
  refs: Vec<Vec<(u32, u32, Ek)>>,
  /// The scan ran out of SCAN_LIMIT or EDGE_LIMIT: references not known.
  unknown: bool,
}

impl Scan {
  fn new(doc: &Doc) -> Scan {
    let mut dense = vec![u32::MAX; doc.nodes.len()];
    let mut nodes = Vec::new();
    for (id, n) in doc.nodes.iter().enumerate() {
      if matches!(n.data, NodeData::Element { .. }) {
        dense[id] = nodes.len() as u32;
        nodes.push(id);
      }
    }
    let mut ids: HashMap<&[u8], Vec<u32>> = HashMap::new();
    for (k, &id) in nodes.iter().enumerate() {
      for a in doc.attrs(id).iter().filter(|a| a.name == "id") {
        ids.entry(a.value.as_bytes()).or_default().push(k as u32);
      }
    }
    let longest = ids.keys().map(|k| k.len()).max().unwrap_or(0);
    let mut refs = vec![Vec::new(); nodes.len()];
    let mut spent = 0u64;
    let mut edges = 0usize;
    let mut unknown = false;
    'scan: for (k, &id) in nodes.iter().enumerate() {
      for (ai, a) in doc.attrs(id).iter().enumerate() {
        let v = a.value.as_bytes();
        let first = v.iter().position(|&c| !is_ws(c));
        for p in (0..v.len()).filter(|&p| v[p] == b'#') {
          let rest = &v[p + 1..];
          let close = rest.iter().position(|&c| c == b')').unwrap_or(rest.len());
          let semi = rest[..close]
            .iter()
            .position(|&c| c == b';')
            .unwrap_or(close);
          spent += close as u64 + 1;
          if spent > SCAN_LIMIT {
            unknown = true;
            break 'scan;
          }
          let ek = if Some(p) == first && a.name != "style" {
            Ek::Bare
          } else if a.ns == dom::Ns::None
            && matches!(a.name.as_str(), "clip-path" | "mask" | "filter")
          {
            Ek::Once
          } else {
            Ek::Url
          };
          let mut cands: Vec<&[u8]> = Vec::with_capacity(6);
          for c in [&rest[..close], &rest[..semi]] {
            let ascii = c.len() - c.iter().rev().take_while(|&&b| b <= b' ').count();
            let signed = c.len()
              - c
                .iter()
                .rev()
                .take_while(|&&b| b <= b' ' || b >= 0x80)
                .count();
            for cand in [c, &c[..ascii], &c[..signed]] {
              if !cand.is_empty() && cand.len() <= longest && !cands.contains(&cand) {
                cands.push(cand);
              }
            }
          }
          for cand in cands {
            spent += cand.len() as u64;
            for &t in ids.get(cand).map_or(&[][..], Vec::as_slice) {
              refs[k].push((ai as u32, t, ek));
              edges += 1;
            }
          }
          if edges > EDGE_LIMIT {
            unknown = true;
            break 'scan;
          }
        }
      }
    }
    Scan {
      dense,
      nodes,
      refs,
      unknown,
    }
  }
}

/// What an element may do in SkSVG, by local name (an element SkSVG does
/// not build is never drawn, whatever this says).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Class {
  /// svg, g, a: drawing it draws its children (each its own OBB scope).
  Container,
  /// defs, pattern, gradients: drawing it draws nothing below it
  /// (SkSVGHiddenContainer).
  Hidden,
  /// Drawing it draws its href target.
  Use,
  /// text, tspan, textPath: shaped, also for a bounding box.
  Text,
  /// mask, clipPath, filter, fe*, gradients: a call may ask for the
  /// bounding box of the element being drawn.
  Obb,
  Other,
}

fn class(name: &str) -> Class {
  match name {
    "svg" | "g" | "a" => Class::Container,
    "use" => Class::Use,
    "text" | "tspan" | "textPath" => Class::Text,
    "defs" | "pattern" => Class::Hidden,
    "mask" | "clipPath" | "filter" | "linearGradient" | "radialGradient" => Class::Obb,
    n if n.starts_with("fe") => Class::Obb,
    _ => Class::Other,
  }
}

/// An over-approximation of SkSVG's calls on a document: every element,
/// with an edge to each child and to each element a reference in `Scan`
/// names, followed in every way SkSVG follows any.
///
/// A call on an element is a draw (R, the element is the scope whose
/// bounding box OBB calls ask for), another call with the caller's scope
/// (N: an outline, a paint, a clip path, a mask, a filter, text shaping),
/// or a bounding box (B). A draw of a container draws its children and a
/// draw of `<use>` its target; every other call is N; a bounding box asks
/// for the children's and the references' (a text element's is a shaping,
/// N). A url() reference is followed once per call and once more for each
/// fill and stroke of each element and text below (inherited paints); one
/// in a `clip-path`, `mask` or `filter` attribute once per call. Each call
/// of an Obb element walks the scope's bounding box OBB_CALLS times (a
/// clipPath only when an attribute of it holds `objectBoundingBox`, as
/// clipPathUnits must: its default is userSpaceOnUse, which walks
/// nothing): a draw of S with t such calls in its scope walks S's
/// bounding box t times. A bounding box walk that shapes text which may
/// make such calls (or inherit a url() paint) asks for the box again,
/// nested at most as deep as there are elements that make them.
/// SkSVG's real calls are a subset (it cuts reference cycles by borrowing
/// the target; this refuses any cycle).
struct Graph {
  root: u32,
  class: Vec<Class>,
  /// The work of one call: 1, and for a shape, text or image 32 more plus
  /// its attribute values (ARC_WORK a byte of path data with an arc, a
  /// style that may declare `d` included), RRECT_WORK more for a rect that
  /// may be rounded; plus
  /// its text (GLYPH_WORK a byte in a text element); for a <path> a
  /// textPath names, the text bytes below each such textPath times the
  /// path's attribute bytes.
  /// CAP for an element that a clipPath, a filter or fe* element, a value
  /// with `dasharray` in it, or a textPath (unless it is a <path> the
  /// textPath names) reaches: SkSVG unions clip content one child at a
  /// time (a `<clipPath>` of 1000 rects took 6 s) and so does a textPath's
  /// outline of a container (asPath: 1000 rects took 4.8 s), a filter
  /// works per pixel (feTurbulence on 4000x4000), and a dash count follows
  /// the geometry (`stroke-dasharray="0.01"` on a circle wrote 1.6 MB), so
  /// none of these may be added.
  own: Vec<u64>,
  /// Text children: each one more fill and stroke.
  texts: Vec<u64>,
  /// pattern, gradients, clipPath: what a url() reaches below them inherits
  /// no paint (a pattern's content is drawn with a fresh presentation
  /// context, SkSVGRenderContext::commonPaint; the rest paint nothing).
  fresh: Vec<bool>,
  /// The bounding box walks one call makes (0 or OBB_CALLS).
  obb: Vec<u64>,
  out: Vec<Vec<(u32, Ek, bool)>>,
  /// Topological order from the root.
  order: Vec<u32>,
}

/// A call through an edge from a draw.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Call {
  Draw,
  Other,
  None,
}

/// What the bound found: the work of calls through a renamed reference,
/// their stack depth, and the whole document's.
#[derive(Debug, Default)]
struct Bound {
  added_work: u64,
  added_depth: u64,
  work: u64,
  depth: u64,
}

impl Graph {
  /// The graph of the document with the `blanked` attributes gone; the
  /// references of the `renamed` ones are marked new. None when it has a
  /// cycle.
  fn new(
    doc: &Doc,
    scan: &Scan,
    blanked: &HashSet<usize>,
    renamed: &HashSet<usize>,
  ) -> Option<Graph> {
    let n = scan.nodes.len();
    let mut class_of = Vec::with_capacity(n);
    let mut own = Vec::with_capacity(n);
    let mut texts = Vec::with_capacity(n);
    let mut fresh = Vec::with_capacity(n);
    let mut obb = Vec::with_capacity(n);
    let mut costly = Vec::with_capacity(n);
    let mut out = Vec::with_capacity(n);
    // The text bytes below each node (its own included), and each
    // element's attribute value bytes. Children come after their parent.
    let mut below = vec![0u64; doc.nodes.len()];
    for id in (0..doc.nodes.len()).rev() {
      if let NodeData::Text(s) = &doc.nodes[id].data {
        below[id] = add(below[id], s.len() as u64);
      }
      if let Some(p) = doc.nodes[id].parent {
        below[p] = add(below[p], below[id]);
      }
    }
    let attr_bytes = |id: NodeId| {
      doc
        .attrs(id)
        .iter()
        .fold(0u64, |s, a| add(s, a.value.len() as u64))
    };
    // Elements a textPath outlines (a reference of it whose value is an
    // IRI) that are not a <path>.
    let mut outlined = Vec::new();
    // <path> elements a textPath names, with the glyph walks of one call.
    let mut contours = Vec::new();
    for (k, &id) in scan.nodes.iter().enumerate() {
      let NodeData::Element { name, attrs, .. } = &doc.nodes[id].data else {
        unreachable!()
      };
      let c = class(name);
      let user_space_clip =
        name == "clipPath" && !attrs.iter().any(|a| a.value.contains("objectBoundingBox"));
      obb.push(if c == Class::Obb && !user_space_clip {
        OBB_CALLS
      } else {
        0
      });
      let drawn = matches!(
        name.as_str(),
        "rect" | "circle" | "ellipse" | "line" | "path" | "polygon" | "polyline" | "image"
      ) || c == Class::Text;
      let mut w = 1 + if drawn { 32 } else { 0 };
      let mut t = 0;
      let mut edges = Vec::new();
      for &ch in &doc.nodes[id].children {
        match &doc.nodes[ch].data {
          NodeData::Text(s) => {
            t += 1;
            let per = if c == Class::Text { GLYPH_WORK } else { 1 };
            w = add(w, mul(per, s.len() as u64));
          }
          NodeData::Element { .. } => edges.push((scan.dense[ch], Ek::Tree, false)),
        }
      }
      // A shape's path data, an image's data: URL (decoded per draw).
      // SkSVG reads `d` from the attribute and from a style declaration
      // (also a nested `style:d:`): a style that may declare `d` counts as
      // path data.
      if drawn {
        for a in attrs {
          let data = a.name == "d" || (a.name == "style" && may_declare_d(&a.value));
          let arc = data && a.value.bytes().any(|c| c | 0x20 == b'a');
          let per = if arc { ARC_WORK } else { 1 };
          w = add(w, mul(per, a.value.len() as u64));
        }
      }
      // A rect that may be rounded (rx or ry in any attribute, a style
      // included): the SVG canvas writes a rounded rect as path data.
      let rounded = |v: &str| {
        v.as_bytes()
          .windows(2)
          .any(|w| w.eq_ignore_ascii_case(b"rx") || w.eq_ignore_ascii_case(b"ry"))
      };
      if name == "rect" && attrs.iter().any(|a| rounded(&a.name) || rounded(&a.value)) {
        w = add(w, RRECT_WORK);
      }
      for &(ai, target, ek) in &scan.refs[k] {
        // By where the attribute is in the text: an element from an
        // entity shares it with each other use of the entity.
        let key = attrs[ai as usize].range.start;
        if !blanked.contains(&key) {
          edges.push((target, ek, renamed.contains(&key)));
          if name == "textPath" && ek == Ek::Bare {
            let t = scan.nodes[target as usize];
            match &doc.nodes[t].data {
              // Each glyph below looks for its contour from the first
              // one (PathData::getMatrixAt): glyphs times contours, on
              // the path's calls (a call through the href is the new one).
              NodeData::Element { name, .. } if name == "path" => {
                contours.push((target, mul(below[id], attr_bytes(t))));
              }
              _ => outlined.push(target),
            }
          }
        }
      }
      // Any spelling, anywhere: an over-approximation of what SkSVG reads.
      let dash = |v: &str| {
        v.as_bytes()
          .windows(9)
          .any(|w| w.eq_ignore_ascii_case(b"dasharray"))
      };
      costly.push(
        matches!(name.as_str(), "clipPath" | "filter")
          || name.starts_with("fe")
          || attrs.iter().any(|a| dash(&a.name) || dash(&a.value)),
      );
      class_of.push(c);
      fresh.push(matches!(
        name.as_str(),
        "pattern" | "linearGradient" | "radialGradient" | "clipPath"
      ));
      own.push(w);
      texts.push(t);
      out.push(edges);
    }
    for t in outlined {
      costly[t as usize] = true;
    }
    for (t, w) in contours {
      own[t as usize] = add(own[t as usize], w);
    }
    let root = scan.dense[doc.root];
    // Depth first without recursion: a back edge is a cycle.
    let mut color = vec![0u8; n];
    let mut post = Vec::with_capacity(n);
    let mut stack = vec![(root, 0usize)];
    color[root as usize] = 1;
    while let Some(&(x, i)) = stack.last() {
      if let Some(&(y, _, _)) = out[x as usize].get(i) {
        if let Some(top) = stack.last_mut() {
          top.1 += 1;
        }
        match color[y as usize] {
          0 => {
            color[y as usize] = 1;
            stack.push((y, 0));
          }
          1 => return None,
          _ => {}
        }
      } else {
        color[x as usize] = 2;
        post.push(x);
        stack.pop();
      }
    }
    post.reverse();
    // What a costly element reaches is costly: clip content, and what may
    // inherit a dash (followed along every edge).
    for &x in &post {
      if costly[x as usize] {
        for &(y, _, _) in &out[x as usize] {
          costly[y as usize] = true;
        }
      }
    }
    for (w, &c) in own.iter_mut().zip(&costly) {
      if c {
        *w = CAP;
      }
    }
    Some(Graph {
      root,
      class: class_of,
      own,
      texts,
      fresh,
      obb,
      out,
      order: post,
    })
  }

  /// What a draw (R) of `x` makes through an edge.
  fn from_draw(&self, x: usize, ek: Ek) -> Call {
    match (ek, self.class[x]) {
      (Ek::Tree, Class::Container) | (Ek::Bare, Class::Use) => Call::Draw,
      // mask, clipPath, filter and gradients are hidden containers too.
      (Ek::Tree, Class::Hidden | Class::Obb) => Call::None,
      _ => Call::Other,
    }
  }

  /// The calls SkSVG may make.
  fn bound(&self) -> Bound {
    let n = self.out.len();
    let obb = |x: usize| self.obb[x];
    // Whether a url() paint may reach x (its own included).
    let mut url_in = vec![false; n];
    for &x in &self.order {
      let x = x as usize;
      let flag = url_in[x] || self.out[x].iter().any(|e| e.1 == Ek::Url);
      url_in[x] = flag;
      for &(y, _, _) in &self.out[x] {
        url_in[y as usize] |= flag;
      }
    }
    // Bottom up: per call on x, the elements and texts below (u1; u1_new
    // past a new edge), the OBB calls with the caller's scope (t_n; t_new
    // past a new edge), the OBB calls a bounding box walk makes where it
    // shapes text (tb), the OBB calls in the scope of a draw (tr; tr_new),
    // the depth below (h).
    let mut u1 = vec![0u64; n];
    let mut u1_new = vec![0u64; n];
    let mut t_n = vec![0u64; n];
    let mut t_new = vec![0u64; n];
    let mut tb = vec![0u64; n];
    let mut tr = vec![0u64; n];
    let mut tr_new = vec![0u64; n];
    let mut h = vec![0u64; n];
    for &x in self.order.iter().rev() {
      let x = x as usize;
      let mut u = add(1, self.texts[x]);
      let mut un = 0;
      for &(y, ek, new) in &self.out[x] {
        if matches!(ek, Ek::Url | Ek::Once) && self.fresh[y as usize] {
          continue;
        }
        u = add(u, u1[y as usize]);
        un = add(
          un,
          if new {
            u1[y as usize]
          } else {
            u1_new[y as usize]
          },
        );
      }
      u1[x] = u;
      u1_new[x] = un;
      let paints = add(1, mul(2, u));
      let (mut tn, mut tq) = (0, 0);
      let (mut b, mut hh) = (0, 0);
      let (mut r, mut rq) = (0, 0);
      for &(y, ek, new) in &self.out[x] {
        let y = y as usize;
        let m = if ek == Ek::Url { paints } else { 1 };
        // An element an href names is not asked to paint, clip, mask or
        // filter (use draws it, a gradient or pattern reads it, textPath
        // outlines it): no OBB call of its own.
        let calls = add(t_n[y], if ek == Ek::Bare { 0 } else { obb(y) });
        tn = add(tn, mul(m, calls));
        let q = if new { calls } else { t_new[y] };
        tq = add(tq, mul(m, q));
        b = add(b, tb[y]);
        hh = hh.max(add(ek.weight(), h[y]));
        if self.from_draw(x, ek) == Call::Other {
          r = add(r, mul(m, calls));
          rq = add(rq, mul(m, q));
        }
      }
      t_n[x] = tn;
      t_new[x] = tq;
      h[x] = hh;
      tr[x] = r;
      tr_new[x] = rq;
      // A text element in a bounding box walk is shaped: its OBB calls,
      // and those of each fill and stroke a url() paint from above may
      // give, ask for the walk's own box again.
      tb[x] = if self.class[x] == Class::Text {
        add(
          tn,
          if url_in[x] {
            mul(mul(2, u), OBB_CALLS)
          } else {
            0
          },
        )
      } else {
        b
      };
    }
    // Top down: calls per mode (pr_*), those through a new edge (q_*),
    // depth from the root (d).
    let mut pr_r = vec![0u64; n];
    let mut pr_n = vec![0u64; n];
    let mut pr_b = vec![0u64; n];
    let mut q_r = vec![0u64; n];
    let mut q_n = vec![0u64; n];
    let mut q_b = vec![0u64; n];
    let mut d = vec![0u64; n];
    pr_r[self.root as usize] = 1;
    let mut bound = Bound::default();
    let (mut walks, mut trigger_depth, mut new_walk_depth) = (false, 0u64, 0u64);
    // A walk that asks for its own box again recurses: each level's OBB
    // call borrows its element (findNodeById), so a walk nests at most as
    // deep as there are elements that make OBB calls (k), and each walk
    // makes at most tb such calls: tb^0 + ... + tb^(k-1) walks for each
    // walk asked for.
    let k = self.class.iter().filter(|c| **c == Class::Obb).count() as u64;
    let nested = |t: u64| {
      let (mut sum, mut level) = (0u64, 1u64);
      for _ in 0..k.max(1) {
        sum = add(sum, level);
        level = mul(level, t);
        if level == 0 || sum >= CAP {
          break;
        }
      }
      sum
    };
    let mut nested_depth = 0u64;
    for &x in &self.order {
      let x = x as usize;
      if pr_r[x] > 0 && tr[x] > 0 {
        walks = true;
        let f = nested(tb[x]);
        if tb[x] > 0 {
          nested_depth = nested_depth.max(mul(k, add(h[x], 8)));
        }
        pr_b[x] = add(pr_b[x], mul(mul(pr_r[x], tr[x]), f));
        let qw = add(mul(q_r[x], tr[x]), mul(pr_r[x], tr_new[x]));
        if qw > 0 {
          q_b[x] = add(q_b[x], mul(qw, f));
          new_walk_depth = new_walk_depth.max(h[x]);
        }
      }
      if self.class[x] == Class::Text {
        pr_n[x] = add(pr_n[x], pr_b[x]);
        q_n[x] = add(q_n[x], q_b[x]);
        pr_b[x] = 0;
        q_b[x] = 0;
      }
      q_r[x] = q_r[x].min(pr_r[x]);
      q_n[x] = q_n[x].min(pr_n[x]);
      q_b[x] = q_b[x].min(pr_b[x]);
      let calls = add(add(pr_r[x], pr_n[x]), pr_b[x]);
      let new_calls = add(add(q_r[x], q_n[x]), q_b[x]);
      bound.work = add(bound.work, mul(calls, self.own[x]));
      bound.added_work = add(bound.added_work, mul(new_calls, self.own[x]));
      let paints = add(1, mul(2, u1[x]));
      for &(y, ek, new) in &self.out[x] {
        let y = y as usize;
        let (m, m_new) = if ek == Ek::Url {
          (paints, mul(2, u1_new[x]))
        } else {
          (1, 0)
        };
        d[y] = d[y].max(add(d[x], ek.weight()));
        if calls > 0 && ek != Ek::Bare && self.class[y] == Class::Obb {
          trigger_depth = trigger_depth.max(add(d[x], ek.weight()));
        }
        if new && calls > 0 {
          bound.added_depth = bound.added_depth.max(add(add(d[x], ek.weight()), h[y]));
        }
        let through = |p: u64, q: u64| -> u64 {
          if new {
            mul(p, m)
          } else {
            add(mul(q, m), mul(p, m_new))
          }
        };
        let (rr, rq) = (mul(pr_r[x], m), through(pr_r[x], q_r[x]));
        match self.from_draw(x, ek) {
          Call::Draw => {
            pr_r[y] = add(pr_r[y], rr);
            q_r[y] = add(q_r[y], rq);
          }
          Call::Other => {
            pr_n[y] = add(pr_n[y], rr);
            q_n[y] = add(q_n[y], rq);
          }
          Call::None => {}
        }
        pr_n[y] = add(pr_n[y], mul(pr_n[x], m));
        q_n[y] = add(q_n[y], through(pr_n[x], q_n[x]));
        pr_b[y] = add(pr_b[y], pr_b[x]);
        q_b[y] = add(q_b[y], if new { pr_b[x] } else { q_b[x] });
      }
    }
    let obb_depth = if walks {
      add(add(trigger_depth, 8), nested_depth)
    } else {
      0
    };
    bound.depth = add(h[self.root as usize], obb_depth);
    if bound.added_depth > 0 {
      bound.added_depth = add(bound.added_depth, obb_depth);
    }
    if new_walk_depth > 0 {
      // A walk a new call asks for: that call's chain, then the walk.
      let chain = bound.added_depth.max(1);
      bound.added_depth = bound.added_depth.max(add(add(chain, 8), new_walk_depth));
    }
    bound
  }
}

/// A byte edit: blank (spaces) or, with `rename`, `xlink:href`.
#[derive(Clone, PartialEq, Eq, Debug)]
struct Edit {
  range: Range<usize>,
  rename: bool,
}

impl Sk<'_> {
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

  /// The attributes `variant` blanks (`cut` patterns' href; in variant 1
  /// also an `xlink:href` svg_doc does not read) and renames, by where
  /// they start in the text.
  fn changes(&self, doc: &Doc, variant: usize, cut: &[bool]) -> (HashSet<usize>, HashSet<usize>) {
    let (mut blanked, mut renamed) = (HashSet::new(), HashSet::new());
    let at = |e: &SkEl, k: usize| doc.attrs(e.node)[k].range.start;
    for (i, e) in self.els.iter().enumerate() {
      if let Some(k) = self.read_href(i, variant) {
        if cut[i] {
          blanked.insert(at(e, k));
        } else if variant == 1 && e.xlink != Some(k) {
          renamed.insert(at(e, k));
        }
      }
      if variant == 1
        && let Some(k) = e.xlink
        && e.chosen != Some(k)
      {
        blanked.insert(at(e, k));
      }
    }
    (blanked, renamed)
  }

  /// The edits of the href attributes in `variant`.
  fn href_edits(&self, variant: usize, cut: &[bool], doc: &Doc) -> Option<Vec<Edit>> {
    let mut edits = Vec::new();
    for (i, e) in self.els.iter().enumerate() {
      if let Some(k) = self.read_href(i, variant) {
        if cut[i] {
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

  /// The patterns (by element) whose href `variant` blanks: see
  /// `walk_cuts`. A pattern counts as painted when any reference in `scan`
  /// may name it (all of them when the scan is not complete).
  fn cuts(&self, doc: &Doc, scan: &Scan, variant: usize) -> Vec<bool> {
    let (pats, next) = self.pattern_graph(doc, variant);
    let mut painted = vec![scan.unknown; pats.len()];
    if !scan.unknown {
      let at: HashMap<NodeId, usize> = pats
        .iter()
        .enumerate()
        .map(|(k, &i)| (self.els[i as usize].node, k))
        .collect();
      // A paint is a url(), in any attribute: never a value's first `#`.
      for refs in &scan.refs {
        for &(_, t, _) in refs.iter().filter(|r| matches!(r.2, Ek::Url | Ek::Once)) {
          if let Some(&k) = at.get(&scan.nodes[t as usize]) {
            painted[k] = true;
          }
        }
      }
    }
    let sets: Vec<u8> = pats.iter().map(|&i| self.els[i as usize].sets).collect();
    let kids: Vec<bool> = pats.iter().map(|&i| self.els[i as usize].kids).collect();
    let picked =
      walk_cuts(&next, &sets, &kids, &painted).unwrap_or_else(|| cycle_breaks(&next, &painted));
    let mut cut = vec![false; self.els.len()];
    for p in picked {
      cut[pats[p] as usize] = true;
    }
    cut
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
  let sk = Sk::read(doc, text);
  let scan = Scan::new(doc);
  let attl = attlists(text, doc.nodes[doc.root].start);
  // Blanking an ATTLIST may make SkSVG draw content it skipped.
  let hides = !attl.is_empty();
  // Whether SkSVG's added work and depth stay within the limits: what the
  // renames add (`renames`), and the whole document when an ATTLIST goes.
  let bounded = |variant: usize, cut: &[bool], renames: bool| {
    if scan.unknown {
      return false;
    }
    let (blanked, renamed) = sk.changes(doc, variant, cut);
    Graph::new(doc, &scan, &blanked, &renamed)
      .map(|g| g.bound())
      .is_some_and(|b| {
        (!renames || b.added_work <= WORK_LIMIT && b.added_depth <= DEPTH_LIMIT)
          && (!hides || b.work <= WORK_LIMIT && b.depth <= DEPTH_LIMIT)
      })
  };
  let mut edits = None;
  if !scan.unknown && sk.els.iter().any(|e| e.chosen != e.xlink) {
    let cut = sk.cuts(doc, &scan, 1);
    if bounded(1, &cut, true) {
      edits = sk.href_edits(1, &cut, doc);
    }
  }
  let mut edits = match edits {
    Some(edits) => edits,
    None => {
      let cut = sk.cuts(doc, &scan, 0);
      if hides && !bounded(0, &cut, false) {
        // Left as it is: SkSVG applies the defaults, as on main.
        return Ok(None);
      }
      sk.href_edits(0, &cut, doc).ok_or(())?
    }
  };
  edits.extend(attl);
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

  /// The `<g>` elements of a fan-out of `fan`^`levels` through `<use
  /// href>`, `<p>0` to `<p><levels>`.
  fn fan_defs(fan: usize, levels: usize, p: &str) -> String {
    let mut s = format!(r#"<defs><g id="{p}0"/>"#);
    for i in 1..=levels {
      s += &format!(r#"<g id="{p}{i}">"#);
      s += &format!(r##"<use href="#{p}{}"/>"##, i - 1).repeat(fan);
      s += "</g>";
    }
    s + "</defs>"
  }

  /// A fan-out, drawn once.
  fn fan_out(fan: usize, levels: usize) -> String {
    fan_defs(fan, levels, "l") + &format!(r##"<use href="#l{levels}"/>"##)
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
    let body = r##"<pattern id="c" xlink:href="#a"/><pattern id="a" xlink:href="#b"/><pattern id="b" xlink:href="#a"/><rect fill="url(#c)"/>"##;
    assert_eq!(
      cleaned(body),
      blanked(body, r#"id="b""#, r##"xlink:href="#a""##)
    );
    // c -> a -> a, c named in a style="" declaration a later one replaces.
    let body = r##"<pattern id="c" xlink:href="#a"/><pattern id="a" xlink:href="#a"/><rect style="stroke:url(#c);stroke:none"/>"##;
    assert_eq!(
      cleaned(body),
      blanked(body, r#"id="a""#, r##"xlink:href="#a""##)
    );
    // Two ways in: the cycle closes at the first entry in document order.
    let body = r##"<pattern id="t" xlink:href="#b"/><pattern id="u" xlink:href="#a"/><pattern id="a" xlink:href="#b"/><pattern id="b" xlink:href="#a"/><rect fill="url(#t)" stroke="url(#u)"/>"##;
    assert_eq!(
      cleaned(body),
      blanked(body, r#"id="b""#, r##"xlink:href="#a""##)
    );
    // Named in a nested style="style:..." declaration (SkSVG reads it).
    let body = r##"<pattern id="c" xlink:href="#a"/><pattern id="a" xlink:href="#a"/><rect style="style:fill:url(#c)"/>"##;
    assert_eq!(
      cleaned(body),
      blanked(body, r#"id="a""#, r##"xlink:href="#a""##)
    );
  }

  #[test]
  fn a_cycle_no_walk_goes_round_for_ever_is_kept() {
    // SkSVG stops at the painted pattern, which is in the cycle.
    let body = r##"<pattern id="a" xlink:href="#b"/><pattern id="b" xlink:href="#a"/><rect width="5" height="5" fill="url(#a)"/>"##;
    assert_eq!(cleaned(body), body);
    // c, which runs into the cycle, is not painted. b, painted, keeps a's
    // size.
    let body = r##"<pattern id="c" xlink:href="#a"/><pattern id="a" width="4" height="4" xlink:href="#b"/><pattern id="b" xlink:href="#a"><rect/></pattern><rect fill="url(#b)"/>"##;
    assert_eq!(cleaned(body), body);
    // Gradients and <use> stop at the borrowed element.
    let body = r##"<linearGradient id="c" xlink:href="#a"/><linearGradient id="a" xlink:href="#a"/><use id="u" xlink:href="#u"/>"##;
    assert_eq!(cleaned(body), body);
    // resolveHref stops once all five attributes and the content are
    // found: c has them, so its walk ends at a (Codex round 2, #3); b, also
    // painted, keeps a's size.
    let body = r##"<pattern id="c" x="0" y="0" width="4" height="4" patternTransform="translate(0)" xlink:href="#a"><rect/></pattern><pattern id="a" width="4" height="4" xlink:href="#b"/><pattern id="b" xlink:href="#a"><rect/></pattern><rect fill="url(#c)"/><rect fill="url(#b) blue"/>"##;
    assert_eq!(cleaned(body), body);
    // The same set in style="", nested or not, and through whitespace
    // content (a text child is a child to SkSVG).
    let body = r##"<pattern id="c" style="x:0;style:y:0;width:4px;height:4 ;patternTransform:rotate(1, 2 3)" xlink:href="#a"> </pattern><pattern id="a" xlink:href="#a"/><rect fill="url(#c)"/>"##;
    assert_eq!(cleaned(body), body);
    // patternTransform SkSVG does not parse (", " between functions):
    // the walk goes on into a -> a.
    let body = r##"<pattern id="c" x="0" y="0" width="4" height="4" patternTransform="scale(2) , rotate(1)" xlink:href="#a"><rect/></pattern><pattern id="a" xlink:href="#a"/><rect fill="url(#c)"/>"##;
    assert_eq!(
      cleaned(body),
      blanked(body, r#"id="a""#, r##"xlink:href="#a""##)
    );
  }

  #[test]
  fn a_cut_leaves_the_href_a_walk_that_ends_needs() {
    // A -> X -> B -> Y -> A. l walks in at A and goes round for ever (no
    // attributes); t, with all five attributes, walks in at B and ends at
    // A's content, through Y's href. A cut at Y (where l's walk comes back)
    // would change t's tile: X's href is cut, which l's walk sees the same
    // way (X, B, Y add nothing).
    let body = r##"<pattern id="l" xlink:href="#A"/><pattern id="t" x="0" y="0" width="4" height="4" patternTransform="scale(1)" xlink:href="#B"/><pattern id="A" xlink:href="#X"><rect/></pattern><pattern id="X" xlink:href="#B"/><pattern id="B" xlink:href="#Y"/><pattern id="Y" xlink:href="#A"/><rect fill="url(#l)" stroke="url(#t)"/>"##;
    assert_eq!(
      cleaned(body),
      blanked(body, r#"id="X""#, r##"xlink:href="#B""##)
    );
  }

  #[test]
  fn pattern_attributes_are_set_only_where_sksvg_surely_sets_them() {
    for v in [
      "0", " 4", "4px", "4 junk", "4,", "1e1", ".5em", "+4%", "4in;",
    ] {
      assert!(sure_length(v), "{v}");
    }
    for v in ["", "x", "4junk", "0x4", "inf", "nan", "-", "é4"] {
      assert!(!sure_length(v), "{v}");
    }
    for v in [
      "translate(0)",
      " rotate( 1 , 2 3 ) ",
      "matrix(1 0 0 1 0 0) scale(2)",
      "scale(1,)",
      "translate(1, )",
      "skewX(1)skewY(2)",
    ] {
      assert!(sure_transform(v), "{v}");
    }
    for v in [
      "",
      "rotate(1, 2)",
      "scale(2) , rotate(1)",
      "translate(0x1)",
      "foo(1)",
      "scale(1) x",
    ] {
      assert!(!sure_transform(v), "{v}");
    }
    let mut seen = Vec::new();
    style_decls(" a : 1 ;style: b:2; c :3; ;d:4", &mut |n, v| {
      seen.push(format!("{n}={v}"))
    });
    seen.sort();
    assert_eq!(seen, ["a=1", "b=2", "c=3"]);
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
    let body = r##"<pattern id="c" href="#a"/><pattern id="a" href="#b"/><pattern id="b" href="#a"/><rect fill="url(#c)"/>"##;
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
    let mut body = fan_defs(8, 5, "l");
    body += r##"<defs><pattern id="p" width="1" height="1"><use href="#l5"/></pattern></defs><g fill="url(#p)">"##;
    body += &r#"<rect width="1" height="1"/>"#.repeat(1 << 12);
    body += "</g>";
    assert_eq!(cleaned(&body), body);
    // A 2000-link gradient chain. SkSVG follows a gradient's href only
    // while it has no <stop>; the bound follows every href, so a chain
    // with stops is not renamed either (over-refused).
    let mut body = String::from(r#"<defs><linearGradient id="g0"><stop/></linearGradient>"#);
    for i in 1..2000 {
      body += &format!(
        r##"<linearGradient id="g{i}" href="#g{}"><g/></linearGradient>"##,
        i - 1
      );
    }
    body += r##"</defs><rect fill="url(#g1999)"/>"##;
    assert_eq!(cleaned(&body), body);
    let body = body.replace("<g/>", "<stop/>");
    assert_eq!(cleaned(&body), body);
    // A reference cycle: not renamed.
    let body = r##"<g id="g"><rect width="2" height="2"/><use href="#g"/></g>"##;
    assert_eq!(cleaned(body), body);
  }

  #[test]
  fn every_reference_sksvg_may_follow_counts() {
    // p and big draw an 8^10 fan-out. Each url(#p) counts, whatever SkSVG
    // makes of the value: one it does not parse, one a later declaration
    // replaces, a nested style="style:...".
    let defs = fan_defs(8, 10, "m")
      + r##"<defs><pattern id="p" width="1" height="1"><use href="#m10"/></pattern><clipPath id="big"><use href="#m10"/></clipPath><clipPath id="small"><rect/></clipPath></defs>"##;
    let tail = r##"<rect id="r"/><use href="#r"/>"##;
    for rect in [
      r#"fill="url(#p)" style="fill:#invalid""#,
      r#"fill="url(#p)" style="fill:url(#q) junk""#,
      r#"clip-path="url(#big)" style="clip-path:url(#small) x""#,
      r#"fill="url(#p)" style="fill:red""#,
      r#"style="style:fill:url(#p)""#,
      r#"style="style:style:clip-path:url(#big)""#,
      r#"data-x="url(#p)""#,
    ] {
      let body = format!("{defs}<rect width=\"5\" height=\"5\" {rect}/>{tail}");
      assert_eq!(cleaned(&body), body, "{rect}");
    }
    // Nothing names them: renamed.
    let body = format!("{defs}<rect width=\"5\" height=\"5\"/>{tail}");
    assert!(!cleaned(&body).contains(" href="));
  }

  #[test]
  fn bounding_box_walks_count() {
    // A group with a mask, filter or clip path walks the bounding box of
    // all below it, <defs> too, and follows <use> there (Codex round 2,
    // #1). An 8^10 fan-out in its <defs>: not renamed.
    let filters = r##"<defs><mask id="k"/><filter id="f"/><clipPath id="c" clipPathUnits="objectBoundingBox"/></defs>"##;
    for attr in [
      r#"mask="url(#k)""#,
      r#"filter="url(#f)""#,
      r#"clip-path="url(#c)""#,
    ] {
      let body = format!("{filters}<g {attr}>{}<rect/></g>", fan_defs(8, 10, "m"));
      assert_eq!(cleaned(&body), body, "{attr}");
    }
    // A 50000-link <use href> chain in its <defs>: too deep.
    let mut chain = String::from(r#"<defs><g id="u0"/>"#);
    for i in 1..50000 {
      chain += &format!(r##"<use id="u{i}" href="#u{}"/>"##, i - 1);
    }
    chain += "</defs>";
    let body = format!(r#"{filters}<g mask="url(#k)">{chain}<rect/></g>"#);
    assert_eq!(cleaned(&body), body);
    // Text in such a walk is shaped, and a gradient fill there asks for
    // the box being walked again, nested up to once per mask, filter, clip
    // path and gradient: an 8^6 fan-out the walks follow is too much with
    // the text, renamed without it.
    let fan = fan_defs(8, 6, "m");
    let body = format!(
      r##"{filters}{fan}<linearGradient id="lg"/><g mask="url(#k)"><text fill="url(#lg)">x</text><use href="#m6"/></g>"##
    );
    assert_eq!(cleaned(&body), body);
    let body = format!(r##"{filters}{fan}<g mask="url(#k)"><use href="#m6"/></g>"##);
    assert!(!cleaned(&body).contains(" href="));
    // A gradient on text outside such a group: its box is the text's, and
    // the gradient is borrowed while it asks. Renamed.
    let body = format!(
      r##"{filters}<linearGradient id="lg"/><text fill="url(#lg)">x</text><rect id="r"/><use href="#r"/>"##
    );
    assert!(!cleaned(&body).contains(" href="));
    // Without one, a small <use href> is renamed.
    let body = format!(r##"{filters}<g mask="url(#k)"><rect id="r"/><use href="#r"/></g>"##);
    assert!(!cleaned(&body).contains(" href="));
  }

  #[test]
  fn a_clip_path_mask_or_filter_counts_once_per_call() {
    // A plot: 2000 <use href> markers in a group with a clip path, a mask
    // or a filter. Each is read once per draw of the group, not once per
    // marker as an inherited paint. Renamed.
    let defs = r##"<defs><clipPath id="c"><rect width="9" height="9"/></clipPath><mask id="k"/><filter id="f"/><circle id="dot" r="1"/></defs>"##;
    let dots = r##"<use href="#dot"/>"##.repeat(2000);
    for attr in [
      r#"clip-path="url(#c)""#,
      r#"mask="url(#k)""#,
      r#"filter="url(#f)""#,
    ] {
      let body = format!("{defs}<g {attr}>{dots}</g>");
      assert!(!cleaned(&body).contains(" href="), "{attr}");
    }
    // A clipPath with clipPathUnits="userSpaceOnUse" (the default) walks
    // no bounding box: an 8^10 fan-out in the group's <defs> stays unread
    // by SkSVG, so the renames are made.
    let body = format!(
      r##"<defs><clipPath id="u" clipPathUnits="userSpaceOnUse"/></defs><g clip-path="url(#u)">{}<rect/></g>"##,
      fan_defs(8, 10, "m")
    );
    assert!(!cleaned(&body).contains(" href="));
    // The same url() as a fill counts per marker: not renamed.
    let body = format!(
      r##"{defs}<pattern id="p" width="1" height="1">{}<use href="#m4"/></pattern><g fill="url(#p)">{dots}</g>"##,
      fan_defs(8, 4, "m")
    );
    assert_eq!(cleaned(&body), body);
  }

  #[test]
  fn a_draw_its_bytes_do_not_bound_is_not_added() {
    let renamed = |body: &str| !cleaned(body).contains(" href=");
    // Text: 8^3 draws of 100 "W" through <use href> are too much, one is
    // not.
    let text = format!(r#"<text id="w">{}</text>"#, "W".repeat(100));
    let fan = fan_defs(8, 3, "t").replace(r#"<g id="t0"/>"#, &format!(r#"<g id="t0">{text}</g>"#));
    assert!(!renamed(&format!(r##"{fan}<use href="#t3"/>"##)));
    assert!(renamed(&format!(
      r##"<defs>{text}</defs><use href="#w"/>"##
    )));
    // A dashed stroke, set on the shape, on the <use> or in a style.
    for body in [
      r##"<circle id="c" r="50" stroke="black" stroke-dasharray="0.01"/><use href="#c"/>"##,
      r##"<circle id="c" r="50" stroke="black"/><use href="#c" stroke-dasharray="0.01"/>"##,
      r##"<circle id="c" r="50" stroke="black"/><g style="stroke-DashArray:0.01"><use href="#c"/></g>"##,
    ] {
      assert!(!renamed(body), "{body}");
    }
    assert!(renamed(
      r##"<circle id="c" r="50" stroke="black"/><use href="#c"/><line stroke-dasharray="1"/>"##
    ));
    // Clip content, and a clipPath called more (Independent check of
    // 4adc2c9c: 4000 rects through <use href> in a clipPath took over
    // 20 s).
    let rects = r#"<rect width="1" height="1"/>"#.repeat(4000);
    for body in [
      format!(
        r##"<defs><g id="m">{rects}</g><clipPath id="k"><use href="#m"/></clipPath></defs><rect width="9" height="9" clip-path="url(#k)"/>"##
      ),
      r##"<defs><clipPath id="k"><rect width="1" height="1"/></clipPath></defs><rect id="r" width="9" height="9" clip-path="url(#k)"/><use href="#r"/>"##.to_owned(),
    ] {
      assert!(!renamed(&body), "{body}");
    }
  }

  #[test]
  fn a_textpath_outline_of_anything_but_a_path_is_not_added() {
    let renamed = |body: &str| !cleaned(body).contains(" href=");
    // SkSVG outlines a textPath's target (asPath); a container unions its
    // children one at a time (Codex cleanup round 4: 2500 rects through a
    // renamed <use href> timed out).
    let rects = r#"<rect width="1" height="1"/>"#.repeat(100);
    for body in [
      format!(
        r##"<defs><g id="r">{rects}</g><g id="h"><use href="#r"/></g></defs><text><textPath xlink:href="#h">X</textPath></text>"##
      ),
      format!(
        r##"<defs><g id="r">{rects}</g><use id="u" href="#r"/></defs><text><textPath xlink:href="#u">X</textPath></text>"##
      ),
      // A textPath drawn more through a renamed <use href>.
      format!(
        r##"<defs><g id="r">{rects}</g><text id="t"><textPath xlink:href="#r">X</textPath></text></defs><use href="#t"/>"##
      ),
    ] {
      assert!(!renamed(&body), "{body}");
    }
    // A <path> target: renamed, and so is a <use href> of the text.
    assert!(renamed(
      r##"<defs><path id="p" d="M0 5H10"/><text id="t"><textPath xlink:href="#p">X</textPath></text></defs><use href="#t"/>"##
    ));
    // Each glyph walks the contours: 2000 glyphs on 200000 contours are
    // too much, 20 on 2000 are not.
    let tp = |glyphs: usize, contours: usize| {
      format!(
        r##"<defs><path id="p" d="{}"/></defs><text><textPath href="#p">{}</textPath></text>"##,
        "M0 0h1".repeat(contours),
        "W".repeat(glyphs)
      )
    };
    assert!(!renamed(&tp(2000, 200_000)));
    assert!(renamed(&tp(20, 2000)));
    // An ATTLIST goes only where the outlines are bounded (round 4: an
    // ATTLIST hid a textPath outline of 2500 rects).
    let doc = |target: &str| {
      format!(
        r##"<!DOCTYPE svg [<!ATTLIST text display CDATA "none">]><svg {X}><defs>{target}</defs><text><textPath xlink:href="#r">X</textPath></text></svg>"##
      )
    };
    let text = doc(&format!(r#"<g id="r">{rects}</g>"#));
    assert_eq!(clean(&Doc::parse(&text).unwrap(), &text), Ok(None));
    let text = doc(r#"<path id="r" d="M0 5H10"/>"#);
    assert!(clean(&Doc::parse(&text).unwrap(), &text).unwrap().is_some());
  }

  #[test]
  fn a_textpath_href_is_renamed_only_to_a_path() {
    // svg_doc, as Blink, draws a textPath only along a <path>; SkSVG along
    // anything (Codex cleanup round 4).
    let tp = r##"<text><textPath href="#r">X</textPath></text>"##;
    for target in [
      r#"<rect id="r" width="8" height="8"/>"#,
      r#"<g id="r"><path d="M0 5H10"/></g>"#,
      r##"<path id="p" d="M0 5H10"/><use id="r" xlink:href="#p"/>"##,
      // First-wins (svg_doc) and last-wins (SkSVG) differ.
      r#"<g id="r"/><path id="r" d="M0 5H10"/>"#,
    ] {
      let body = format!("<defs>{target}</defs>{tp}");
      assert_eq!(cleaned(&body), body, "{target}");
    }
    let body = format!(r#"<defs><path id="r" d="M0 5H10"/></defs>{tp}"#);
    assert_eq!(cleaned(&body), body.replace(" href=", " xlink:href="));
    // svg_doc reads href (a rect: no text); the xlink:href SkSVG reads goes.
    let body = r##"<defs><rect id="r"/><path id="p" d="M0 5H10"/></defs><text><textPath href="#r" xlink:href="#p">X</textPath></text>"##;
    assert_eq!(
      cleaned(body),
      blanked(body, r##"href="#r""##, r##"xlink:href="#p""##)
    );
  }

  #[test]
  fn filters_and_arcs_are_not_added_past_their_bytes() {
    let renamed = |body: &str| !cleaned(body).contains(" href=");
    // A filter works per pixel, whatever its bytes (feTurbulence on
    // 4000x4000 through 64 <use href> draws timed out).
    for body in [
      r##"<defs><filter id="f"><feTurbulence baseFrequency="0.05"/></filter></defs><rect id="r" filter="url(#f)"/><use href="#r"/>"##,
      r##"<defs><filter id="f"><feImage xlink:href="#r"/></filter></defs><rect id="r"/><rect filter="url(#f)"/><g id="g"/><use href="#g"/><rect id="s"/><use href="#r"/>"##,
    ] {
      assert!(!renamed(body), "{body}");
    }
    assert!(renamed(
      r##"<defs><filter id="f"><feFlood/></filter></defs><rect id="r"/><use href="#r"/><rect filter="url(#f)"/>"##
    ));
    // Arcs: 8^3 draws of 400 are too much; 8^3 of a rounded corner are not.
    let arcs = |n: usize| {
      fan_defs(8, 3, "a").replace(
        r#"<g id="a0"/>"#,
        &format!(
          r#"<g id="a0"><path d="M0 0{}"/></g>"#,
          "A1e6 1e6 0 1 1 1 0".repeat(n)
        ),
      ) + r##"<use href="#a3"/>"##
    };
    assert!(!renamed(&arcs(400)));
    assert!(renamed(&arcs(1)));
    // The same bytes without an arc.
    assert!(renamed(
      &arcs(400).replace("A1e6 1e6 0 1 1 1 0", "L1e6 1e6 0 1 1 1 0")
    ));
  }

  #[test]
  fn rounded_rects_and_style_arcs_are_not_added_past_their_bytes() {
    let renamed = |body: &str| !cleaned(body).contains(" href=");
    let drawn = |leaf: &str, levels: usize| {
      fan_defs(8, levels, "a").replace(r#"<g id="a0"/>"#, &format!(r#"<g id="a0">{leaf}</g>"#))
        + &format!(r##"<use href="#a{levels}"/>"##)
    };
    // The SVG canvas writes a rounded rect as path data (Codex cleanup
    // round 5: 8^6 draws of a 24x24 icon with rx="4" went past 1 GB):
    // 8^4 draws are too much, 8^2 are not; a plain rect is not rounded.
    for leaf in [
      r#"<rect width="24" height="24" rx="4"/>"#,
      r#"<rect width="24" height="24" ry="4"/>"#,
      r#"<rect width="24" height="24" style="rx:4"/>"#,
      r#"<rect width="24" height="24" style="style:RY:4"/>"#,
    ] {
      assert!(!renamed(&drawn(leaf, 4)), "{leaf}");
      assert!(renamed(&drawn(leaf, 2)), "{leaf}");
    }
    assert!(renamed(&drawn(r#"<rect width="24" height="24"/>"#, 4)));
    // SkSVG reads `d` from a style too: arcs there count as in `d`.
    let arc = "M0 0A1e6 1e6 0 1 1 1 0A1e6 1e6 0 1 1 0 0";
    for leaf in [
      format!(r#"<path style="d:{arc}"/>"#),
      format!(r#"<path style="fill:red; d :{arc}"/>"#),
      format!(r#"<path style="style:d:{arc}"/>"#),
      format!("<path style=\"style:d\u{a0}:{arc}\"/>"),
    ] {
      assert!(!renamed(&drawn(&leaf, 4)), "{leaf}");
      assert!(renamed(&drawn(&leaf, 1)), "{leaf}");
    }
    // A style that declares no `d` is not path data.
    assert!(renamed(&drawn(
      r#"<path d="M0 0H1" style="fill:black;stroke:salmon"/>"#,
      4
    )));
    // An ATTLIST goes only where the rounded rects are bounded.
    let doc = |levels: usize| {
      let fan =
        drawn(r#"<rect width="24" height="24" rx="4"/>"#, levels).replace(" href=", " xlink:href=");
      format!(r#"<!DOCTYPE svg [<!ATTLIST rect display CDATA "none">]><svg {X}>{fan}</svg>"#)
    };
    let big = doc(4);
    assert_eq!(clean(&Doc::parse(&big).unwrap(), &big), Ok(None));
    let small = doc(2);
    assert!(
      clean(&Doc::parse(&small).unwrap(), &small)
        .unwrap()
        .is_some()
    );
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
  fn an_attlist_goes_only_when_the_document_is_bounded() {
    // Each default hides an 8^10 fan-out from SkSVG: display, an empty
    // viewBox (SkSVGSVG::onPrepareToRender), a pattern width of 0
    // that stops p from taking q's (SkSVGPattern::onAsPaint) (Codex round
    // 3).
    let fan = fan_out(8, 10).replace(" href=", " xlink:href=");
    let pattern = format!(
      r##"<defs><pattern id="q" width="1" height="1"/><pattern id="p" xlink:href="#q">{fan}</pattern></defs><rect fill="url(#p)"/>"##
    );
    for (decl, small, big) in [
      (
        r#"<!ATTLIST g display CDATA "none">"#,
        r#"<g><rect/></g>"#.to_owned(),
        fan.clone(),
      ),
      (
        r#"<!ATTLIST svg viewBox CDATA "0 0 0 0">"#,
        r#"<svg><rect/></svg>"#.to_owned(),
        format!("<svg>{fan}</svg>"),
      ),
      (
        r#"<!ATTLIST pattern width CDATA "0">"#,
        r##"<pattern id="q" width="1" height="1"/><pattern id="p" xlink:href="#q"><rect/></pattern><rect fill="url(#p)"/>"##.to_owned(),
        pattern,
      ),
    ] {
      let text = |body: &str| format!(r#"<!DOCTYPE svg [{decl}]><svg {X}>{body}</svg>"#);
      let small = text(&small);
      let doc = Doc::parse(&small).unwrap();
      let out = String::from_utf8(clean(&doc, &small).unwrap().unwrap()).unwrap();
      assert_eq!(out, small.replace(decl, &" ".repeat(decl.len())), "{decl}");
      // Left as it is.
      let big = text(&big);
      let doc = Doc::parse(&big).unwrap();
      assert_eq!(clean(&doc, &big), Ok(None), "{decl}");
    }
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
    // Each use of the entity is a pattern with id p: c runs into the
    // second, whose href to itself is the cycle; the first is renamed. Both
    // are one attribute in the text: blanked.
    let text = format!(
      r##"<!DOCTYPE svg [<!ENTITY p '<pattern id="p" href="#p"/>'>]><svg {X}><use href="#r"/><rect id="r"/><pattern id="c" href="#p"/><rect fill="url(#c)"/>&p;&p;</svg>"##
    );
    let doc = Doc::parse(&text).unwrap();
    let out = String::from_utf8(clean(&doc, &text).unwrap().unwrap()).unwrap();
    assert_eq!(
      out,
      text
        .replace(r##"id="p" href="#p""##, r#"id="p"          "#)
        .replace(r##"<use href"##, r##"<use xlink:href"##)
        .replace(r##"id="c" href"##, r##"id="c" xlink:href"##)
    );
  }

  #[test]
  fn walks_go_round_a_cycle_once() {
    // 0 -> 1 -> 2 -> 1, 3 alone; nothing set: 0's walk loops at 1.
    let next = [Some(1), Some(2), Some(1), None];
    let cuts = walk_cuts(&next, &[0; 4], &[false; 4], &[true, false, false, false]);
    assert_eq!(cuts, Some(vec![2]));
    // 2 painted too: it starts in the cycle and stops back at itself.
    let cuts = walk_cuts(&next, &[0; 4], &[false; 4], &[false, false, true, true]);
    assert_eq!(cuts, Some(vec![]));
    // All set and content at 1: 0's walk ends there.
    let cuts = walk_cuts(
      &next,
      &[ALL_SET, 0, 0, 0],
      &[false, true, false, false],
      &[true; 4],
    );
    assert_eq!(cuts, Some(vec![]));
  }
}
