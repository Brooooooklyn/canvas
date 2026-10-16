//! SVG images as Chrome draws them, with Skia's SVG renderer underneath.
//!
//! SkSVGDOM has no CSS cascade, no `var()`, no `<style>`, no quoted
//! `url()`, no Blink rules for `<use>` and `<clipPath>` content, and loads no
//! `<image>`. This module reads the document the way Blink does and writes
//! a plain one SkSVGDOM draws the same:
//!
//! ```text
//!  SVG bytes ─► dom (roxmltree) ─► sheet + cascade ─► build ─► SVG text ─► SkSVGDOM
//!                                                       │
//!                                                       └─► resources: <image> rasters,
//!                                                           nested SVG images, font lists
//! ```
//!
//! `skia-c/svg_image.cpp` draws the resources and the text.

mod build;
mod cascade;
mod dom;
mod props;
mod select;
mod sheet;
mod values;

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::svg_size::{FontUnits, SvgSizing, layout_floor};

pub(crate) use values::Family;

/// Chrome's broken-image icon (Chromium 155
/// third_party/blink/public/default_100_percent/blink/broken_image.png, 1x),
/// drawn for an `<image>` that fails to load. BSD-3-Clause, see LICENSE.
pub(crate) const BROKEN_IMAGE: &[u8] = include_bytes!("broken_image.png");

/// The most elements one SVG image (with every nested SVG image in it) may
/// write. Chrome has no limit and hangs on `<use>` fan-outs past about 10^6
/// elements; past this one the rest of the document is not drawn.
pub(crate) const ELEMENT_BUDGET: usize = 1 << 18;

/// The most pixels of one `<image>` raster; a larger one is not drawn
/// (Chrome draws it).
pub(crate) const MAX_RASTER_PIXELS: u64 = 1 << 25;

/// The most raster pixels one SVG image decodes in all.
pub(crate) const TOTAL_RASTER_PIXELS: u64 = 1 << 26;

/// How deep SVG images nest through `<image>` data URLs. Each level holds
/// the next one's text, so a deeper chain is mostly bytes of data URLs;
/// past this the image draws nothing.
pub(crate) const MAX_NESTING: u32 = 64;

/// An image an `<image>` element draws, in `Prepared::resources`.
pub(crate) enum Resource {
  /// Encoded raster bytes. `quality` is Blink's interpolation quality: 0
  /// none (`pixelated`, `crisp-edges`), 1 low, 2 medium (the default).
  Raster { data: Rc<[u8]>, quality: u8 },
  /// A nested SVG image, prepared, with the root laid out at `root` and
  /// drawn into a `frame` (its rounded size).
  Svg {
    text: String,
    frame: (i32, i32),
    root: (f32, f32),
  },
}

/// What SkSVGDOM gets: the document, the images its `<image>` elements
/// name (`napi-img:K`, `napi-svg:K`), and the font-family lists its
/// `font-family` attributes name (`napi-font:K`).
#[derive(Default)]
pub(crate) struct Prepared {
  pub svg: String,
  pub resources: Vec<Resource>,
  pub families: Vec<Rc<[Family]>>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PrepareError {
  /// Deeper than Chrome's XML parser takes: the image fails to load.
  TooDeep,
  /// Not something this module reads (not UTF-8, not well-formed, not an
  /// SVG root): left to SkSVGDOM as before.
  Unsupported,
}

/// The root attributes that size an SVG image, as written.
#[derive(Default, Clone, Debug)]
pub(crate) struct RootAttributes {
  pub width: Option<String>,
  pub height: Option<String>,
  pub view_box: Option<String>,
  pub preserve_aspect_ratio: Option<String>,
}

impl RootAttributes {
  fn of(doc: &dom::Doc) -> Self {
    let attr = |name| doc.attr(doc.root, name).map(str::to_owned);
    RootAttributes {
      width: attr("width"),
      height: attr("height"),
      view_box: attr("viewBox"),
      preserve_aspect_ratio: attr("preserveAspectRatio"),
    }
  }

