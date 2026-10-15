use std::{
  cell::{Cell, RefCell},
  rc::Rc,
};

use napi::bindgen_prelude::*;

use crate::{
  color::{self, Color, ColorSpace},
  sk::{
    Color4f, ConicGradient, Gradient as SkGradient, GradientInterpolation, LinearGradient,
    RadialGradient, Shader, TileMode, Transform,
  },
  webidl::{self, Positional, Site},
};

#[derive(Debug, Clone, Copy)]
enum Geometry {
  Linear {
    start: (f32, f32),
    end: (f32, f32),
  },
  Radial {
    start: (f32, f32),
    start_radius: f32,
    end: (f32, f32),
    end_radius: f32,
  },
  /// `rotation` in degrees: Blink stores `Rad2deg(startAngle) + 90`
  /// (canvas_2d_recorder_context.cc:2424-2426), so angle 0 points along +x.
  Conic {
    center: (f32, f32),
    rotation: f32,
  },
}

/// Blink's Gradient (platform/graphics/gradient.cc) as a canvas uses it.
#[derive(Debug, Clone)]
pub struct Gradient {
  geometry: Geometry,
  /// Sorted by offset; stops sharing an offset keep insertion order.
  stops: Vec<(f32, Color)>,
  /// Blink's `color_space_interpolation_space_`: unset until a draw first
  /// builds the shader (gradient.cc:305-315), then fixed for good, even when
  /// later stops would pick another space.
  interpolation: Cell<Option<GradientInterpolation>>,
}

impl Gradient {
  fn new(geometry: Geometry) -> Self {
    Self {
      geometry,
      stops: Vec::new(),
      interpolation: Cell::new(None),
    }
  }

  pub fn create_linear_gradient(x0: f32, y0: f32, x1: f32, y1: f32) -> Self {
    Self::new(Geometry::Linear {
      start: (x0, y0),
      end: (x1, y1),
    })
  }

  pub fn create_radial_gradient(x0: f32, y0: f32, r0: f32, x1: f32, y1: f32, r1: f32) -> Self {
    Self::new(Geometry::Radial {
      start: (x0, y0),
      start_radius: r0,
      end: (x1, y1),
      end_radius: r1,
    })
  }

  /// `start_angle` is in radians.
  pub fn create_conic_gradient(x: f32, y: f32, start_angle: f32) -> Self {
    Self::new(Geometry::Conic {
      center: (x, y),
      rotation: start_angle * (180.0 / std::f32::consts::PI) + 90.0,
    })
  }

  pub fn add_color_stop(&mut self, offset: f32, color: Color) {
    // Stops sharing an offset must keep insertion order (HTML spec,
    // dom-canvasgradient-addcolorstop), so a new stop belongs at the UPPER bound
    // of `offset` -- what Blink gets from a `stable_sort` over a strict `<`.
    let index = self.stops.partition_point(|&(o, _)| o <= offset);
    self.stops.insert(index, (offset, color));
  }

  /// Rough size of the shader a recorded draw retains: ~32 B per stop
  /// (position f32, float RGBA color, plus share of the shader object).
  pub(crate) fn estimated_bytes(&self) -> usize {
    self.stops.len() * 32 + 256
  }

  /// The space the stops are mixed in: the latched one, else what
  /// CreateShaderInternal would latch now (gradient.cc:305-315): sRGB, unless
  /// a stop's GetColorInterpolationSpace is not srgb-legacy, which makes it
  /// Oklab (color.cc:1253-1262).
  fn interpolation(&self) -> GradientInterpolation {
    self.interpolation.get().unwrap_or_else(|| {
      if self
        .stops
        .iter()
        .any(|(_, c)| c.interpolation_space() != ColorSpace::SrgbLegacy)
      {
        GradientInterpolation::Oklab
      } else {
        GradientInterpolation::Srgb
      }
    })
  }

  /// Fix the interpolation space, as Blink's first CreateShaderInternal does.
  /// The context calls this only for a draw that reaches `state.GetFlags()`.
  pub(crate) fn latch_interpolation(&self) {
    self.interpolation.set(Some(self.interpolation()));
  }

  pub(crate) fn interpolation_latched(&self) -> bool {
    self.interpolation.get().is_some()
  }

