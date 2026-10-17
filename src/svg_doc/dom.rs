//! The XML tree of an SVG image, read with roxmltree (entities, CDATA and
//! namespaces resolved) into an arena the preparer walks.

pub(crate) type NodeId = usize;

pub(crate) const SVG_NS: &str = "http://www.w3.org/2000/svg";
pub(crate) const XLINK_NS: &str = "http://www.w3.org/1999/xlink";
pub(crate) const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";

/// kMaxXMLTreeDepth (xml_document_parser_rs.cc): Chrome 155 fails to load an
/// SVG image whose elements nest deeper than this, the root counting as 1
/// (measured: 5000 loads, 5001 fires onerror).
pub(crate) const MAX_TREE_DEPTH: usize = 5000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Ns {
  Svg,
  Xlink,
  Xml,
  None,
  Other,
}

#[derive(Debug)]
pub(crate) struct Attr {
  pub ns: Ns,
  pub name: String,
  pub value: String,
}

#[derive(Debug)]
pub(crate) enum NodeData {
  Element {
    ns: Ns,
    name: String,
    attrs: Vec<Attr>,
  },
  Text(String),
}

#[derive(Debug)]
pub(crate) struct Node {
  pub data: NodeData,
  pub parent: Option<NodeId>,
  pub children: Vec<NodeId>,
}

pub(crate) struct Doc {
  pub nodes: Vec<Node>,
  pub root: NodeId,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DomError {
  /// Not well-formed XML (or not UTF-8).
  Xml,
  /// The root is not an `svg` element in the SVG namespace.
  NotSvg,
  /// Deeper than MAX_TREE_DEPTH.
  TooDeep,
}

fn map_ns(uri: Option<&str>) -> Ns {
  match uri {
    Some(SVG_NS) => Ns::Svg,
    Some(XLINK_NS) => Ns::Xlink,
    Some(XML_NS) => Ns::Xml,
    None => Ns::None,
    Some(_) => Ns::Other,
  }
}

/// Documents nested deeper than this are parsed on a thread of their own
/// with DEEP_PARSE_STACK of stack. roxmltree takes about 0.65 KiB of stack
/// a level in a release build (opt-level 3) and 17 KiB in an unoptimized
/// build (opt-level 0; measured on arm64 macOS: 5000 levels take 3.2 MiB
/// and 82 MiB, 512 levels 0.32 MiB and 8.2 MiB), so an unoptimized build
/// parses fewer levels on the caller's stack and gives the thread more.
/// The stack use follows the opt-level, not debug assertions, so build.rs
/// sets svg_unoptimized when OPT_LEVEL is 0 (opt-level 1 takes about
/// 1 KiB a level: 5000 levels fit in 16 MiB). MAX_TREE_DEPTH bounds the
/// stack the thread uses.
#[cfg(not(svg_unoptimized))]
const SHALLOW_DEPTH: usize = 512;
#[cfg(not(svg_unoptimized))]
const DEEP_PARSE_STACK: usize = 16 << 20;
#[cfg(svg_unoptimized)]
const SHALLOW_DEPTH: usize = 20;
#[cfg(svg_unoptimized)]
const DEEP_PARSE_STACK: usize = 256 << 20;

/// How deep elements nest in `text`, counting what internal entities may
/// add: an upper bound, so the recursive XML parser is only handed
/// documents it can parse without running off the stack.
fn nesting_bound(text: &str) -> usize {
  let (depth, entities) = scan_markup(text.as_bytes());
  // An entity reference expands at most 10 deep (roxmltree), each level at
  // most as deep as the deepest entity value.
  depth + 10 * entities
}

/// The deepest element nesting of `text`, and of the internal entity
/// values it declares.
fn scan_markup(b: &[u8]) -> (usize, usize) {
  let find = |from: usize, pat: &[u8]| {
    b[from.min(b.len())..]
      .windows(pat.len())
      .position(|w| w == pat)
      .map(|i| from + i + pat.len())
      .unwrap_or(b.len())
  };
  let (mut depth, mut max, mut entities) = (0usize, 0usize, 0usize);
  let mut i = 0;
  while i < b.len() {
    if b[i] != b'<' {
      i += 1;
      continue;
    }
    let rest = &b[i..];
    if rest.starts_with(b"<!--") {
      i = find(i + 4, b"-->");
    } else if rest.starts_with(b"<![CDATA[") {
      i = find(i + 9, b"]]>");
    } else if rest.starts_with(b"<?") {
      i = find(i + 2, b"?>");
    } else if rest.starts_with(b"<!") {
      // A DOCTYPE: its internal subset may declare entities.
      let mut j = i + 2;
      let mut brackets = 0;
      while j < b.len() {
        match b[j] {
          b'[' => brackets += 1,
          b']' => brackets -= 1,
          b'"' | b'\'' => {
            let quote = b[j];
            let end = b[j + 1..]
              .iter()
              .position(|&c| c == quote)
              .map_or(b.len(), |p| j + 1 + p);
            entities = entities.max(scan_markup(&b[(j + 1).min(b.len())..end]).0);
            j = end;
          }
          b'>' if brackets <= 0 => break,
          _ => {}
        }
        j += 1;
      }
      i = j + 1;
    } else if rest.starts_with(b"</") {
      depth = depth.saturating_sub(1);
      i = find(i + 2, b">");
    } else {
      // A start tag: skip quoted attribute values to its end.
      let mut j = i + 1;
      let mut self_closing = false;
      while j < b.len() {
        match b[j] {
          b'"' | b'\'' => {
            let quote = b[j];
            j = b[j + 1..]
              .iter()
              .position(|&c| c == quote)
              .map_or(b.len(), |p| j + 1 + p);
          }
          b'>' => {
            self_closing = b[j - 1] == b'/';
            break;
          }
          _ => {}
        }
        j += 1;
      }
      if !self_closing {
        depth += 1;
        max = max.max(depth);
      }
      i = j + 1;
    }
  }
  (max, entities)
}

impl Doc {
  pub(crate) fn parse(text: &str) -> Result<Doc, DomError> {
    // roxmltree recurses per element: a document Chrome rejects for depth
    // never reaches it.
    let bound = nesting_bound(text);
    if bound > MAX_TREE_DEPTH {
      return Err(DomError::TooDeep);
    }
    if bound > SHALLOW_DEPTH {
      // Measured: 5000 levels overflow a 1 MB stack in roxmltree (the test
      // below without this thread), and the caller's stack may be small.
      return std::thread::scope(|scope| {
        std::thread::Builder::new()
          .stack_size(DEEP_PARSE_STACK)
          .spawn_scoped(scope, || Self::parse_xml(text))
          .map_err(|_| DomError::Xml)?
          .join()
          .unwrap_or(Err(DomError::Xml))
      });
    }
    Self::parse_xml(text)
  }