  pub(crate) fn sizing(&self, units: &FontUnits) -> SvgSizing {
    SvgSizing::from_attributes(
      self.width.as_deref(),
      self.height.as_deref(),
      self.view_box.as_deref(),
      self.preserve_aspect_ratio.as_deref(),
      units,
    )
  }
}

/// A data: URL an `<image>` loaded.
enum Loaded {
  Raster(Rc<[u8]>, (u32, u32)),
  Svg(Rc<dom::Doc>, SvgSizing),
  Broken,
}

/// A nested SVG image: its URL, frame and root size (as f32 bits).
type NestedKey = (Rc<str>, (i32, i32), (u32, u32));

/// What every document of one SVG image shares: the resources, the work
/// budgets, and what was already loaded, by URL.
pub(crate) struct Shared<'u> {
  prepared: Prepared,
  units: &'u FontUnits,
  elements_left: usize,
  /// Bytes of substituted var() text left (cascade::VAR_TEXT_BUDGET).
  var_budget: Rc<Cell<usize>>,
  raster_pixels: u64,
  loaded: HashMap<Rc<str>, Rc<Loaded>>,
  rasters: HashMap<(Rc<str>, u8), Option<usize>>,
  nested: HashMap<NestedKey, Option<usize>>,
  families: HashMap<Rc<[Family]>, usize>,
  nesting: u32,
}

impl<'u> Shared<'u> {
  fn new(units: &'u FontUnits) -> Self {
    Shared {
      prepared: Prepared::default(),
      units,
      elements_left: ELEMENT_BUDGET,
      var_budget: Rc::new(Cell::new(cascade::VAR_TEXT_BUDGET)),
      raster_pixels: 0,
      loaded: HashMap::new(),
      rasters: HashMap::new(),
      nested: HashMap::new(),
      families: HashMap::new(),
      nesting: 0,
    }
  }

  /// One more element written; false once the budget is spent.
  fn take_element(&mut self) -> bool {
    if self.elements_left == 0 {
      return false;
    }
    self.elements_left -= 1;
    true
  }

  fn family_key(&mut self, families: &Rc<[Family]>) -> usize {
    if let Some(k) = self.families.get(families) {
      return *k;
    }
    let k = self.prepared.families.len();
    self.prepared.families.push(families.clone());
    self.families.insert(families.clone(), k);
    k
  }

  fn load(&mut self, url: &Rc<str>) -> Rc<Loaded> {
    if let Some(l) = self.loaded.get(url) {
      return l.clone();
    }
    let loaded = Rc::new(match crate::data_url::parse(url.as_bytes()) {
      Some(Ok(data)) if data.essence == "image/svg+xml" => std::str::from_utf8(&data.body)
        .ok()
        .and_then(|text| dom::Doc::parse(text).ok())
        .map(|doc| {
          let sizing = RootAttributes::of(&doc).sizing(self.units);
          Loaded::Svg(Rc::new(doc), sizing)
        })
        .unwrap_or(Loaded::Broken),
      Some(Ok(data)) => match crate::sk::encoded_image_size(&data.body) {
        Some(size) => Loaded::Raster(Rc::from(data.body), size),
        None => Loaded::Broken,
      },
      _ => Loaded::Broken,
    });
    self.loaded.insert(url.clone(), loaded.clone());
    loaded
  }

  /// The resource of a raster `<image>`, or None when it is too big to draw.
  fn raster(
    &mut self,
    url: &Rc<str>,
    data: &Rc<[u8]>,
    size: (u32, u32),
    quality: u8,
  ) -> Option<usize> {
    if let Some(k) = self.rasters.get(&(url.clone(), quality)) {
      return *k;
    }
    let first_use = !self.rasters.keys().any(|(u, _)| u == url);
    let pixels = size.0 as u64 * size.1 as u64;
    let fits = pixels <= MAX_RASTER_PIXELS
      && (!first_use || self.raster_pixels + pixels <= TOTAL_RASTER_PIXELS);
    let k = fits.then(|| {
      if first_use {
        self.raster_pixels += pixels;
      }
      self.prepared.resources.push(Resource::Raster {
        data: data.clone(),
        quality,
      });
      self.prepared.resources.len() - 1
    });
    self.rasters.insert((url.clone(), quality), k);
    k
  }

  fn broken_image(&mut self, quality: u8) -> Option<usize> {
    let url: Rc<str> = Rc::from("");
    let data: Rc<[u8]> = Rc::from(BROKEN_IMAGE);
    self.raster(&url, &data, (14, 16), quality)
  }

  /// The resource of a nested SVG image laid out at `container`.
  fn nested_svg(&mut self, url: &Rc<str>, doc: &dom::Doc, container: (f32, f32)) -> Option<usize> {
    let frame = (container.0.round() as i32, container.1.round() as i32);
    if frame.0 <= 0 || frame.1 <= 0 || self.nesting >= MAX_NESTING {
      return None;
    }
    let root = (layout_floor(container.0), layout_floor(container.1));
    let key = (url.clone(), frame, (root.0.to_bits(), root.1.to_bits()));
    if let Some(k) = self.nested.get(&key) {
      return *k;
    }
    // Taken now, so an image of the same document further in sees it.
    self.nested.insert(key.clone(), None);
    self.nesting += 1;
    let text = build::emit_document(doc, build::Root::Nested(root), self);
    self.nesting -= 1;
    let k = text.map(|text| {
      self
        .prepared
        .resources
        .push(Resource::Svg { text, frame, root });
      self.prepared.resources.len() - 1
    });
    self.nested.insert(key, k);
    k
  }
}