  /// Blink's Gradient::FillSkiaStops (gradient.cc:131-213): a gradient with no
  /// stops is transparent black, and the first and last stops are copied to
  /// 0.0 and 1.0. So Skia never gets 0 colors (it would fail) or 1 color (it
  /// would make a solid color shader, which is never dithered). A stop with
  /// `none` parameters in the interpolation space takes them from each
  /// neighbor, as two stops at its offset.
  fn skia_stops(&self, interpolation: GradientInterpolation) -> (Vec<Color4f>, Vec<f32>) {
    let space = match interpolation {
      GradientInterpolation::Srgb => ColorSpace::Srgb,
      GradientInterpolation::Oklab => ColorSpace::Oklab,
    };
    let stops = &self.stops;
    let mut colors = Vec::with_capacity(stops.len() + 2);
    let mut positions = Vec::with_capacity(stops.len() + 2);
    match stops.first() {
      None => {
        positions.push(0.0);
        colors.push(Color4f::TRANSPARENT);
      }
      Some(&(offset, first)) if offset > 0.0 => {
        positions.push(0.0);
        colors.push(first.to_sk_color4f());
      }
      Some(_) => {}
    }
    for (i, &(offset, stop)) in stops.iter().enumerate() {
      let mut color = stop;
      color.convert_to_color_space_for_interpolation(space);
      let offset = clamp_float_geometry(offset);
      if !color.has_none() {
        positions.push(offset);
        colors.push(color.to_sk_color4f());
        continue;
      }
      if stops.len() == 1 {
        positions.push(offset);
        let all_none = Color::from_color_space(color.space(), None, None, None, Some(1.0));
        colors.push(resolve_stop_color_with_missing_params(
          &color, &all_none, space,
        ));
        break;
      }
      if i != 0 {
        positions.push(offset);
        colors.push(resolve_stop_color_with_missing_params(
          &color,
          &stops[i - 1].1,
          space,
        ));
      }
      if i != stops.len() - 1 {
        positions.push(offset);
        colors.push(resolve_stop_color_with_missing_params(
          &color,
          &stops[i + 1].1,
          space,
        ));
      }
    }
    if positions[positions.len() - 1] < 1.0 {
      positions.push(1.0);
      colors.push(colors[colors.len() - 1]);
    }
    (colors, positions)
  }

  /// Blink's `DegenerateHandling::kDisallow` (canvas_gradient.cc:100-135): a
  /// linear gradient whose points are equal, or a radial gradient whose
  /// circles are equal, gets `PaintShader::MakeEmpty()` and paints nothing
  /// (gradient.cc:399-402, 457-463). Exact float compare of the factory's
  /// ClampTo<float> values; the radii as Blink compares them, after
  /// ClampFloatGeometry and max(0). A conic gradient is never degenerate
  /// here: its angles are always 0 and 360 degrees.
  fn is_degenerate(&self) -> bool {
    match self.geometry {
      Geometry::Linear { start, end } => start == end,
      Geometry::Radial {
        start,
        start_radius,
        end,
        end_radius,
      } => start == end && skia_radius(start_radius) == skia_radius(end_radius),
      Geometry::Conic { .. } => false,
    }
  }

  /// Like `skia_stops`, but a degenerate gradient gets none: the transparent
  /// shader of a gradient with no stops, which paints exactly like Blink's
  /// empty shader (measured in Chrome 155 under every composite op, shadow and
  /// filter).
  fn shader_stops(&self) -> SkGradient {
    let interpolation = self.interpolation();
    let (colors, positions) = if self.is_degenerate() {
      Self::new(self.geometry).skia_stops(interpolation)
    } else {
      self.skia_stops(interpolation)
    };
    SkGradient {
      colors,
      positions,
      tile_mode: TileMode::Clamp,
      transform: Transform::default(),
      interpolation,
    }
  }

  /// The one color the gradient paints everywhere, if there is one: transparent
  /// black with no stops or a degenerate geometry, or the color that all its
  /// Skia stops share.
  pub(crate) fn constant_color(&self) -> Option<Color4f> {
    let base = self.shader_stops();
    let (first, rest) = base.colors.split_first()?;
    rest.iter().all(|c| c == first).then_some(*first)
  }

