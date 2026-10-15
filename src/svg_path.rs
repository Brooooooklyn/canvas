//! `new Path2D(pathData)`: Blink's SVG path data parser and builder, so a
//! string parses as in Chrome, and an error keeps the segments before it
//! (BuildPathFromString, core/svg/svg_path_utilities.cc:35-44).
//!
//! - SVGPathStringSource::ParseSegment (core/svg/svg_path_string_source.cc)
//! - svg_path_parser::ParsePath (core/svg/svg_path_parser.h:35-45)
//! - GenericParseNumber (core/svg/svg_parser_utilities.cc): float
//!   arithmetic digit by digit, not a correctly rounded parse
//! - SVGPathBuilder::EmitSegment (core/svg/svg_path_builder.cc)

use crate::sk::Path as SkPath;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Seg {
  Close,
  MoveAbs,
  MoveRel,
  LineAbs,
  LineRel,
  CubicAbs,
  CubicRel,
  QuadAbs,
  QuadRel,
  ArcAbs,
  ArcRel,
  HorizontalAbs,
  HorizontalRel,
  VerticalAbs,
  VerticalRel,
  SmoothCubicAbs,
  SmoothCubicRel,
  SmoothQuadAbs,
  SmoothQuadRel,
}

/// MapLetterToSegmentType (core/svg/svg_path_data.h:95-140).
fn seg_for(c: u8) -> Option<Seg> {
  Some(match c {
    b'Z' | b'z' => Seg::Close,
    b'M' => Seg::MoveAbs,
    b'm' => Seg::MoveRel,
    b'L' => Seg::LineAbs,
    b'l' => Seg::LineRel,
    b'C' => Seg::CubicAbs,
    b'c' => Seg::CubicRel,
    b'Q' => Seg::QuadAbs,
    b'q' => Seg::QuadRel,
    b'A' => Seg::ArcAbs,
    b'a' => Seg::ArcRel,
    b'H' => Seg::HorizontalAbs,
    b'h' => Seg::HorizontalRel,
    b'V' => Seg::VerticalAbs,
    b'v' => Seg::VerticalRel,
    b'S' => Seg::SmoothCubicAbs,
    b's' => Seg::SmoothCubicRel,
    b'T' => Seg::SmoothQuadAbs,
    b't' => Seg::SmoothQuadRel,
    _ => return None,
  })
}

/// IsHTMLSpace: space, \t, \n, \f, \r.
fn is_space(c: u8) -> bool {
  matches!(c, b' ' | b'\t' | b'\n' | b'\x0c' | b'\r')
}

#[derive(Default, Clone, Copy)]
struct Segment {
  point1: (f32, f32),
  point2: (f32, f32),
  target: (f32, f32),
  // Arc: radii and angle travel in point1/point2 as in PathSegmentData.
  arc_large: bool,
  arc_sweep: bool,
}

struct Source<'a> {
  s: &'a [u8],
  pos: usize,
  previous: Option<Seg>,
  error: bool,
}