  fn parse_xml(text: &str) -> Result<Doc, DomError> {
    let options = roxmltree::ParsingOptions {
      allow_dtd: true,
      nodes_limit: u32::MAX,
      entity_resolver: None,
    };
    let xml = roxmltree::Document::parse_with_options(text, options).map_err(|_| DomError::Xml)?;
    let root = xml.root_element();
    if root.tag_name().name() != "svg" || root.tag_name().namespace() != Some(SVG_NS) {
      return Err(DomError::NotSvg);
    }
    let mut doc = Doc {
      nodes: Vec::new(),
      root: 0,
    };
    // Depth first without recursion: (xml node, parent in the arena, depth).
    let mut stack = vec![(root, None, 1usize)];
    while let Some((node, parent, depth)) = stack.pop() {
      // Text does not count (measured: 5000 elements with a text node in
      // the deepest one load).
      if node.is_element() && depth > MAX_TREE_DEPTH {
        return Err(DomError::TooDeep);
      }
      let id = doc.nodes.len();
      let data = if node.is_element() {
        NodeData::Element {
          ns: map_ns(node.tag_name().namespace()),
          name: node.tag_name().name().to_owned(),
          attrs: node
            .attributes()
            .map(|a| Attr {
              ns: map_ns(a.namespace()),
              name: a.name().to_owned(),
              value: a.value().to_owned(),
            })
            .collect(),
        }
      } else {
        NodeData::Text(node.text().unwrap_or("").to_owned())
      };
      doc.nodes.push(Node {
        data,
        parent,
        children: Vec::new(),
      });
      if let Some(parent) = parent {
        doc.nodes[parent].children.push(id);
      }
      if node.is_element() {
        let children: Vec<_> = node
          .children()
          .filter(|c| c.is_element() || c.is_text())
          .collect();
        for child in children.into_iter().rev() {
          stack.push((child, Some(id), depth + 1));
        }
      }
    }
    Ok(doc)
  }

  pub(crate) fn is_element(&self, id: NodeId) -> bool {
    matches!(self.nodes[id].data, NodeData::Element { .. })
  }

  /// The local name of an element in the SVG namespace.
  pub(crate) fn svg_name(&self, id: NodeId) -> Option<&str> {
    match &self.nodes[id].data {
      NodeData::Element {
        ns: Ns::Svg, name, ..
      } => Some(name.as_str()),
      _ => None,
    }
  }