  /// The Skia shader, or None when Skia cannot build one (for example a conic
  /// gradient whose start angle in degrees overflows f32). cc's
  /// PaintShader::GetSkShader then gives no shader either, and Chrome paints
  /// the paint's color: black at globalAlpha (canvas_style.cc:130-137).
  pub(crate) fn get_shader(&self) -> Option<Shader> {
    let base = self.shader_stops();
    match self.geometry {
      Geometry::Linear { start, end } => Shader::new_linear_gradient(&LinearGradient {
        // Blink ClampNonFiniteToSafeFloat (gradient.cc:404-405).
        start_point: clamp_point(start),
        end_point: clamp_point(end),
        base,
      }),
      // Skia's two-point conical gradient is the canvas radial gradient.
      // Blink clamps the centers like the linear points, and the radii to
      // max(ClampFloatGeometry(r), 0) (gradient.cc:453-459).
      Geometry::Radial {
        start,
        start_radius,
        end,
        end_radius,
      } => Shader::new_radial_gradient(&RadialGradient {
        start: clamp_point(start),
        start_radius: skia_radius(start_radius),
        end: clamp_point(end),
        end_radius: skia_radius(end_radius),
        base,
      }),
      // The canvas CTM already applies to the shader, so the angle does not
      // depend on it. Blink does not clamp the conic center.
      Geometry::Conic { center, rotation } => Shader::new_conic_gradient(&ConicGradient {
        center,
        rotation,
        base,
      }),
    }
  }
}

/// Blink's ResolveStopColorWithMissingParams (gradient.cc:96-124): `color`,
/// already in `space`, takes each `none` parameter (and a `none` alpha) from
/// `neighbor` converted to `space`.
fn resolve_stop_color_with_missing_params(
  color: &Color,
  neighbor: &Color,
  space: ColorSpace,
) -> Color4f {
  let mut converted = *neighbor;
  converted.convert_to_color_space_for_interpolation(space);
  let [p0, p1, p2] = color.params();
  let [n0, n1, n2] = converted.params();
  let pick =
    |i: usize, own: f32, theirs: f32| Some(if color.param_is_none(i) { theirs } else { own });
  let alpha = if color.alpha_is_none() {
    converted.alpha()
  } else {
    color.alpha()
  };
  Color::from_color_space(
    space,
    pick(0, p0, n0),
    pick(1, p1, n1),
    pick(2, p2, n2),
    Some(alpha),
  )
  .to_sk_color4f()
}

/// gfx::ClampFloatGeometry (ui/gfx/geometry/clamp_float_geometry.h): NaN is
/// 0, and the value saturates at +-FLT_MAX / 1e6.
fn clamp_float_geometry(v: f32) -> f32 {
  const MAX: f32 = f32::MAX / 1e6;
  if v.is_nan() { 0.0 } else { v.clamp(-MAX, MAX) }
}

fn clamp_point((x, y): (f32, f32)) -> (f32, f32) {
  (clamp_float_geometry(x), clamp_float_geometry(y))
}

/// The radius Blink gives Skia: max(ClampFloatGeometry(r), 0).
fn skia_radius(r: f32) -> f32 {
  clamp_float_geometry(r).max(0.0)
}

/// A gradient is live: stops added after it became a fillStyle or
/// strokeStyle apply to later draws (Blink's CanvasStyle keeps the
/// CanvasGradient, canvas_style.cc), so a context shares it, not a copy.
pub type SharedGradient = Rc<RefCell<Gradient>>;

#[napi]
pub struct CanvasGradient(pub(crate) SharedGradient);

impl CanvasGradient {
  pub(crate) fn new(gradient: Gradient) -> Self {
    Self(Rc::new(RefCell::new(gradient)))
  }
}

/// The arguments of addColorStop(double offset, DOMString color), its last
/// parameter: it gets the argument count and converts the `Positional`
/// arguments before it, in order, before napi-rs borrows the gradient, so
/// valueOf and toString may use it, as in Chrome.
pub struct AddColorStopArgs {
  offset: f64,
  color: String,
}