/// Prepares an SVG image for SkSVGDOM. `units` are the root's font units
/// (Chrome's default font at 16px).
pub(crate) fn prepare(
  bytes: &[u8],
  units: &FontUnits,
) -> Result<(Prepared, RootAttributes), PrepareError> {
  let text = std::str::from_utf8(bytes).map_err(|_| PrepareError::Unsupported)?;
  let doc = dom::Doc::parse(text).map_err(|e| match e {
    dom::DomError::TooDeep => PrepareError::TooDeep,
    _ => PrepareError::Unsupported,
  })?;
  let root_attributes = RootAttributes::of(&doc);
  let mut shared = Shared::new(units);
  let svg = build::emit_document(
    &doc,
    build::Root::Top(root_attributes.sizing(units)),
    &mut shared,
  )
  .ok_or(PrepareError::Unsupported)?;
  let mut prepared = shared.prepared;
  prepared.svg = svg;
  Ok((prepared, root_attributes))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn svg(body: &str) -> String {
    format!(
      r#"<svg xmlns="{}" width="20" height="20">{body}</svg>"#,
      dom::SVG_NS
    )
  }

  /// A data: URL of `svg`, percent-encoding only what must be.
  fn data_url(svg: &str) -> String {
    let encoded = svg
      .replace('%', "%25")
      .replace('<', "%3C")
      .replace('>', "%3E")
      .replace('"', "%22")
      .replace('#', "%23");
    format!("data:image/svg+xml,{encoded}")
  }

  fn start_tags(text: &str) -> usize {
    text
      .as_bytes()
      .windows(2)
      .filter(|w| w[0] == b'<' && w[1].is_ascii_alphabetic())
      .count()
  }

  #[test]
  fn use_fan_out_stops_at_the_element_budget() {
    // 10^6 rects through <use> (Chrome hangs on it).
    let mut body = String::from(r#"<defs><rect id="l0" width="1" height="1"/>"#);
    for i in 1..=6 {
      body += &format!(r#"<g id="l{i}">"#);
      for k in 0..10 {
        body += &format!(r##"<use href="#l{}" x="{}"/>"##, i - 1, k % 3);
      }
      body += "</g>";
    }
    body += r##"</defs><use href="#l6"/>"##;
    let (prepared, _) = prepare(svg(&body).as_bytes(), &FontUnits::fallback()).unwrap();
    let written = start_tags(&prepared.svg);
    assert!(written <= ELEMENT_BUDGET, "{written} elements written");
  }

  #[test]
  fn rasters_are_capped_in_pixels() {
    let units = FontUnits::fallback();
    let mut shared = Shared::new(&units);
    let data: Rc<[u8]> = Rc::from(&[][..]);
    let url = |s: &str| -> Rc<str> { Rc::from(s) };
    // One raster: 2^25 pixels at most.
    assert!(shared.raster(&url("a"), &data, (8192, 4096), 2).is_some());
    assert!(shared.raster(&url("b"), &data, (8193, 4096), 2).is_none());
    // The same raster at another quality costs nothing more.
    assert!(shared.raster(&url("a"), &data, (8192, 4096), 0).is_some());
    // All rasters: 2^26 pixels at most.
    assert!(shared.raster(&url("c"), &data, (8192, 4096), 2).is_some());
    assert!(shared.raster(&url("d"), &data, (1, 1), 2).is_none());
    assert_eq!(shared.prepared.resources.len(), 3);
  }

  #[test]
  fn nested_images_are_prepared_once_per_url() {
    // Each level draws the level below 10 times: 10^5 draws of the rect.
    let x = format!(r#"xmlns="{}""#, dom::SVG_NS);
    let mut inner = format!(r#"<svg {x} width="4" height="4"><rect width="4" height="4"/></svg>"#);
    for _ in 0..5 {
      let mut b = format!(
        r#"<image id="i" width="4" height="4" href="{}"/>"#,
        data_url(&inner)
      );
      for k in 1..10 {
        b += &format!(r##"<use href="#i" x="{k}"/>"##);
      }
      inner = format!(r#"<svg {x} width="4" height="4">{b}</svg>"#);
    }
    let (prepared, _) = prepare(inner.as_bytes(), &FontUnits::fallback()).unwrap();
    // One per level below the top.
    assert_eq!(prepared.resources.len(), 5);
    assert_eq!(prepared.svg.matches("napi-svg:").count(), 10);
  }
}