  pub(crate) fn attrs(&self, id: NodeId) -> &[Attr] {
    match &self.nodes[id].data {
      NodeData::Element { attrs, .. } => attrs,
      NodeData::Text(_) => &[],
    }
  }

  /// An attribute in no namespace.
  pub(crate) fn attr(&self, id: NodeId, name: &str) -> Option<&str> {
    self
      .attrs(id)
      .iter()
      .find(|a| a.ns == Ns::None && a.name == name)
      .map(|a| a.value.as_str())
  }

  /// SVGURIReference: `href` wins over `xlink:href`.
  pub(crate) fn href(&self, id: NodeId) -> Option<&str> {
    self.attr(id, "href").or_else(|| {
      self
        .attrs(id)
        .iter()
        .find(|a| a.ns == Ns::Xlink && a.name == "href")
        .map(|a| a.value.as_str())
    })
  }

  pub(crate) fn element_children(&self, id: NodeId) -> impl Iterator<Item = NodeId> + '_ {
    self.nodes[id]
      .children
      .iter()
      .copied()
      .filter(move |c| self.is_element(*c))
  }

  /// The text of every text node below `id`, in order (a `<style>` sheet).
  pub(crate) fn text_content(&self, id: NodeId) -> String {
    let mut out = String::new();
    let mut stack = vec![id];
    while let Some(n) = stack.pop() {
      match &self.nodes[n].data {
        NodeData::Text(t) => out.push_str(t),
        NodeData::Element { .. } => stack.extend(self.nodes[n].children.iter().rev()),
      }
    }
    out
  }

  /// The ancestors of `id`, nearest first.
  pub(crate) fn ancestors(&self, id: NodeId) -> impl Iterator<Item = NodeId> + '_ {
    std::iter::successors(self.nodes[id].parent, move |n| self.nodes[*n].parent)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn nested(depth: usize) -> String {
    format!(
      r#"<svg xmlns="{SVG_NS}">{}<rect/>{}</svg>"#,
      "<g>".repeat(depth - 2),
      "</g>".repeat(depth - 2)
    )
  }

  #[test]
  fn depth_cap_is_chromes() {
    assert!(Doc::parse(&nested(MAX_TREE_DEPTH)).is_ok());
    let text = format!(
      r#"<svg xmlns="{SVG_NS}">{}<text>x</text>{}</svg>"#,
      "<g>".repeat(MAX_TREE_DEPTH - 2),
      "</g>".repeat(MAX_TREE_DEPTH - 2)
    );
    assert!(Doc::parse(&text).is_ok());
    assert_eq!(
      Doc::parse(&nested(MAX_TREE_DEPTH + 1)).err(),
      Some(DomError::TooDeep)
    );
    assert_eq!(Doc::parse(&nested(50_000)).err(), Some(DomError::TooDeep));
  }

  #[test]
  fn deep_documents_parse_on_a_small_stack() {
    // Image decodes run on other threads, whose stacks may be small.
    let parsed = std::thread::Builder::new()
      .stack_size(1 << 20)
      .spawn(|| Doc::parse(&nested(MAX_TREE_DEPTH)).is_ok())
      .unwrap()
      .join()
      .unwrap();
    assert!(parsed);
  }

  #[test]
  fn entity_markup_counts_toward_depth() {
    let deep = "<g>".repeat(600) + &"</g>".repeat(600);
    let text = format!(
      r#"<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY e "{deep}">]><svg xmlns="{SVG_NS}">&e;</svg>"#
    );
    assert_eq!(Doc::parse(&text).err(), Some(DomError::TooDeep));
    let text = format!(
      r#"<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY e "<rect/>">]><svg xmlns="{SVG_NS}">&e;<!-- <g> --></svg>"#
    );
    assert!(Doc::parse(&text).is_ok());
  }

  #[test]
  fn root_must_be_svg_in_the_svg_namespace() {
    assert_eq!(Doc::parse("<svg/>").err(), Some(DomError::NotSvg));
    assert_eq!(
      Doc::parse(&format!(r#"<g xmlns="{SVG_NS}"/>"#)).err(),
      Some(DomError::NotSvg)
    );
    assert_eq!(Doc::parse("<svg").err(), Some(DomError::Xml));
  }

  #[test]
  fn href_beats_xlink_href() {
    let doc = Doc::parse(&format!(
      r##"<svg xmlns="{SVG_NS}" xmlns:xlink="{XLINK_NS}"><use xlink:href="#a" href="#b"/></svg>"##
    ))
    .unwrap();
    let used = doc.element_children(doc.root).next().unwrap();
    assert_eq!(doc.href(used), Some("#b"));
  }
}