impl Source<'_> {
  fn has_more_data(&self) -> bool {
    self.pos < self.s.len()
  }

  /// SkipOptionalSVGSpaces; whether data is left.
  fn skip_spaces(&mut self) -> bool {
    while self.pos < self.s.len() && is_space(self.s[self.pos]) {
      self.pos += 1;
    }
    self.pos < self.s.len()
  }

  /// SkipOptionalSVGSpacesOrDelimiter (svg_parser_utilities.h:71-86).
  fn skip_spaces_or_delimiter(&mut self) {
    if self.pos < self.s.len() && !is_space(self.s[self.pos]) && self.s[self.pos] != b',' {
      return;
    }
    if self.skip_spaces() && self.s[self.pos] == b',' {
      self.pos += 1;
      self.skip_spaces();
    }
  }

  /// GenericParseNumber<float> with leading and trailing whitespace allowed.
  fn parse_number(&mut self) -> Option<f32> {
    self.skip_spaces();
    let s = self.s;
    let mut i = self.pos;
    let mut sign = 1.0f32;
    if i < s.len() && s[i] == b'+' {
      i += 1;
    } else if i < s.len() && s[i] == b'-' {
      i += 1;
      sign = -1.0;
    }
    if i >= s.len() || (!s[i].is_ascii_digit() && s[i] != b'.') {
      return None;
    }
    let start = i;
    while i < s.len() && s[i].is_ascii_digit() {
      i += 1;
    }
    let mut integer = 0.0f32;
    if i > start {
      let mut multiplier = 1.0f32;
      for &d in s[start..i].iter().rev() {
        integer += multiplier * (d - b'0') as f32;
        multiplier *= 10.0;
      }
      if !valid_range(integer) {
        return None;
      }
    }
    let mut decimal = 0.0f32;
    if i < s.len() && s[i] == b'.' {
      i += 1;
      if i >= s.len() || !s[i].is_ascii_digit() {
        return None;
      }
      let mut frac = 1.0f32;
      while i < s.len() && s[i].is_ascii_digit() {
        frac *= 0.1f32;
        decimal += (s[i] - b'0') as f32 * frac;
        i += 1;
      }
    }
    let mut number = integer + decimal;
    number *= sign;
    if i + 1 < s.len() && (s[i] == b'e' || s[i] == b'E') && s[i + 1] != b'x' && s[i + 1] != b'm' {
      i += 1;
      let mut negative = false;
      if s[i] == b'+' {
        i += 1;
      } else if s[i] == b'-' {
        i += 1;
        negative = true;
      }
      if i >= s.len() || !s[i].is_ascii_digit() {
        return None;
      }
      let mut exponent = 0.0f32;
      while i < s.len() && s[i].is_ascii_digit() {
        exponent *= 10.0;
        exponent += (s[i] - b'0') as f32;
        i += 1;
      }
      if negative {
        exponent = -exponent;
      }
      // numeric_limits<float>::max_exponent10
      if exponent > 38.0 {
        return None;
      }
      if exponent != 0.0 {
        number *= 10f64.powf(exponent as f64) as f32;
      }
    }
    if !valid_range(number) {
      return None;
    }
    self.pos = i;
    self.skip_spaces_or_delimiter();
    Some(number)
  }

  /// ParseNumberWithError: 0 and the error mark on failure.
  fn number(&mut self) -> f32 {
    match self.parse_number() {
      Some(v) => v,
      None => {
        self.error = true;
        0.0
      }
    }
  }

  /// ParseArcFlag: "0" or "1", then an optional space or delimiter.
  fn flag(&mut self) -> bool {
    let v = match self.s.get(self.pos) {
      Some(b'0') => false,
      Some(b'1') => true,
      _ => {
        self.error = true;
        return false;
      }
    };
    self.pos += 1;
    self.skip_spaces_or_delimiter();
    v
  }

  fn parse_segment(&mut self) -> Option<(Seg, Segment)> {
    let lookahead = self.s[self.pos];
    let command = match (self.previous, seg_for(lookahead)) {
      // The first command has to be a moveto.
      (None, Some(c @ (Seg::MoveAbs | Seg::MoveRel))) => {
        self.pos += 1;
        c
      }
      (None, _) => return None,
      (Some(previous), None) => {
        // An implicit command: a number continues the previous command, a
        // moveto continues as a lineto, a closepath takes no numbers.
        let number_start = lookahead.is_ascii_digit() || matches!(lookahead, b'+' | b'-' | b'.');
        if !number_start || previous == Seg::Close {
          return None;
        }
        match previous {
          Seg::MoveAbs => Seg::LineAbs,
          Seg::MoveRel => Seg::LineRel,
          other => other,
        }
      }
      (Some(_), Some(c)) => {
        self.pos += 1;
        c
      }
    };
    self.previous = Some(command);
    let mut seg = Segment::default();
    match command {
      Seg::CubicAbs | Seg::CubicRel => {
        seg.point1 = (self.number(), self.number());
        seg.point2 = (self.number(), self.number());
        seg.target = (self.number(), self.number());
      }
      Seg::SmoothCubicAbs | Seg::SmoothCubicRel => {
        seg.point2 = (self.number(), self.number());
        seg.target = (self.number(), self.number());
      }
      Seg::MoveAbs
      | Seg::MoveRel
      | Seg::LineAbs
      | Seg::LineRel
      | Seg::SmoothQuadAbs
      | Seg::SmoothQuadRel => {
        seg.target = (self.number(), self.number());
      }
      Seg::HorizontalAbs | Seg::HorizontalRel => seg.target.0 = self.number(),
      Seg::VerticalAbs | Seg::VerticalRel => seg.target.1 = self.number(),
      Seg::Close => {
        self.skip_spaces();
      }
      Seg::QuadAbs | Seg::QuadRel => {
        seg.point1 = (self.number(), self.number());
        seg.target = (self.number(), self.number());
      }
      Seg::ArcAbs | Seg::ArcRel => {
        let rx = self.number();
        let ry = self.number();
        seg.point1 = (rx, ry);
        seg.point2.0 = self.number();
        seg.arc_large = self.flag();
        seg.arc_sweep = self.flag();
        seg.target = (self.number(), self.number());
      }
    }
    if self.error {
      return None;
    }
    Some((command, seg))
  }
}

/// IsValidRange: finite (NaN fails).
fn valid_range(x: f32) -> bool {
  (-f32::MAX..=f32::MAX).contains(&x)
}