impl FromNapiValue for AddColorStopArgs {
  unsafe fn from_napi_value(env: sys::napi_env, argc: sys::napi_value) -> Result<Self> {
    let prefix = webidl::GradientAddColorStop::PREFIX;
    let args = webidl::Arguments::take(env, 2, argc)?;
    if args.len() < 2 {
      return Err(webidl::context_type_error(
        env,
        prefix,
        &format!("2 arguments required, but only {} present.", args.len()),
      ));
    }
    let offset = webidl::to_restricted_double(env, args.get(0)?, prefix)?;
    let color = webidl::to_dom_string(env, args.get(1)?, prefix)?;
    Ok(Self { offset, color })
  }
}

#[napi]
impl CanvasGradient {
  /// addColorStop(offset, color). The index.js wrapper passes the argument
  /// count after them; see `webidl::Arguments::take`.
  #[napi]
  pub fn add_color_stop(
    &mut self,
    env: &Env,
    _offset: Positional,
    _color: Positional,
    args: AddColorStopArgs,
  ) -> Result<()> {
    let prefix = webidl::GradientAddColorStop::PREFIX;
    let AddColorStopArgs { offset, color } = args;
    // canvas_gradient.cc:137-158: the range, then the color.
    if !(0.0..=1.0).contains(&offset) {
      return Err(webidl::dom_exception(
        env.raw(),
        "IndexSizeError",
        &format!(
          "{prefix}The provided value ({}) is outside the range (0.0, 1.0).",
          webidl::number_to_string(offset)
        ),
      ));
    }
    let Some(stop) = color::parse_canvas_color(&color, color::Site::GradientStop) else {
      return Err(webidl::dom_exception(
        env.raw(),
        "SyntaxError",
        &format!("{prefix}The value provided ('{color}') could not be parsed as a color."),
      ));
    };
    self.0.borrow_mut().add_color_stop(offset as f32, stop);
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn rgb(r: i32, g: i32, b: i32) -> Color {
    Color::from_rgb(r, g, b)
  }

  fn offsets(g: &Gradient) -> Vec<f32> {
    g.stops.iter().map(|&(o, _)| o).collect()
  }

  fn colors(g: &Gradient) -> Vec<u32> {
    g.stops.iter().map(|(_, c)| c.rgb()).collect()
  }

  #[test]
  fn test_add_color_stop() {
    let mut g = Gradient::create_linear_gradient(0.0, 0.0, 0.0, 77.0);
    g.add_color_stop(1.0, rgb(0, 128, 128));
    g.add_color_stop(0.6, rgb(0, 255, 255));
    g.add_color_stop(0.3, rgb(176, 199, 45));
    g.add_color_stop(0.0, rgb(204, 82, 50));
    assert_eq!(offsets(&g), vec![0.0, 0.3, 0.6, 1.0]);
    assert_eq!(
      colors(&g),
      vec![0xffcc5232, 0xffb0c72d, 0xff00ffff, 0xff008080]
    );
  }

  /// Pins the HTML spec's rule that stops sharing an offset keep insertion
  /// order (dom-canvasgradient-addcolorstop).
  #[test]
  fn test_add_color_stop_duplicated_offsets_keep_insertion_order() {
    let red = rgb(255, 0, 0);
    let green = rgb(0, 255, 0);
    let blue = rgb(0, 0, 255);
    let white = rgb(255, 255, 255);
    let black = rgb(0, 0, 0);
    let (r, gr, b, w, k) = (red.rgb(), green.rgb(), blue.rgb(), white.rgb(), black.rgb());

    // Two stops at the same offset, appended at the tail.
    let mut g = Gradient::create_linear_gradient(0.0, 0.0, 20.0, 0.0);
    g.add_color_stop(0.5, red);
    g.add_color_stop(0.5, blue);
    assert_eq!(offsets(&g), vec![0.5, 0.5]);
    assert_eq!(colors(&g), vec![r, b]);

    // A duplicate offset in the middle of an existing run must not jump ahead of it.
    let mut g = Gradient::create_linear_gradient(0.0, 0.0, 20.0, 0.0);
    g.add_color_stop(0.0, white);
    g.add_color_stop(0.5, red);
    g.add_color_stop(0.5, green);
    g.add_color_stop(0.5, blue);
    g.add_color_stop(1.0, black);
    assert_eq!(offsets(&g), vec![0.0, 0.5, 0.5, 0.5, 1.0]);
    assert_eq!(colors(&g), vec![w, r, gr, b, k]);

    // Duplicates at the 0.0 and 1.0 boundaries.
    let mut g = Gradient::create_radial_gradient(16.0, 16.0, 0.0, 16.0, 16.0, 16.0);
    g.add_color_stop(0.0, red);
    g.add_color_stop(0.0, green);
    g.add_color_stop(1.0, blue);
    g.add_color_stop(1.0, black);
    assert_eq!(offsets(&g), vec![0.0, 0.0, 1.0, 1.0]);
    assert_eq!(colors(&g), vec![r, gr, b, k]);

    // Out-of-order insertion mixed with duplicates.
    let mut g = Gradient::create_conic_gradient(16.0, 16.0, 16.0);
    g.add_color_stop(1.0, black);
    g.add_color_stop(0.5, red);
    g.add_color_stop(0.25, green);
    g.add_color_stop(0.5, blue);
    g.add_color_stop(0.0, white);
    g.add_color_stop(0.25, red);
    assert_eq!(offsets(&g), vec![0.0, 0.25, 0.25, 0.5, 0.5, 1.0]);
    assert_eq!(colors(&g), vec![w, gr, r, r, b, k]);
  }

  /// Blink FillSkiaStops: no stops -> transparent black; the first and last
  /// stops are copied to 0.0 and 1.0.
  #[test]
  fn test_skia_stops_pad_like_blink() {
    let red = rgb(255, 0, 0);
    let blue = rgb(0, 0, 255);
    let red4f = Color4f {
      r: 1.0,
      g: 0.0,
      b: 0.0,
      a: 1.0,
    };
    let blue4f = Color4f {
      r: 0.0,
      g: 0.0,
      b: 1.0,
      a: 1.0,
    };
    let stops = |g: &Gradient| {
      let (c, p) = g.skia_stops(g.interpolation());
      (p, c)
    };

    let g = Gradient::create_linear_gradient(0.0, 0.0, 20.0, 0.0);
    assert_eq!(
      stops(&g),
      (
        vec![0.0, 1.0],
        vec![Color4f::TRANSPARENT, Color4f::TRANSPARENT]
      )
    );
    assert_eq!(g.constant_color(), Some(Color4f::TRANSPARENT));

    let mut g = Gradient::create_radial_gradient(0.0, 0.0, 0.0, 0.0, 0.0, 20.0);
    g.add_color_stop(0.3, red);
    assert_eq!(stops(&g), (vec![0.0, 0.3, 1.0], vec![red4f, red4f, red4f]));
    assert_eq!(g.constant_color(), Some(red4f));

    let mut g = Gradient::create_conic_gradient(0.0, 0.0, 0.0);
    g.add_color_stop(0.0, red);
    g.add_color_stop(1.0, blue);
    assert_eq!(stops(&g), (vec![0.0, 1.0], vec![red4f, blue4f]));
    assert_eq!(g.constant_color(), None);
  }

  /// gradient.cc:156-201: a stop with a `none` parameter in the interpolation
  /// space is split in two at its offset, each half taking the parameter from
  /// one neighbor; a lone stop takes 0 (and alpha 1).
  #[test]
  fn test_none_stops_take_neighbor_params() {
    let parse = |s: &str| color::parse_canvas_color(s, color::Site::GradientStop).unwrap();
    let mut g = Gradient::create_linear_gradient(0.0, 0.0, 20.0, 0.0);
    g.add_color_stop(0.0, parse("oklab(0.2 0 0)"));
    g.add_color_stop(0.5, parse("oklab(none 0 0)"));
    g.add_color_stop(1.0, parse("oklab(0.8 0 0)"));
    assert_eq!(g.interpolation(), GradientInterpolation::Oklab);
    let (c, p) = g.skia_stops(g.interpolation());
    assert_eq!(p, vec![0.0, 0.5, 0.5, 1.0]);
    let gray = |l: &str| parse(&format!("oklab({l} 0 0)")).to_sk_color4f();
    assert_eq!(c, vec![gray("0.2"), gray("0.2"), gray("0.8"), gray("0.8")]);

    let mut g = Gradient::create_linear_gradient(0.0, 0.0, 20.0, 0.0);
    g.add_color_stop(0.5, parse("oklab(none 0 0 / none)"));
    let (c, p) = g.skia_stops(g.interpolation());
    assert_eq!(p, vec![0.0, 0.5, 1.0]);
    let black = parse("oklab(0 0 0)").to_sk_color4f();
    // The 0.0 pad copies the stop as written: `none` alpha is 0.
    assert_eq!(c[0].a, 0.0);
    assert_eq!(c[1..], [black, black]);
  }

  /// gradient.cc:305-315: the space is fixed at the first latch.
  #[test]
  fn test_interpolation_latches() {
    let parse = |s: &str| color::parse_canvas_color(s, color::Site::GradientStop).unwrap();
    let mut g = Gradient::create_linear_gradient(0.0, 0.0, 20.0, 0.0);
    g.add_color_stop(0.0, parse("red"));
    assert_eq!(g.interpolation(), GradientInterpolation::Srgb);
    g.latch_interpolation();
    g.add_color_stop(1.0, parse("oklch(0.6 0.15 140)"));
    assert_eq!(g.interpolation(), GradientInterpolation::Srgb);
    // Unlatched, the same stops pick Oklab.
    let mut fresh = Gradient::create_linear_gradient(0.0, 0.0, 20.0, 0.0);
    fresh.add_color_stop(0.0, parse("red"));
    fresh.add_color_stop(1.0, parse("oklch(0.6 0.15 140)"));
    assert_eq!(fresh.interpolation(), GradientInterpolation::Oklab);
    // A legacy color with `none` is not srgb-legacy for interpolation.
    let mut g = Gradient::create_linear_gradient(0.0, 0.0, 20.0, 0.0);
    g.add_color_stop(0.0, parse("rgb(none 0 0)"));
    assert_eq!(g.interpolation(), GradientInterpolation::Oklab);
  }

  /// Blink kDisallow: equal linear points, or equal radial circles after the
  /// radius clamp, paint nothing; anything else still paints.
  #[test]
  fn test_degenerate_geometry_paints_nothing() {
    let two_stops = |mut g: Gradient| {
      g.add_color_stop(0.0, rgb(255, 0, 0));
      g.add_color_stop(1.0, rgb(0, 0, 255));
      g
    };
    // The factories pass ClampTo<float> of the JS doubles.
    for g in [
      Gradient::create_linear_gradient(2.0, 2.0, 2.0, 2.0),
      Gradient::create_linear_gradient(0.0, 0.0, -0.0, 0.0),
      Gradient::create_linear_gradient(2.0, 2.0, (2.0f64 + 1e-7) as f32, 2.0),
      Gradient::create_linear_gradient(f32::MAX, 0.0, f32::MAX, 0.0),
      Gradient::create_radial_gradient(2.0, 2.0, 1.0, 2.0, 2.0, 1.0),
      Gradient::create_radial_gradient(2.0, 2.0, 0.0, 2.0, 2.0, 0.0),
      // Both radii clamp to FLT_MAX / 1e6.
      Gradient::create_radial_gradient(2.0, 2.0, 1e33, 2.0, 2.0, 2e33),
    ] {
      let g = two_stops(g);
      assert_eq!(g.constant_color(), Some(Color4f::TRANSPARENT));
      assert!(g.get_shader().is_some());
    }
    for g in [
      Gradient::create_linear_gradient(2.0, 2.0, 2.00001, 2.0),
      // Distinct as floats, equal only after ClampFloatGeometry.
      Gradient::create_linear_gradient(1e34, 0.0, 2e34, 0.0),
      Gradient::create_radial_gradient(2.0, 2.0, 1.0, 2.0, 2.0, (1.0f64 + 1e-7) as f32),
      Gradient::create_radial_gradient(2.0, 2.0, 1.0, 2.00001, 2.0, 1.0),
      Gradient::create_conic_gradient(2.0, 2.0, 0.0),
    ] {
      let g = two_stops(g);
      assert_eq!(g.constant_color(), None);
      assert!(g.get_shader().is_some());
    }
  }
}