fn add(a: (f32, f32), b: (f32, f32)) -> (f32, f32) {
  (a.0 + b.0, a.1 + b.1)
}

/// SVGPathBuilder: emits the parsed segments into an SkPath.
struct Builder {
  path: SkPath,
  current: (f32, f32),
  subpath: (f32, f32),
  last_control: (f32, f32),
  last_command: Option<Seg>,
}

impl Builder {
  fn smooth_control(&self, compatible: bool) -> (f32, f32) {
    if compatible {
      (
        self.current.0 + (self.current.0 - self.last_control.0),
        self.current.1 + (self.current.1 - self.last_control.1),
      )
    } else {
      self.current
    }
  }

  fn move_to(&mut self, p: (f32, f32)) {
    self.path.move_to(p.0, p.1);
    self.subpath = p;
    self.current = p;
  }

  fn line_to(&mut self, p: (f32, f32)) {
    self.path.line_to(p.0, p.1);
    self.current = p;
  }

  fn quad_to(&mut self, c: (f32, f32), p: (f32, f32)) {
    self.path.quad_to(c.0, c.1, p.0, p.1);
    self.last_control = c;
    self.current = p;
  }

  fn cubic_to(&mut self, c0: (f32, f32), c1: (f32, f32), p: (f32, f32)) {
    self.path.cubic_to(c0.0, c0.1, c1.0, c1.1, p.0, p.1);
    self.last_control = c1;
    self.current = p;
  }

  fn emit(&mut self, command: Seg, seg: Segment) {
    let cur = self.current;
    let last_quad = matches!(
      self.last_command,
      Some(Seg::QuadAbs | Seg::QuadRel | Seg::SmoothQuadAbs | Seg::SmoothQuadRel)
    );
    let last_cubic = matches!(
      self.last_command,
      Some(Seg::CubicAbs | Seg::CubicRel | Seg::SmoothCubicAbs | Seg::SmoothCubicRel)
    );
    match command {
      Seg::Close => {
        self.path.close();
        self.current = self.subpath;
      }
      Seg::MoveAbs => self.move_to(seg.target),
      Seg::MoveRel => self.move_to(add(cur, seg.target)),
      Seg::LineAbs => self.line_to(seg.target),
      Seg::LineRel => self.line_to(add(cur, seg.target)),
      Seg::HorizontalAbs => self.line_to((seg.target.0, cur.1)),
      // current_point_ + Vector2dF(x, 0): adding 0 turns -0 into 0.
      Seg::HorizontalRel => self.line_to(add(cur, (seg.target.0, 0.0))),
      Seg::VerticalAbs => self.line_to((cur.0, seg.target.1)),
      Seg::VerticalRel => self.line_to(add(cur, (0.0, seg.target.1))),
      Seg::QuadAbs => self.quad_to(seg.point1, seg.target),
      Seg::QuadRel => self.quad_to(add(cur, seg.point1), add(cur, seg.target)),
      Seg::SmoothQuadAbs => self.quad_to(self.smooth_control(last_quad), seg.target),
      Seg::SmoothQuadRel => self.quad_to(self.smooth_control(last_quad), add(cur, seg.target)),
      Seg::CubicAbs => self.cubic_to(seg.point1, seg.point2, seg.target),
      Seg::CubicRel => self.cubic_to(
        add(cur, seg.point1),
        add(cur, seg.point2),
        add(cur, seg.target),
      ),
      Seg::SmoothCubicAbs => self.cubic_to(self.smooth_control(last_cubic), seg.point2, seg.target),
      Seg::SmoothCubicRel => self.cubic_to(
        self.smooth_control(last_cubic),
        add(cur, seg.point2),
        add(cur, seg.target),
      ),
      Seg::ArcAbs | Seg::ArcRel => {
        let p = if command == Seg::ArcAbs {
          seg.target
        } else {
          add(cur, seg.target)
        };
        self.path.svg_arc_to(
          seg.point1.0,
          seg.point1.1,
          seg.point2.0,
          seg.arc_large,
          seg.arc_sweep,
          p.0,
          p.1,
        );
        self.current = p;
      }
    }
    self.last_command = Some(command);
  }
}

/// The path of `new Path2D(data)`: every segment up to the first error.
pub(crate) fn build_path_from_string(data: &str) -> SkPath {
  let mut builder = Builder {
    path: SkPath::new(),
    current: (0.0, 0.0),
    subpath: (0.0, 0.0),
    last_control: (0.0, 0.0),
    last_command: None,
  };
  let mut source = Source {
    s: data.as_bytes(),
    pos: 0,
    previous: None,
    error: false,
  };
  source.skip_spaces();
  while source.has_more_data() {
    let Some((command, seg)) = source.parse_segment() else {
      break;
    };
    builder.emit(command, seg);
  }
  builder.path
}
