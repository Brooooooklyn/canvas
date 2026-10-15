//! CSS math functions (`calc()`, `min()`, `round()`, `sin()`, `progress()`, …)
//! as Blink 155 parses, simplifies and evaluates them:
//! css_math_expression_node.cc (parser :4368-5279, node creation and eager
//! simplification :1297-2490, evaluation :3195-3870) and, for relative color
//! channels, the float `CalculationValue` path (calculation_value.cc,
//! calculation_expression_node.cc).
//!
//! Not ported: MaybeSimplifySumOrProductNode / MaybeDistributeArithmeticOperation
//! (css_math_expression_node.cc:1111-1283). They only regroup terms that
//! cannot fold into one literal, so they change serialization and the order
//! of double additions, never validity.

use cssparser::{ParseError, ParseErrorKind, Parser, Token};

/// kMaxExpressionDepth (css_math_expression_node.h:61).
pub(crate) const MAX_EXPRESSION_DEPTH: u32 = 100;

/// CSSPrimitiveValue::UnitType, the units a math literal can carry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Unit {
  Number,
  Percent,
  Px,
  Cm,
  Mm,
  Q,
  In,
  Pt,
  Pc,
  Em,
  Rem,
  Ex,
  Rex,
  Ch,
  Rch,
  Ic,
  Ric,
  Lh,
  Rlh,
  Cap,
  Rcap,
  /// Viewport units (vw, svh, dvmin, …) with their axis.
  Viewport(ViewportUnit),
  /// Container units (cqw, cqmin, …).
  Container,
  Deg,
  Rad,
  Grad,
  Turn,
  S,
  Ms,
  Hz,
  Khz,
  Dppx,
  X,
  Dpi,
  Dpcm,
  /// `fr` and anything Blink knows but a math literal rejects.
  Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum ViewportUnit {
  Width,
  Height,
  Min,
  Max,
}

impl Unit {
  /// CSSPrimitiveValue::StringToUnitType: ASCII case-insensitive.
  fn from_name(name: &str) -> Option<Self> {
    use ViewportUnit::*;
    let lower = name.to_ascii_lowercase();
    Some(match lower.as_str() {
      "px" => Unit::Px,
      "cm" => Unit::Cm,
      "mm" => Unit::Mm,
      "q" => Unit::Q,
      "in" => Unit::In,
      "pt" => Unit::Pt,
      "pc" => Unit::Pc,
      "em" => Unit::Em,
      "rem" => Unit::Rem,
      "ex" => Unit::Ex,
      "rex" => Unit::Rex,
      "ch" => Unit::Ch,
      "rch" => Unit::Rch,
      "ic" => Unit::Ic,
      "ric" => Unit::Ric,
      "lh" => Unit::Lh,
      "rlh" => Unit::Rlh,
      "cap" => Unit::Cap,
      "rcap" => Unit::Rcap,
      // The writing mode is horizontal: inline = width, block = height.
      "vw" | "vi" | "svw" | "svi" | "lvw" | "lvi" | "dvw" | "dvi" => Unit::Viewport(Width),
      "vh" | "vb" | "svh" | "svb" | "lvh" | "lvb" | "dvh" | "dvb" => Unit::Viewport(Height),
      "vmin" | "svmin" | "lvmin" | "dvmin" => Unit::Viewport(Min),
      "vmax" | "svmax" | "lvmax" | "dvmax" => Unit::Viewport(Max),
      "cqw" | "cqh" | "cqi" | "cqb" | "cqmin" | "cqmax" => Unit::Container,
      "deg" => Unit::Deg,
      "rad" => Unit::Rad,
      "grad" => Unit::Grad,
      "turn" => Unit::Turn,
      "s" => Unit::S,
      "ms" => Unit::Ms,
      "hz" => Unit::Hz,
      "khz" => Unit::Khz,
      "dppx" => Unit::Dppx,
      "x" => Unit::X,
      "dpi" => Unit::Dpi,
      "dpcm" => Unit::Dpcm,
      "fr" => Unit::Other,
      _ => return None,
    })
  }

  /// UnitCategory (css_math_expression_node.cc:75-160).
  fn category(self) -> Category {
    match self {
      Unit::Number => Category::Number,
      Unit::Percent => Category::Percent,
      Unit::Px
      | Unit::Cm
      | Unit::Mm
      | Unit::Q
      | Unit::In
      | Unit::Pt
      | Unit::Pc
      | Unit::Em
      | Unit::Rem
      | Unit::Ex
      | Unit::Rex
      | Unit::Ch
      | Unit::Rch
      | Unit::Ic
      | Unit::Ric
      | Unit::Lh
      | Unit::Rlh
      | Unit::Cap
      | Unit::Rcap
      | Unit::Viewport(_)
      | Unit::Container => Category::Length,
      Unit::Deg | Unit::Rad | Unit::Grad | Unit::Turn => Category::Angle,
      Unit::S | Unit::Ms => Category::Time,
      Unit::Hz | Unit::Khz => Category::Frequency,
      Unit::Dppx | Unit::X | Unit::Dpi | Unit::Dpcm => Category::Resolution,
      Unit::Other => Category::Other,
    }
  }

  /// CSSPrimitiveValue::IsRelativeUnit (css_primitive_value.h:326-335).
  fn is_relative(self) -> bool {
    matches!(
      self,
      Unit::Percent
        | Unit::Em
        | Unit::Ex
        | Unit::Rem
        | Unit::Ch
        | Unit::Ic
        | Unit::Lh
        | Unit::Rex
        | Unit::Rch
        | Unit::Ric
        | Unit::Rlh
        | Unit::Cap
        | Unit::Rcap
        | Unit::Viewport(_)
        | Unit::Container
    )
  }

  /// UnitTypeToUnitCategory (css_primitive_value.cc:90-126): the units that
  /// convert to a canonical unit.
  fn unit_category(self) -> Option<Category> {
    Some(match self {
      Unit::Number => Category::Number,
      Unit::Percent => Category::Percent,
      Unit::Px | Unit::Cm | Unit::Mm | Unit::Q | Unit::In | Unit::Pt | Unit::Pc => Category::Length,
      Unit::S | Unit::Ms => Category::Time,
      Unit::Deg | Unit::Rad | Unit::Grad | Unit::Turn => Category::Angle,
      Unit::Hz | Unit::Khz => Category::Frequency,
      Unit::Dppx | Unit::X | Unit::Dpi | Unit::Dpcm => Category::Resolution,
      _ => return None,
    })
  }

  /// CanonicalUnitTypeForCategory (css_primitive_value.cc:566-590).
  fn canonical(self) -> Option<Unit> {
    Some(match self.unit_category()? {
      Category::Number => Unit::Number,
      Category::Length => Unit::Px,
      Category::Time => Unit::S,
      Category::Angle => Unit::Deg,
      Category::Frequency => Unit::Hz,
      Category::Resolution => Unit::Dppx,
      _ => return None,
    })
  }

  /// ConversionToCanonicalUnitsScaleFactor (css_primitive_value.cc:492-548),
  /// with the constants of css_resolution_units.h / resolution_units.h.
  fn canonical_factor(self) -> f64 {
    const PX_PER_INCH: f64 = 96.0;
    const PX_PER_CM: f64 = PX_PER_INCH / 2.54;
    match self {
      Unit::Ms => 0.001,
      Unit::Cm => PX_PER_CM,
      Unit::Dpcm => 1.0 / PX_PER_CM,
      Unit::Mm => PX_PER_CM / 10.0,
      Unit::Q => PX_PER_CM / 40.0,
      Unit::In => PX_PER_INCH,
      Unit::Dpi => 1.0 / PX_PER_INCH,
      Unit::Pt => PX_PER_INCH / 72.0,
      Unit::Pc => PX_PER_INCH / 6.0,
      Unit::Rad => 180.0 / std::f64::consts::PI,
      Unit::Grad => 0.9,
      Unit::Turn => 360.0,
      Unit::Khz => 1000.0,
      _ => 1.0,
    }
  }
}

/// CalculationResultCategory, in Blink's order (the table below indexes it).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Category {
  Number = 0,
  Length = 1,
  Percent = 2,
  LengthFunction = 3,
  Intermediate = 4,
  Angle = 5,
  Time = 6,
  Frequency = 7,
  Resolution = 8,
  Ident = 9,
  PercentAngle = 10,
  Other = 11,
}

/// kAddSubtractResult (css_math_expression_node.cc:1520-1568).
const ADD_SUBTRACT: [[Category; 11]; 11] = {
  use Category::*;
  [
    [
      Number, Other, Other, Other, Other, Other, Other, Other, Other, Other, Other,
    ],
    [
      Other,
      Length,
      LengthFunction,
      LengthFunction,
      Other,
      Other,
      Other,
      Other,
      Other,
      Other,
      Other,
    ],
    [
      Other,
      LengthFunction,
      Percent,
      LengthFunction,
      Other,
      PercentAngle,
      Other,
      Other,
      Other,
      Other,
      PercentAngle,
    ],
    [
      Other,
      LengthFunction,
      LengthFunction,
      LengthFunction,
      Other,
      Other,
      Other,
      Other,
      Other,
      Other,
      Other,
    ],
    [
      Other, Other, Other, Other, Other, Other, Other, Other, Other, Other, Other,
    ],
    [
      Other,
      Other,
      PercentAngle,
      Other,
      Other,
      Angle,
      Other,
      Other,
      Other,
      Other,
      PercentAngle,
    ],
    [
      Other, Other, Other, Other, Other, Other, Time, Other, Other, Other, Other,
    ],
    [
      Other, Other, Other, Other, Other, Other, Other, Frequency, Other, Other, Other,
    ],
    [
      Other, Other, Other, Other, Other, Other, Other, Other, Resolution, Other, Other,
    ],
    [
      Other, Other, Other, Other, Other, Other, Other, Other, Other, Other, Other,
    ],
    [
      Other,
      Other,
      PercentAngle,
      Other,
      Other,
      PercentAngle,
      Other,
      Other,
      Other,
      Other,
      PercentAngle,
    ],
  ]
};

fn add_subtract_category(a: Category, b: Category) -> Category {
  if a == Category::Other || b == Category::Other {
    return Category::Other;
  }
  ADD_SUBTRACT[a as usize][b as usize]
}

// CSSMathType::BaseType (css_math_expression_node.h:114-123).
const LENGTH: usize = 0;
const ANGLE: usize = 1;
const TIME: usize = 2;
const FREQUENCY: usize = 3;
const RESOLUTION: usize = 4;
const PERCENT: usize = 6;
const NUM_TYPES: usize = 7;

/// CSSMathType (css_math_expression_node.cc:284-592): typed arithmetic.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
struct MathType {
  invalid: bool,
  powers: [i8; NUM_TYPES],
  hint: Option<usize>,
}

impl MathType {
  const INVALID: Self = Self {
    invalid: true,
    powers: [0; NUM_TYPES],
    hint: None,
  };

  fn from_category(category: Category) -> Self {
    let mut t = Self::default();
    let base = match category {
      Category::Number => return t,
      Category::Length | Category::LengthFunction => LENGTH,
      Category::Percent => PERCENT,
      Category::Angle | Category::PercentAngle => ANGLE,
      Category::Time => TIME,
      Category::Frequency => FREQUENCY,
      Category::Resolution => RESOLUTION,
      // NOTREACHED in Blink.
      Category::Intermediate | Category::Ident | Category::Other => return Self::INVALID,
    };
    t.powers[base] = 1;
    if category == Category::LengthFunction {
      t.hint = Some(LENGTH);
    } else if category == Category::PercentAngle {
      t.hint = Some(ANGLE);
    }
    t
  }

  fn of(node: &Node) -> Self {
    match node {
      Node::Op(op) if op.op.is_arithmetic() => op.ty,
      _ => Self::from_category(node.category()),
    }
  }

  fn category(&self) -> Category {
    if self.invalid {
      return Category::Other;
    }
    let mut ty = 0;
    let mut sum: i16 = 0;
    for (i, &power) in self.powers.iter().enumerate() {
      if power == 0 {
        continue;
      }
      if sum != 0 {
        if i != PERCENT {
          return Category::Intermediate;
        }
        sum += power as i16;
        break;
      }
      ty = i;
      sum += power as i16;
    }
    if sum == 0 {
      return Category::Number;
    }
    if sum != 1 {
      return Category::Intermediate;
    }
    if self.hint.is_some() {
      return if self.powers[LENGTH] != 0 {
        Category::LengthFunction
      } else if self.powers[ANGLE] != 0 {
        Category::PercentAngle
      } else {
        Category::Other
      };
    }
    match ty {
      LENGTH => Category::Length,
      PERCENT => Category::Percent,
      ANGLE => Category::Angle,
      TIME => Category::Time,
      FREQUENCY => Category::Frequency,
      RESOLUTION => Category::Resolution,
      _ => Category::Other,
    }
  }

  fn is_intermediate(&self) -> bool {
    !self.invalid && self.category() == Category::Intermediate
  }

  fn apply_hint(&mut self, hint: usize) {
    if self.hint.is_some() {
      return;
    }
    self.hint = Some(hint);
    if hint != PERCENT {
      self.powers[hint] += self.powers[PERCENT];
      self.powers[PERCENT] = 0;
    }
  }

  fn share_hints(a: &mut Self, b: &mut Self) -> bool {
    if a.hint.is_some() && b.hint.is_some() && a.hint != b.hint {
      return false;
    }
    if let (Some(h), None) = (a.hint, b.hint) {
      b.apply_hint(h);
    }
    if let (None, Some(h)) = (a.hint, b.hint) {
      a.apply_hint(h);
    }
    true
  }

  fn add(mut a: Self, mut b: Self) -> Self {
    if a.invalid || b.invalid || !Self::share_hints(&mut a, &mut b) {
      return Self::INVALID;
    }
    if a == b {
      return a;
    }
    let contains_percent = a.powers[PERCENT] != 0 || b.powers[PERCENT] != 0;
    let other_than_percent =
      |t: &Self| t.powers[PERCENT] as i32 != t.powers.iter().map(|&p| p as i32).sum::<i32>();
    if contains_percent && (other_than_percent(&a) || other_than_percent(&b)) {
      for hint in 0..NUM_TYPES {
        if hint == PERCENT {
          continue;
        }
        let (mut ta, mut tb) = (a, b);
        ta.apply_hint(hint);
        tb.apply_hint(hint);
        if ta == tb {
          return ta;
        }
      }
    }
    Self::INVALID
  }

  fn multiply(mut a: Self, mut b: Self) -> Self {
    if a.invalid || b.invalid || !Self::share_hints(&mut a, &mut b) {
      return Self::INVALID;
    }
    for i in 0..NUM_TYPES {
      a.powers[i] = a.powers[i].wrapping_add(b.powers[i]);
    }
    a
  }

  fn negate(mut self) -> Self {
    for p in &mut self.powers {
      *p = p.wrapping_neg();
    }
    self
  }
}

/// ColorChannelKeyword: the channel names a relative color can use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Channel {
  A,
  B,
  C,
  G,
  H,
  L,
  R,
  S,
  W,
  X,
  Y,
  Z,
  Alpha,
}

impl Channel {
  pub(crate) fn from_ident(ident: &str) -> Option<Self> {
    Some(match ident.to_ascii_lowercase().as_str() {
      "a" => Self::A,
      "b" => Self::B,
      "c" => Self::C,
      "g" => Self::G,
      "h" => Self::H,
      "l" => Self::L,
      "r" => Self::R,
      "s" => Self::S,
      "w" => Self::W,
      "x" => Self::X,
      "y" => Self::Y,
      "z" => Self::Z,
      "alpha" => Self::Alpha,
      _ => return None,
    })
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Op {
  Add,
  Subtract,
  Multiply,
  Invert,
  Min,
  Max,
  Clamp,
  RoundNearest,
  RoundUp,
  RoundDown,
  RoundToZero,
  Mod,
  Rem,
  Log,
  Exp,
  Sqrt,
  Hypot,
  Abs,
  Sign,
  Progress,
  Pow,
  Sin,
  Cos,
  Tan,
  Asin,
  Acos,
  Atan,
  Atan2,
}

impl Op {
  fn is_arithmetic(self) -> bool {
    matches!(self, Op::Add | Op::Subtract | Op::Multiply | Op::Invert)
  }

  fn converts_rad_to_deg(self) -> bool {
    matches!(self, Op::Sin | Op::Cos | Op::Tan)
  }
}

/// A numeric literal (CSSMathExpressionNumericLiteral).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Literal {
  pub(crate) value: f64,
  pub(crate) unit: Unit,
}

#[derive(Clone, Debug)]
pub(crate) struct Operation {
  op: Op,
  operands: Vec<Node>,
  category: Category,
  ty: MathType,
  nested_intermediate: bool,
}

#[derive(Clone, Debug)]
pub(crate) enum Node {
  Literal(Literal),
  /// A color channel keyword of a relative color (kColorChannel context).
  Channel(Channel),
  /// `none` in clamp() (kClamp context).
  ClampNone,
  Op(Box<Operation>),
}

/// The relative-length sizes a calc() resolves against
/// (CSSLengthResolver::ZoomedComputedPixels, css_length_resolver.cc:155-306,
/// zoom 1). A canvas color has no element: every relative unit is 0.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Lengths {
  pub(crate) em: f64,
  pub(crate) rem: f64,
  pub(crate) ex: f64,
  pub(crate) rex: f64,
  pub(crate) ch: f64,
  pub(crate) rch: f64,
  pub(crate) ic: f64,
  pub(crate) ric: f64,
  pub(crate) cap: f64,
  pub(crate) rcap: f64,
  pub(crate) lh: f64,
  pub(crate) rlh: f64,
  pub(crate) viewport_width: f64,
  pub(crate) viewport_height: f64,
}

impl Lengths {
  fn px(&self, value: f64, unit: Unit) -> f64 {
    let size = match unit {
      Unit::Px => return value,
      Unit::Cm | Unit::Mm | Unit::Q | Unit::In | Unit::Pt | Unit::Pc => {
        return value * unit.canonical_factor();
      }
      Unit::Em => self.em,
      Unit::Rem => self.rem,
      Unit::Ex => self.ex,
      Unit::Rex => self.rex,
      Unit::Ch => self.ch,
      Unit::Rch => self.rch,
      Unit::Ic => self.ic,
      Unit::Ric => self.ric,
      Unit::Cap => self.cap,
      Unit::Rcap => self.rcap,
      Unit::Lh => self.lh,
      Unit::Rlh => self.rlh,
      Unit::Viewport(axis) => {
        let (w, h) = (self.viewport_width / 100.0, self.viewport_height / 100.0);
        match axis {
          ViewportUnit::Width => w,
          ViewportUnit::Height => h,
          ViewportUnit::Min => w.min(h),
          ViewportUnit::Max => w.max(h),
        }
      }
      // No container: the small viewport size, which is 0 here.
      Unit::Container => 0.0,
      _ => 0.0,
    };
    value * size
  }
}

impl Literal {
  /// CSSMathExpressionNumericLiteral's constructor
  /// (css_math_expression_node.cc:1310-1325): a dimension that converts to a
  /// canonical unit is stored in it.
  fn new(value: f64, unit: Unit) -> Self {
    let literal = Self { value, unit };
    if unit != Unit::Number
      && literal.can_eagerly_simplify()
      && let Some(canonical) = unit.canonical()
    {
      return Self {
        value: value * unit.canonical_factor(),
        unit: canonical,
      };
    }
    literal
  }

  fn category(&self) -> Category {
    self.unit.category()
  }

  fn can_eagerly_simplify(&self) -> bool {
    match self.category() {
      Category::Number
      | Category::Angle
      | Category::Time
      | Category::Frequency
      | Category::Resolution => true,
      Category::Length => !self.unit.is_relative(),
      _ => false,
    }
  }

  /// CSSMathExpressionNumericLiteral::ComputeValueInCanonicalUnit()
  /// (css_math_expression_node.cc:1404-1426).
  fn canonical_value(&self) -> Option<f64> {
    match self.category() {
      Category::Number | Category::Percent => Some(self.value),
      Category::Length if self.unit.is_relative() => None,
      Category::Length
      | Category::Angle
      | Category::Time
      | Category::Frequency
      | Category::Resolution => Some(self.value * self.unit.canonical_factor()),
      _ => None,
    }
  }

  /// CSSNumericLiteralValue::ComputeDegrees (css_numeric_literal_value.cc:95-111).
  pub(crate) fn degrees(&self) -> f64 {
    match self.unit {
      Unit::Rad => self.value * (180.0 / std::f64::consts::PI),
      Unit::Grad => self.value * (360.0 / 400.0),
      Unit::Turn => self.value * 360.0,
      _ => self.value,
    }
  }

  /// CSSMathExpressionNumericLiteral::ComputeDouble
  /// (css_math_expression_node.cc:1433-1457).
  fn compute_double(&self, lengths: &Lengths) -> f64 {
    match self.category() {
      Category::Length => lengths.px(self.value, self.unit),
      Category::Angle => self.degrees(),
      Category::Time if self.unit == Unit::Ms => self.value / 1000.0,
      Category::Resolution | Category::Frequency => self.value * self.unit.canonical_factor(),
      _ => self.value,
    }
  }
}

impl Node {
  pub(crate) fn category(&self) -> Category {
    match self {
      Node::Literal(l) => l.category(),
      Node::Channel(_) => Category::Number,
      Node::ClampNone => Category::Ident,
      Node::Op(op) => op.category,
    }
  }

  pub(crate) fn as_literal(&self) -> Option<&Literal> {
    match self {
      Node::Literal(l) => Some(l),
      _ => None,
    }
  }

  /// Whether a literal anywhere in the expression has a unit `f` accepts
  /// (callers use it to skip work, such as measuring a font, that only some
  /// units need).
  pub(crate) fn any_unit(&self, f: &impl Fn(Unit) -> bool) -> bool {
    match self {
      Node::Literal(l) => f(l.unit),
      Node::Channel(_) | Node::ClampNone => false,
      Node::Op(op) => op.operands.iter().any(|operand| operand.any_unit(f)),
    }
  }

  fn is_op(&self) -> bool {
    matches!(self, Node::Op(_))
  }

  fn nested_intermediate(&self) -> bool {
    matches!(self, Node::Op(op) if op.nested_intermediate)
  }

  /// InvolvesLayout (css_math_expression_node.h:299-301, .cc:2829-2839).
  fn involves_layout(&self) -> bool {
    match self {
      Node::Op(op) => {
        matches!(op.category, Category::Percent | Category::LengthFunction)
          || op.operands.iter().any(Node::involves_layout)
      }
      other => matches!(
        other.category(),
        Category::Percent | Category::LengthFunction
      ),
    }
  }

  /// CanEagerlySimplify (css_math_expression_node.cc:722-743).
  fn can_eagerly_simplify(&self) -> bool {
    match self {
      Node::Literal(l) => !self.involves_layout() && l.can_eagerly_simplify(),
      _ => false,
    }
  }

  /// ComputeValueInCanonicalUnit() without a length resolver.
  fn canonical_value(&self) -> Option<f64> {
    match self {
      Node::Literal(l) => l.canonical_value(),
      Node::Channel(_) | Node::ClampNone => None,
      Node::Op(op) => {
        if op.category != Category::Intermediate && !has_canonical_unit(op.category) {
          return None;
        }
        let values = op
          .operands
          .iter()
          .map(Node::canonical_value)
          .collect::<Option<Vec<_>>>()?;
        Some(evaluate_operator(&values, op.op))
      }
    }
  }

  /// ComputeDouble (css_math_expression_node.cc:1433-1457, 3259-3273): the
  /// value in its canonical unit, relative lengths resolved.
  pub(crate) fn compute_double(&self, lengths: &Lengths) -> f64 {
    match self {
      Node::Literal(l) => l.compute_double(lengths),
      // Only relative colors carry these, and they never come here.
      Node::Channel(_) | Node::ClampNone => 0.0,
      Node::Op(op) => {
        let values: Vec<f64> = op
          .operands
          .iter()
          .map(|operand| {
            let value = operand.compute_double(lengths);
            if op.op.converts_rad_to_deg() && operand.category() == Category::Number {
              rad_to_deg(value)
            } else {
              value
            }
          })
          .collect();
        evaluate_operator(&values, op.op)
      }
    }
  }
}

fn has_canonical_unit(category: Category) -> bool {
  matches!(
    category,
    Category::Number
      | Category::Length
      | Category::Percent
      | Category::Angle
      | Category::Time
      | Category::Frequency
      | Category::Resolution
  )
}

/// blink::Rad2deg(double) (math_extras.h:68-70).
fn rad_to_deg(r: f64) -> f64 {
  r * (180.0 / std::f64::consts::PI)
}

fn op_node(op: Op, operands: Vec<Node>, category: Category, ty: MathType) -> Node {
  let mut nested_intermediate = ty.is_intermediate();
  if op.is_arithmetic() {
    nested_intermediate |= operands.first().is_some_and(Node::nested_intermediate);
    nested_intermediate |= operands.last().is_some_and(Node::nested_intermediate);
  }
  Node::Op(Box::new(Operation {
    op,
    operands,
    category,
    ty,
    nested_intermediate,
  }))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Arith {
  Add,
  Subtract,
  Multiply,
  Divide,
}

fn literal(value: f64, unit: Unit) -> Node {
  Node::Literal(Literal::new(value, unit))
}

/// DetermineType (css_math_expression_node.cc:256-275).
fn determine_type(left: &Node, right: &Node, op: Arith) -> MathType {
  let (l, r) = (MathType::of(left), MathType::of(right));
  match op {
    Arith::Add | Arith::Subtract => MathType::add(l, r),
    Arith::Multiply => MathType::multiply(l, r),
    Arith::Divide => MathType::multiply(l, r.negate()),
  }
}

/// CreateInvertFunction (css_math_expression_node.cc:2267-2297).
fn create_invert(operand: Node) -> Node {
  if !operand.is_op()
    && operand.category() == Category::Number
    && let Some(v) = operand.canonical_value()
    && v != 0.0
  {
    return literal(1.0 / v, Unit::Number);
  }
  if let Node::Op(op) = &operand
    && op.op == Op::Invert
  {
    return op.operands[0].clone();
  }
  if operand.category() != Category::Number {
    let ty = MathType::of(&operand).negate();
    return op_node(Op::Invert, vec![operand], Category::Intermediate, ty);
  }
  op_node(
    Op::Invert,
    vec![operand],
    Category::Number,
    MathType::default(),
  )
}

/// CreateArithmeticOperation (css_math_expression_node.cc:1838-1876).
fn create_arithmetic(left: Node, right: Node, op: Arith) -> Option<Node> {
  let ty = determine_type(&left, &right, op);
  // CSSTypedArithmetic is stable.
  if ty.invalid {
    return None;
  }
  let category = ty.category();
  if category == Category::Other {
    return None;
  }
  let (op, right) = match op {
    Arith::Divide => {
      let inverted = create_invert(right);
      if left.category() == Category::Number && left.as_literal().is_some_and(|l| l.value == 1.0) {
        return Some(inverted);
      }
      (Op::Multiply, inverted)
    }
    Arith::Add => (Op::Add, right),
    Arith::Subtract => (Op::Subtract, right),
    Arith::Multiply => (Op::Multiply, right),
  };
  Some(op_node(op, vec![left, right], category, ty))
}

fn is_clamp_none(node: &Node) -> bool {
  matches!(node, Node::ClampNone)
}

/// CreateArithmeticOperationSimplified (css_math_expression_node.cc:2385-2487).
fn create_arithmetic_simplified(left: Node, right: Node, op: Arith) -> Option<Node> {
  if is_clamp_none(&left) || is_clamp_none(&right) {
    return None;
  }
  // CanArithmeticOperationBeSimplified (:2323-2345).
  let simplifiable = match (left.as_literal(), right.as_literal()) {
    (Some(l), Some(r)) => {
      let mul_div = matches!(op, Arith::Multiply | Arith::Divide);
      !(mul_div && l.category() != Category::Number && r.category() != Category::Number)
        && !determine_type(&left, &right, op).is_intermediate()
    }
    _ => false,
  };
  if !simplifiable {
    return create_arithmetic(left, right, op);
  }
  let (l, r) = (*left.as_literal()?, *right.as_literal()?);
  let eval = |a: f64, b: f64| {
    evaluate_operator(
      &[a, b],
      match op {
        Arith::Add => Op::Add,
        Arith::Subtract => Op::Subtract,
        Arith::Multiply => Op::Multiply,
        Arith::Divide => return divide(a, b),
      },
    )
  };
  if l.category() == Category::Number && r.category() == Category::Number {
    return Some(literal(eval(l.value, r.value), Unit::Number));
  }
  match op {
    Arith::Add | Arith::Subtract => {
      if l.category() == r.category() {
        if l.unit == r.unit {
          return Some(literal(eval(l.value, r.value), l.unit));
        }
        if let (Some(lc), Some(rc)) = (l.unit.unit_category(), r.unit.unit_category())
          && lc == rc
          && let Some(canonical) = l.unit.canonical()
        {
          return Some(literal(
            eval(
              l.value * l.unit.canonical_factor(),
              r.value * r.unit.canonical_factor(),
            ),
            canonical,
          ));
        }
      }
    }
    Arith::Multiply | Arith::Divide => {
      if r.category() != Category::Number && op == Arith::Divide {
        return None;
      }
      // GetNumericLiteralSide: the left side when it is a number.
      let (number, other) = if l.category() == Category::Number {
        (l, r)
      } else {
        (r, l)
      };
      return Some(literal(eval(other.value, number.value), other.unit));
    }
  }
  create_arithmetic(left, right, op)
}

fn divide(a: f64, b: f64) -> f64 {
  if a.is_nan() {
    return a;
  }
  if b.is_nan() {
    return b;
  }
  a / b
}

/// CreateComparisonFunction (css_math_expression_node.cc:1896-1941).
fn create_comparison(mut operands: Vec<Node>, op: Op) -> Option<Node> {
  if op == Op::Clamp {
    // MaybeSimplifyComparisonFunction (:759-794).
    let (min, val, max) = (&operands[0], &operands[1], &operands[2]);
    if is_clamp_none(val) {
      return None;
    }
    match (is_clamp_none(min), is_clamp_none(max)) {
      (true, true) => return Some(operands.swap_remove(1)),
      (true, false) => {
        let max = operands.pop()?;
        let val = operands.pop()?;
        return create_comparison(vec![val, max], Op::Min);
      }
      (false, true) => {
        operands.pop();
        return create_comparison(operands, Op::Max);
      }
      (false, false) => {}
    }
  }
  let category = comparison_category(&operands);
  if category == Category::Other {
    return None;
  }
  if operands.iter().all(Node::can_eagerly_simplify) {
    let values = operands
      .iter()
      .map(Node::canonical_value)
      .collect::<Option<Vec<_>>>()?;
    let unit = operands[0].as_literal()?.unit.canonical()?;
    return Some(literal(evaluate_operator(&values, op), unit));
  }
  if operands.len() == 1 {
    return operands.pop();
  }
  Some(op_node(op, operands, category, MathType::default()))
}

/// DetermineComparisonCategory (css_math_expression_node.cc:1606-1629).
fn comparison_category(operands: &[Node]) -> Category {
  let mut category = Category::Other;
  for (i, operand) in operands.iter().enumerate() {
    category = if i == 0 {
      operand.category()
    } else if category == Category::Other || operand.category() == Category::Other {
      Category::Other
    } else {
      ADD_SUBTRACT[category as usize][operand.category() as usize]
    };
    if category == Category::Other {
      break;
    }
  }
  category
}

/// CreateTrigonometricFunction (css_math_expression_node.cc:2040-2081).
fn create_trig(operands: Vec<Node>, op: Op) -> Option<Node> {
  let number_output = op.converts_rad_to_deg();
  if operands.len() == 1 {
    let c = operands[0].category();
    let ok = if number_output {
      c == Category::Number || c == Category::Angle
    } else {
      c == Category::Number
    };
    if !ok {
      return None;
    }
  } else if operands[0].category() != operands[1].category() {
    return None;
  }
  if !operands.iter().all(Node::can_eagerly_simplify) {
    let category = if number_output {
      Category::Number
    } else {
      Category::Angle
    };
    return Some(op_node(op, operands, category, MathType::default()));
  }
  let mut a = operands[0].canonical_value()?;
  if number_output && operands[0].category() == Category::Number {
    a = rad_to_deg(a);
  }
  let b = if op == Op::Atan2 {
    operands[1].canonical_value()
  } else {
    None
  };
  let value = trig_f64(op, a, b);
  Some(literal(
    value,
    if number_output {
      Unit::Number
    } else {
      Unit::Deg
    },
  ))
}

/// CreateSteppedValueFunction (css_math_expression_node.cc:2083-2112).
fn create_stepped(operands: Vec<Node>, op: Op) -> Option<Node> {
  let category = add_subtract_category(operands[0].category(), operands[1].category());
  if category == Category::Other {
    return None;
  }
  if operands.iter().all(Node::can_eagerly_simplify) {
    let a = operands[0].canonical_value()?;
    let b = operands[1].canonical_value()?;
    let unit = operands[0].as_literal()?.unit.canonical()?;
    return Some(literal(stepped_f64(op, a, b), unit));
  }
  Some(op_node(op, operands, category, MathType::default()))
}

/// CreateExponentialFunction (css_math_expression_node.cc:2114-2225).
fn create_exponential(operands: Vec<Node>, op: Op) -> Option<Node> {
  if operands[0].category() == Category::Intermediate {
    return None;
  }
  let number = |node: &Node| -> Option<f64> {
    if node.category() == Category::Number {
      node.as_literal().map(|l| l.value)
    } else {
      None
    }
  };
  let eager = operands.iter().all(Node::can_eagerly_simplify);
  let (value, unit) = match op {
    Op::Pow => {
      if comparison_category(&operands) != Category::Number {
        return None;
      }
      if !eager {
        return Some(op_node(op, operands, Category::Number, MathType::default()));
      }
      let a = operands[0].canonical_value()?;
      let b = operands[1].canonical_value()?;
      (a.powf(b), Unit::Number)
    }
    Op::Sqrt => {
      if !operands[0].can_eagerly_simplify() {
        let category = operands[0].category();
        return Some(op_node(op, operands, category, MathType::default()));
      }
      (number(&operands[0])?.sqrt(), Unit::Number)
    }
    Op::Hypot => {
      let category = comparison_category(&operands);
      if category == Category::Other {
        return None;
      }
      if !eager {
        return Some(op_node(op, operands, category, MathType::default()));
      }
      let mut value = 0.0_f64;
      for operand in &operands {
        value = value.hypot(operand.canonical_value()?);
      }
      (value, operands[0].as_literal()?.unit.canonical()?)
    }
    Op::Log => {
      if operands[0].category() != Category::Number
        || operands[operands.len() - 1].category() != Category::Number
      {
        return None;
      }
      if !eager {
        return Some(op_node(op, operands, Category::Number, MathType::default()));
      }
      let a = number(&operands[0])?;
      if operands.len() == 2 {
        (a.log2() / number(&operands[1])?.log2(), Unit::Number)
      } else {
        (a.ln(), Unit::Number)
      }
    }
    Op::Exp => {
      if !operands[0].can_eagerly_simplify() {
        return Some(op_node(op, operands, Category::Number, MathType::default()));
      }
      (number(&operands[0])?.exp(), Unit::Number)
    }
    _ => return None,
  };
  Some(literal(value, unit))
}

/// CreateSignRelatedFunction (css_math_expression_node.cc:2227-2265).
fn create_sign_related(mut operands: Vec<Node>, op: Op) -> Option<Node> {
  let operand = operands.pop()?;
  if MathType::of(&operand).is_intermediate() {
    return None;
  }
  let eager = operand.can_eagerly_simplify();
  match op {
    Op::Abs => {
      if eager {
        let l = *operand.as_literal()?;
        return Some(literal(l.canonical_value()?.abs(), l.unit));
      }
      let category = operand.category();
      Some(op_node(op, vec![operand], category, MathType::default()))
    }
    _ => {
      if eager {
        return Some(literal(sign(operand.canonical_value()?), Unit::Number));
      }
      Some(op_node(
        op,
        vec![operand],
        Category::Number,
        MathType::default(),
      ))
    }
  }
}

/// EvaluateSignFunction (math_functions.h:279-283).
fn sign<T: num_traits_lite::Float>(v: T) -> T {
  if v == T::ZERO || v.is_nan() {
    v
  } else if v > T::ZERO {
    T::ONE
  } else {
    -T::ONE
  }
}

/// The few float operations the double and float evaluators share.
mod num_traits_lite {
  pub(crate) trait Float:
    Copy
    + PartialOrd
    + std::ops::Neg<Output = Self>
    + std::ops::Add<Output = Self>
    + std::ops::Sub<Output = Self>
    + std::ops::Div<Output = Self>
    + std::ops::Rem<Output = Self>
  {
    const ZERO: Self;
    const ONE: Self;
    const TWO: Self;
    const NAN: Self;
    const INFINITY: Self;
    fn is_nan(self) -> bool;
    fn is_infinite(self) -> bool;
    fn abs(self) -> Self;
    fn is_sign_negative(self) -> bool;
    fn copysign(self, sign: Self) -> Self;
  }

  macro_rules! float {
    ($t:ty) => {
      impl Float for $t {
        const ZERO: Self = 0.0;
        const ONE: Self = 1.0;
        const TWO: Self = 2.0;
        const NAN: Self = <$t>::NAN;
        const INFINITY: Self = <$t>::INFINITY;
        fn is_nan(self) -> bool {
          <$t>::is_nan(self)
        }
        fn is_infinite(self) -> bool {
          <$t>::is_infinite(self)
        }
        fn abs(self) -> Self {
          <$t>::abs(self)
        }
        fn is_sign_negative(self) -> bool {
          <$t>::is_sign_negative(self)
        }
        fn copysign(self, sign: Self) -> Self {
          <$t>::copysign(self, sign)
        }
      }
    };
  }
  float!(f32);
  float!(f64);
}

use num_traits_lite::Float;

/// GetNearestMultiples (math_functions.h:24-55).
fn nearest_multiples<T: Float>(a: T, b: T) -> (T, T) {
  let is_negative = a < T::ZERO;
  let mut a = a.abs();
  let mut b = b.abs();
  let mut c = -(a % b);
  let lower = a + c;
  if a.abs() > c.abs() {
    std::mem::swap(&mut a, &mut c);
  }
  if a.abs() > b.abs() {
    std::mem::swap(&mut a, &mut b);
  }
  if b.abs() > c.abs() {
    std::mem::swap(&mut b, &mut c);
  }
  let upper = a + b + c;
  if is_negative {
    (-upper, -lower)
  } else {
    (lower, upper)
  }
}

/// EvaluateSteppedValueFunction (math_functions.h:57-277).
fn stepped<T: Float>(op: Op, a: T, b: T) -> T {
  // PreCheckSteppedValueFunctionArguments.
  if b == T::ZERO || (a.is_infinite() && b.is_infinite()) {
    return T::NAN;
  }
  let rounding = matches!(
    op,
    Op::RoundNearest | Op::RoundUp | Op::RoundDown | Op::RoundToZero
  );
  if rounding && (a % b == T::ZERO || (a.is_infinite() && !b.is_infinite())) {
    return a;
  }
  if matches!(op, Op::Mod | Op::Rem) && a.is_infinite() {
    return T::NAN;
  }
  let signed_zero = |negative: bool| if negative { -T::ZERO } else { T::ZERO };
  let (lower, upper) = nearest_multiples(a, b);
  match op {
    Op::RoundNearest => {
      if !a.is_infinite() && b.is_infinite() {
        return signed_zero(a.is_sign_negative());
      }
      let negative = a < T::ZERO;
      let (lower, upper) = if negative {
        (upper, lower)
      } else {
        (lower, upper)
      };
      let distance = (a % b).abs();
      let half_b = b.abs() / T::TWO;
      if distance < half_b || (negative && distance == half_b) {
        lower
      } else {
        upper
      }
    }
    Op::RoundUp => {
      if !a.is_infinite() && b.is_infinite() {
        if a == T::ZERO {
          a
        } else if a.is_sign_negative() {
          -T::ZERO
        } else {
          T::INFINITY
        }
      } else {
        upper
      }
    }
    Op::RoundDown => {
      // EvaluateRoundDownFunction.
      if !a.is_infinite() && b.is_infinite() {
        if a == T::ZERO {
          a
        } else if a.is_sign_negative() {
          -T::INFINITY
        } else {
          T::ZERO
        }
      } else {
        lower
      }
    }
    Op::RoundToZero => {
      if !a.is_infinite() && b.is_infinite() {
        signed_zero(a.is_sign_negative())
      } else if upper.abs() < lower.abs() {
        upper
      } else {
        lower
      }
    }
    Op::Mod => {
      if b.is_infinite() && a.is_sign_negative() != b.is_sign_negative() {
        return T::NAN;
      }
      let result = a % b;
      if result == T::ZERO {
        return T::ZERO.copysign(b);
      }
      if result.is_sign_negative() != b.is_sign_negative() {
        return result + b;
      }
      result
    }
    _ => a % b,
  }
}

fn stepped_f64(op: Op, a: f64, b: f64) -> f64 {
  stepped(op, a, b)
}

/// gfx::SinCosDegrees (ui/gfx/geometry/sin_cos_degrees.h:24-102).
fn sin_cos_degrees(mut degrees: f64) -> (f64, f64) {
  if degrees > -90000000.0 && degrees < 90000000.0 {
    let n45degrees = degrees / 45.0;
    let mut octant = n45degrees as i32;
    if octant as f64 == n45degrees {
      const S: f64 = std::f64::consts::SQRT_2 / 2.0;
      const TABLE: [(f64, f64); 8] = [
        (0.0, 1.0),
        (S, S),
        (1.0, 0.0),
        (S, -S),
        (0.0, -1.0),
        (-S, -S),
        (-1.0, 0.0),
        (-S, S),
      ];
      return TABLE[(octant & 7) as usize];
    }
    if degrees < 0.0 {
      octant -= 1;
    }
    degrees -= octant as f64 * 45.0;
    if octant & 1 != 0 {
      degrees = 45.0 - degrees;
    }
    // base::DegToRad: deg * pi / 180.
    let rad = degrees * std::f64::consts::PI / 180.0;
    let (mut s, mut c) = (rad.sin(), rad.cos());
    if (octant + 1) & 2 != 0 {
      std::mem::swap(&mut s, &mut c);
    }
    if octant & 4 != 0 {
      s = -s;
    }
    if (octant + 2) & 4 != 0 {
      c = -c;
    }
    return (s, c);
  }
  let degrees = degrees % 360.0;
  let rad = degrees * std::f64::consts::PI / 180.0;
  (rad.sin(), rad.cos())
}

/// TanDegrees (math_functions.h:84-108) for doubles.
fn tan_degrees_f64(degrees: f64) -> f64 {
  if degrees > -90000000.0 && degrees < 90000000.0 {
    let n45degrees = degrees / 45.0;
    let octant = n45degrees as i32;
    if octant as f64 == n45degrees {
      const TABLE: [f64; 8] = [
        0.0,
        1.0,
        f64::INFINITY,
        -1.0,
        0.0,
        1.0,
        f64::NEG_INFINITY,
        -1.0,
      ];
      return TABLE[(octant & 7) as usize];
    }
  }
  // blink::Deg2rad(double): d * (pi / 180).
  (degrees * (std::f64::consts::PI / 180.0)).tan()
}

/// EvaluateTrigonometricFunction (math_functions.h:110-155) for doubles.
fn trig_f64(op: Op, a: f64, b: Option<f64>) -> f64 {
  match op {
    Op::Sin => sin_cos_degrees(a).0,
    Op::Cos => sin_cos_degrees(a).1,
    Op::Tan => tan_degrees_f64(a),
    Op::Asin => rad_to_deg(a.asin()),
    Op::Acos => rad_to_deg(a.acos()),
    Op::Atan => rad_to_deg(a.atan()),
    _ => rad_to_deg(a.atan2(b.unwrap_or(f64::NAN))),
  }
}

/// CSSMathExpressionOperation::EvaluateOperator
/// (css_math_expression_node.cc:3700-3869).
fn evaluate_operator(operands: &[f64], op: Op) -> f64 {
  if let Some(&nan) = operands.iter().find(|v| v.is_nan()) {
    return nan;
  }
  match op {
    Op::Add => operands[0] + operands[1],
    Op::Subtract => operands[0] - operands[1],
    Op::Multiply => operands[0] * operands[1],
    Op::Invert => 1.0 / operands[0],
    Op::Min => {
      let mut minimum = operands[0];
      for &operand in operands {
        if minimum == 0.0
          && operand == 0.0
          && minimum.is_sign_negative() != operand.is_sign_negative()
        {
          minimum = -0.0;
          continue;
        }
        // std::min(a, b) = (b < a) ? b : a.
        if operand < minimum {
          minimum = operand;
        }
      }
      minimum
    }
    Op::Max => {
      let mut maximum = operands[0];
      for &operand in operands {
        if maximum == 0.0
          && operand == 0.0
          && maximum.is_sign_negative() != operand.is_sign_negative()
        {
          maximum = 0.0;
          continue;
        }
        // std::max(a, b) = (a < b) ? b : a.
        if maximum < operand {
          maximum = operand;
        }
      }
      maximum
    }
    Op::Clamp => {
      let (min, val, max) = (operands[0], operands[1], operands[2]);
      let mut minimum = if max < val { max } else { val };
      if val == 0.0 && max == 0.0 && !val.is_sign_negative() && max.is_sign_negative() {
        minimum = -0.0;
      }
      let mut maximum = if min < minimum { minimum } else { min };
      if min == 0.0 && minimum == 0.0 && min.is_sign_negative() && !minimum.is_sign_negative() {
        maximum = 0.0;
      }
      maximum
    }
    Op::RoundNearest | Op::RoundUp | Op::RoundDown | Op::RoundToZero | Op::Mod | Op::Rem => {
      stepped_f64(op, operands[0], operands[1])
    }
    Op::Exp => operands[0].exp(),
    Op::Log => {
      if operands.len() == 2 {
        operands[0].log2() / operands[1].log2()
      } else {
        operands[0].ln()
      }
    }
    Op::Sqrt => operands[0].sqrt(),
    Op::Hypot => operands
      .iter()
      .fold(0.0, |value, &operand| value.hypot(operand)),
    Op::Abs => operands[0].abs(),
    Op::Sign => sign(operands[0]),
    Op::Progress => {
      let value = (operands[0] - operands[1]) / (operands[2] - operands[1]);
      if value.is_nan() {
        f64::NAN
      } else {
        value.clamp(0.0, 1.0)
      }
    }
    Op::Pow => operands[0].powf(operands[1]),
    Op::Sin | Op::Cos | Op::Tan | Op::Asin | Op::Acos | Op::Atan => trig_f64(op, operands[0], None),
    Op::Atan2 => trig_f64(op, operands[0], Some(operands[1])),
  }
}

// ---------------------------------------------------------------------------
// Parsing (CSSMathExpressionNodeParser, css_math_expression_node.cc:4368-5279)
// ---------------------------------------------------------------------------

/// The parsing flags and the relative color channel map of one parse.
#[derive(Clone, Copy)]
pub(crate) struct MathOptions<'a> {
  /// Flag::AllowPercent.
  pub(crate) allow_percent: bool,
  /// The keys of the color channel map (empty outside relative colors).
  pub(crate) channels: &'a [Channel],
}

#[derive(Clone, Copy)]
struct State {
  depth: u32,
  allow_clamp_none: bool,
}

/// The function names CSSMathExpressionNodeParser::IsSupportedMathFunction
/// accepts in Chrome 155 (progress() is stable; random(), media-progress()
/// and container-progress() are not; anchor(), anchor-size(), calc-size(),
/// sibling-index() and sibling-count() never parse in a canvas color).
fn math_function_op(name: &str) -> Option<&'static str> {
  let lower = name.to_ascii_lowercase();
  Some(match lower.as_str() {
    "calc" | "-webkit-calc" => "calc",
    "min" => "min",
    "max" => "max",
    "clamp" => "clamp",
    "sin" => "sin",
    "cos" => "cos",
    "tan" => "tan",
    "asin" => "asin",
    "acos" => "acos",
    "atan" => "atan",
    "atan2" => "atan2",
    "round" => "round",
    "mod" => "mod",
    "rem" => "rem",
    "pow" => "pow",
    "sqrt" => "sqrt",
    "hypot" => "hypot",
    "log" => "log",
    "exp" => "exp",
    "abs" => "abs",
    "sign" => "sign",
    "progress" => "progress",
    _ => return None,
  })
}

/// The error a `parse_nested_block` closure returns when its own parse
/// fails (the caller only needs to know that it failed).
pub(crate) fn custom_error() -> ParseError<()> {
  ParseError {
    kind: ParseErrorKind::Custom(()),
  }
}

/// Whether `name` is a function the math parser starts on (callers use it to
/// decide between a math function and other syntax).
pub(crate) fn is_math_function(name: &str) -> bool {
  math_function_op(name).is_some()
}

/// The CSS number at the start of a numeric token's source text, as Blink's
/// tokenizer reads it: a double, correctly rounded (css_tokenizer.cc:303-361).
pub(crate) fn token_number(source: &str) -> f64 {
  let bytes = source.as_bytes();
  let mut end = 0;
  if matches!(bytes.first(), Some(b'+' | b'-')) {
    end += 1;
  }
  while end < bytes.len() && bytes[end].is_ascii_digit() {
    end += 1;
  }
  if end + 1 < bytes.len() && bytes[end] == b'.' && bytes[end + 1].is_ascii_digit() {
    end += 1;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
      end += 1;
    }
  }
  if end < bytes.len() && matches!(bytes[end], b'e' | b'E') {
    let mut e = end + 1;
    if e < bytes.len() && matches!(bytes[e], b'+' | b'-') {
      e += 1;
    }
    if e < bytes.len() && bytes[e].is_ascii_digit() {
      while e < bytes.len() && bytes[e].is_ascii_digit() {
        e += 1;
      }
      end = e;
    }
  }
  source[..end].parse::<f64>().unwrap_or(f64::NAN)
}

/// The next token (skipping whitespace and comments) and its source text.
pub(crate) fn next_token<'i>(p: &mut Parser<'i>) -> Option<(Token<'i>, &'i str)> {
  p.skip_whitespace();
  let start = p.position();
  let token = p.next().ok()?.clone();
  Some((token, p.slice_from(start)))
}

/// The next token without consuming it.
pub(crate) fn peek<'i>(p: &mut Parser<'i>) -> Option<Token<'i>> {
  let state = p.state();
  let token = p.next().ok().cloned();
  p.reset(&state);
  token
}

/// Whether the next token (comments skipped) is whitespace.
fn whitespace_follows(p: &mut Parser<'_>) -> bool {
  let state = p.state();
  let ws = matches!(p.next_including_whitespace(), Ok(Token::WhiteSpace(_)));
  p.reset(&state);
  ws
}

/// A numeric token as a math literal value, or None when it is not numeric.
pub(crate) fn numeric_token(token: &Token<'_>, source: &str) -> Option<(f64, Option<Unit>)> {
  match token {
    Token::Number { .. } => Some((token_number(source), Some(Unit::Number))),
    Token::Percentage { .. } => Some((token_number(source), Some(Unit::Percent))),
    Token::Dimension { unit, .. } => Some((token_number(source), Unit::from_name(unit))),
    _ => None,
  }
}

/// CSSMathExpressionNode::ParseMathFunction (css_math_expression_node.cc:5570-5586).
/// `p` is inside the function's block; the result must reach its end.
pub(crate) fn parse_math_function(
  p: &mut Parser<'_>,
  name: &str,
  options: MathOptions<'_>,
) -> Option<Node> {
  let state = State {
    depth: 0,
    allow_clamp_none: false,
  };
  parse_function(p, name, state, &options)
}

/// CSSMathExpressionNodeParser::ParseMathFunction (:4743-4985).
fn parse_function(
  p: &mut Parser<'_>,
  name: &str,
  mut state: State,
  options: &MathOptions<'_>,
) -> Option<Node> {
  state.allow_clamp_none = false;
  let function = math_function_op(name)?;
  if function == "progress" {
    return parse_progress(p, state, options);
  }
  let (mut min_args, mut max_args) = (1usize, usize::MAX);
  match function {
    "calc" => max_args = 1,
    "clamp" => {
      min_args = 3;
      max_args = 3;
      state.allow_clamp_none = true;
    }
    "sin" | "cos" | "tan" | "asin" | "acos" | "atan" | "exp" | "sqrt" => max_args = 1,
    "pow" | "mod" | "rem" | "atan2" => {
      min_args = 2;
      max_args = 2;
    }
    "hypot" => max_args = MAX_EXPRESSION_DEPTH as usize,
    "log" | "round" => max_args = 2,
    "abs" | "sign" => max_args = 1,
    _ => {}
  }
  let mut rounding = Op::RoundNearest;
  if function == "round" {
    // ParseRoundingStrategy (:5030-5052).
    if let Some(Token::Ident(ident)) = peek(p) {
      let strategy = match ident.to_ascii_lowercase().as_str() {
        "nearest" => Some(Op::RoundNearest),
        "up" => Some(Op::RoundUp),
        "down" => Some(Op::RoundDown),
        "to-zero" => Some(Op::RoundToZero),
        _ => None,
      };
      if let Some(strategy) = strategy {
        p.next().ok()?;
        rounding = strategy;
        if !matches!(p.next(), Ok(Token::Comma)) {
          return None;
        }
      }
    }
  }
  let mut nodes = Vec::new();
  while !p.is_exhausted() && nodes.len() < max_args {
    if !nodes.is_empty() && !matches!(p.next(), Ok(Token::Comma)) {
      return None;
    }
    nodes.push(parse_value_expression(p, state, options)?);
  }
  if !p.is_exhausted() || nodes.len() < min_args {
    return None;
  }
  match function {
    "calc" => nodes.pop(),
    "min" => create_comparison(nodes, Op::Min),
    "max" => create_comparison(nodes, Op::Max),
    "clamp" => create_comparison(nodes, Op::Clamp),
    "sin" => create_trig(nodes, Op::Sin),
    "cos" => create_trig(nodes, Op::Cos),
    "tan" => create_trig(nodes, Op::Tan),
    "asin" => create_trig(nodes, Op::Asin),
    "acos" => create_trig(nodes, Op::Acos),
    "atan" => create_trig(nodes, Op::Atan),
    "atan2" => create_trig(nodes, Op::Atan2),
    "pow" => create_exponential(nodes, Op::Pow),
    "sqrt" => create_exponential(nodes, Op::Sqrt),
    "hypot" => create_exponential(nodes, Op::Hypot),
    "log" => create_exponential(nodes, Op::Log),
    "exp" => create_exponential(nodes, Op::Exp),
    "round" | "mod" | "rem" => {
      let op = match function {
        "mod" => Op::Mod,
        "rem" => Op::Rem,
        _ => {
          // CanonicalizeRoundArguments (:1951-1967).
          if nodes.len() == 1 {
            if nodes[0].category() != Category::Number {
              return None;
            }
            nodes.push(literal(1.0, Unit::Number));
          }
          rounding
        }
      };
      if nodes.iter().any(|n| n.category() == Category::Other) {
        return None;
      }
      create_stepped(nodes, op)
    }
    "abs" => create_sign_related(nodes, Op::Abs),
    "sign" => create_sign_related(nodes, Op::Sign),
    _ => None,
  }
}

/// ParseProgressNotation (:4486-4573), progress() only.
fn parse_progress(p: &mut Parser<'_>, state: State, options: &MathOptions<'_>) -> Option<Node> {
  let mut nodes = Vec::new();
  nodes.push(parse_value_expression(p, state, options)?);
  for _ in 0..2 {
    if !matches!(p.next(), Ok(Token::Comma)) {
      return None;
    }
    nodes.push(parse_value_expression(p, state, options)?);
  }
  if !p.is_exhausted() {
    return None;
  }
  // CheckProgressFunctionTypes (:672-720).
  let first = nodes[0].category();
  if first == Category::Intermediate || first != nodes[1].category() || first != nodes[2].category()
  {
    return None;
  }
  // CanEagerlySimplifyProgressArgs (:796-834).
  let literals: Option<Vec<Literal>> = nodes.iter().map(|n| n.as_literal().copied()).collect();
  if let Some(literals) = literals {
    let values = if literals.iter().all(|l| l.canonical_value().is_some()) {
      Some(
        literals
          .iter()
          .map(|l| l.canonical_value().unwrap())
          .collect::<Vec<_>>(),
      )
    } else if literals.iter().all(|l| l.unit == literals[0].unit) {
      Some(literals.iter().map(|l| l.value).collect())
    } else {
      None
    };
    if let Some(v) = values {
      let mut value = (v[0] - v[1]) / (v[2] - v[1]);
      if !value.is_nan() {
        value = value.clamp(0.0, 1.0);
      }
      return Some(literal(value, Unit::Number));
    }
  }
  Some(op_node(
    Op::Progress,
    nodes,
    Category::Number,
    MathType::default(),
  ))
}

/// ParseValueExpression (:5263-5269).
fn parse_value_expression(
  p: &mut Parser<'_>,
  mut state: State,
  options: &MathOptions<'_>,
) -> Option<Node> {
  state.depth += 1;
  if state.depth > MAX_EXPRESSION_DEPTH {
    return None;
  }
  parse_additive(p, state, options)
}

/// ParseAdditiveValueExpression (:5168-5249).
fn parse_additive(p: &mut Parser<'_>, state: State, options: &MathOptions<'_>) -> Option<Node> {
  if p.is_exhausted() {
    return None;
  }
  let mut whitespace_after = false;
  let mut result = parse_multiplicative(p, state, options, &mut whitespace_after)?;
  let mut depth = state.depth + 1;
  while !p.is_exhausted() {
    let op = match peek(p) {
      Some(Token::Delim('+')) => Arith::Add,
      Some(Token::Delim('-')) => Arith::Subtract,
      _ => break,
    };
    if !whitespace_after {
      return None;
    }
    p.next().ok()?;
    if !whitespace_follows(p) {
      return None;
    }
    let rhs = parse_multiplicative(p, state, options, &mut whitespace_after)?;
    result = create_arithmetic_simplified(result, rhs, op)?;
    if result.is_op() {
      depth += 1;
      if depth > MAX_EXPRESSION_DEPTH {
        return None;
      }
    } else {
      depth = state.depth + 1;
    }
  }
  Some(result)
}

/// ParseValueMultiplicativeExpression (:5101-5166).
fn parse_multiplicative(
  p: &mut Parser<'_>,
  state: State,
  options: &MathOptions<'_>,
  whitespace_after: &mut bool,
) -> Option<Node> {
  if p.is_exhausted() {
    return None;
  }
  let mut result = parse_value_term(p, state, options, whitespace_after)?;
  let mut depth = state.depth + 1;
  while !p.is_exhausted() {
    let op = match peek(p) {
      Some(Token::Delim('*')) => Arith::Multiply,
      Some(Token::Delim('/')) => Arith::Divide,
      _ => break,
    };
    p.next().ok()?;
    let rhs = parse_value_term(p, state, options, whitespace_after)?;
    result = create_arithmetic_simplified(result, rhs, op)?;
    if result.is_op() {
      depth += 1;
      if depth > MAX_EXPRESSION_DEPTH {
        return None;
      }
    } else {
      depth = state.depth + 1;
    }
  }
  Some(result)
}

/// ParseValueTerm (:5054-5099).
fn parse_value_term(
  p: &mut Parser<'_>,
  state: State,
  options: &MathOptions<'_>,
  whitespace_after: &mut bool,
) -> Option<Node> {
  if p.is_exhausted() {
    return None;
  }
  let (token, source) = next_token(p)?;
  let result = match &token {
    Token::ParenthesisBlock => p
      .parse_nested_block(|q| {
        let node = parse_value_expression(q, state, options).filter(|n| !is_clamp_none(n));
        node.ok_or_else(custom_error)
      })
      .ok()?,
    Token::Function(name) => {
      let name = name.clone();
      if name.eq_ignore_ascii_case("calc") {
        p.parse_nested_block(|q| {
          let node = parse_value_expression(q, state, options).filter(|n| !is_clamp_none(n));
          node.ok_or_else(custom_error)
        })
        .ok()?
      } else {
        p.parse_nested_block(|q| parse_function(q, &name, state, options).ok_or_else(custom_error))
          .ok()?
      }
    }
    Token::SquareBracketBlock | Token::CurlyBracketBlock => return None,
    _ => {
      let node = parse_value(&token, source, state, options);
      *whitespace_after = whitespace_follows(p);
      return node;
    }
  };
  *whitespace_after = whitespace_follows(p);
  Some(result)
}

/// ParseValue (:4987-5028).
fn parse_value(
  token: &Token<'_>,
  source: &str,
  state: State,
  options: &MathOptions<'_>,
) -> Option<Node> {
  if let Token::Ident(ident) = token {
    match ident.to_ascii_lowercase().as_str() {
      "infinity" => return Some(literal(f64::INFINITY, Unit::Number)),
      "-infinity" => return Some(literal(f64::NEG_INFINITY, Unit::Number)),
      "nan" => return Some(literal(f64::NAN, Unit::Number)),
      "pi" => return Some(literal(std::f64::consts::PI, Unit::Number)),
      "e" => return Some(literal(std::f64::consts::E, Unit::Number)),
      "none" if state.allow_clamp_none => return Some(Node::ClampNone),
      _ => {}
    }
  }
  let numeric = match token {
    Token::Percentage { .. } if !options.allow_percent => None,
    _ => numeric_token(token, source),
  };
  let Some((value, unit)) = numeric else {
    // Relative color channel keywords.
    if let Token::Ident(ident) = token
      && let Some(channel) = Channel::from_ident(ident)
      && options.channels.contains(&channel)
    {
      return Some(Node::Channel(channel));
    }
    return None;
  };
  let unit = unit?;
  if unit.category() == Category::Other {
    return None;
  }
  Some(literal(value, unit))
}

// ---------------------------------------------------------------------------
// The float CalculationValue path of relative color channels
// (CSSMathExpressionNode::ToCalcValue :5281-5312, CalculationValue::Evaluate)
// ---------------------------------------------------------------------------

/// PixelsAndPercent (length.h:43-95).
#[derive(Clone, Copy, Debug, PartialEq)]
struct PixelsAndPercent {
  pixels: f32,
  percent: f32,
}

/// CalculationExpressionNode.
#[derive(Clone, Debug)]
enum CalcNode {
  Number(f32),
  PixelsAndPercent(PixelsAndPercent),
  Channel(Channel),
  Op(Op, Vec<CalcNode>),
}

/// The channel values a relative color evaluates against.
pub(crate) type ChannelValues<'a> = &'a [(Channel, f32)];

/// ClampTo<float>(double) / ClampTo<float>(float): NaN passes.
fn clamp_to_float(v: f64) -> f32 {
  if v >= f32::MAX as f64 {
    f32::MAX
  } else if v <= f32::MIN as f64 {
    f32::MIN
  } else {
    v as f32
  }
}

/// CSSValueClampingUtils::ClampLength(float).
fn clamp_length(v: f32) -> f32 {
  if v.is_nan() {
    0.0
  } else {
    clamp_to_float(v as f64)
  }
}

/// CSSValueClampingUtils::ClampDouble.
fn clamp_double(v: f64) -> f64 {
  if v.is_nan() {
    0.0
  } else {
    v.clamp(f64::MIN, f64::MAX)
  }
}

fn rad_to_deg_f32(r: f32) -> f32 {
  r * (180.0_f32 / std::f32::consts::PI)
}

impl Node {
  /// ToPixelsAndPercent (:1340-1373, 2925-3007).
  fn to_pixels_and_percent(&self, lengths: &Lengths) -> Option<PixelsAndPercent> {
    match self {
      Node::Literal(l) => match l.category() {
        Category::Length => Some(PixelsAndPercent {
          pixels: lengths.px(l.value, l.unit) as f32,
          percent: 0.0,
        }),
        Category::Percent => Some(PixelsAndPercent {
          pixels: 0.0,
          percent: l.value as f32,
        }),
        Category::Number | Category::Angle => Some(PixelsAndPercent {
          pixels: clamp_to_float(clamp_double(l.value)),
          percent: 0.0,
        }),
        _ => None,
      },
      Node::Channel(_) | Node::ClampNone => None,
      Node::Op(op) => match op.op {
        Op::Add | Op::Subtract => {
          let a = op.operands[0].to_pixels_and_percent(lengths)?;
          let b = op.operands[1].to_pixels_and_percent(lengths)?;
          Some(if op.op == Op::Add {
            PixelsAndPercent {
              pixels: a.pixels + b.pixels,
              percent: a.percent + b.percent,
            }
          } else {
            PixelsAndPercent {
              pixels: a.pixels - b.pixels,
              percent: a.percent - b.percent,
            }
          })
        }
        Op::Multiply => {
          let (number, other) = match (&op.operands[0], &op.operands[1]) {
            (Node::Literal(l), other) if l.category() == Category::Number => (l.value, other),
            (other, Node::Literal(l)) if l.category() == Category::Number => (l.value, other),
            _ => return None,
          };
          let mut r = other.to_pixels_and_percent(lengths)?;
          r.pixels *= number as f32;
          r.percent *= number as f32;
          Some(r)
        }
        _ => None,
      },
    }
  }

  fn has_channel(&self) -> bool {
    match self {
      Node::Channel(_) => true,
      Node::Op(op) => op.operands.iter().any(Node::has_channel),
      _ => false,
    }
  }

  /// ToCalculationExpression (:1374-1394, 3132-3193).
  fn to_calculation_expression(&self, lengths: &Lengths) -> CalcNode {
    match self {
      Node::Literal(l) => match l.category() {
        Category::Number => CalcNode::Number(l.value as f32),
        Category::Time | Category::Frequency | Category::Resolution => {
          CalcNode::Number(l.canonical_value().unwrap_or(0.0) as f32)
        }
        _ => CalcNode::PixelsAndPercent(self.to_pixels_and_percent(lengths).unwrap_or(
          PixelsAndPercent {
            pixels: 0.0,
            percent: 0.0,
          },
        )),
      },
      Node::Channel(c) => CalcNode::Channel(*c),
      Node::ClampNone => CalcNode::Number(0.0),
      Node::Op(op) => {
        // CheckArithmeticTreeConstraints: a pure arithmetic tree with a
        // typed literal (angle, time, …) collapses to its canonical value.
        if let Some(collapsed) = self.collapse_typed_arithmetic(lengths) {
          return collapsed;
        }
        let children: Vec<CalcNode> = op
          .operands
          .iter()
          .map(|n| n.to_calculation_expression(lengths))
          .collect();
        if op.op.is_arithmetic() && op.nested_intermediate {
          return CalcNode::Op(op.op, children);
        }
        create_simplified(children, op.op)
      }
    }
  }

  fn collapse_typed_arithmetic(&self, lengths: &Lengths) -> Option<CalcNode> {
    fn constraints(node: &Node) -> Option<bool> {
      match node {
        Node::Channel(_) | Node::ClampNone => None,
        Node::Literal(l) => Some(matches!(
          l.category(),
          Category::Angle | Category::Time | Category::Frequency | Category::Resolution
        )),
        Node::Op(op) => {
          if !op.op.is_arithmetic() {
            return None;
          }
          let mut typed = false;
          for operand in &op.operands {
            typed |= constraints(operand)?;
          }
          Some(typed)
        }
      }
    }
    let Node::Op(op) = self else { return None };
    if constraints(self) != Some(true) {
      return None;
    }
    let value = self.canonical_value_with(lengths)?;
    match op.category {
      Category::Number => Some(CalcNode::Number(clamp_to_float(value))),
      Category::Length | Category::Angle if op.category != Category::Percent => {
        Some(CalcNode::PixelsAndPercent(PixelsAndPercent {
          pixels: clamp_to_float(value),
          percent: 0.0,
        }))
      }
      Category::Percent => Some(CalcNode::PixelsAndPercent(PixelsAndPercent {
        pixels: 0.0,
        percent: clamp_to_float(value),
      })),
      _ => None,
    }
  }

  /// ComputeValueInCanonicalUnit(length_resolver).
  fn canonical_value_with(&self, lengths: &Lengths) -> Option<f64> {
    match self {
      Node::Literal(l) => Some(if l.category() == Category::Length {
        lengths.px(l.value, l.unit)
      } else {
        l.value * l.unit.canonical_factor()
      }),
      Node::Channel(_) | Node::ClampNone => None,
      Node::Op(op) => {
        if op.category != Category::Intermediate && !has_canonical_unit(op.category) {
          return None;
        }
        let mut values = Vec::with_capacity(op.operands.len());
        for operand in &op.operands {
          let mut v = operand.canonical_value_with(lengths)?;
          if op.op.converts_rad_to_deg() && operand.category() == Category::Number {
            v = rad_to_deg(v);
          }
          values.push(v);
        }
        Some(evaluate_operator(&values, op.op))
      }
    }
  }

  /// CSSMathExpressionNode::ToCalcValue then CalculationValue::Evaluate:
  /// the float value of a relative color channel. `max_value` is what 100%
  /// is.
  pub(crate) fn evaluate_channel(
    &self,
    lengths: &Lengths,
    max_value: f32,
    channels: ChannelValues<'_>,
  ) -> f32 {
    let value = if let Some(pp) = self.to_pixels_and_percent(lengths) {
      let pp = if (pp.pixels + pp.percent).is_nan() {
        PixelsAndPercent {
          pixels: 0.0,
          percent: 0.0,
        }
      } else {
        PixelsAndPercent {
          pixels: clamp_length(pp.pixels),
          percent: clamp_length(pp.percent),
        }
      };
      pp.pixels + pp.percent / 100.0 * max_value
    } else {
      let expression = self.to_calculation_expression(lengths);
      if !self.has_channel() {
        // EvaluateValueIfNaNorInfinity (:639-660).
        let v = expression.evaluate(1.0, &[]);
        if !v.is_finite() {
          let c = clamp_length(v);
          c + c / 100.0 * max_value
        } else {
          expression.evaluate(max_value, channels)
        }
      } else {
        expression.evaluate(max_value, channels)
      }
    };
    calculation_value_result(value)
  }
}

/// The end of CalculationValue::Evaluate: NaN censored, clamped to float.
pub(crate) fn calculation_value_result(value: f32) -> f32 {
  let value = if value.is_nan() { 0.0 } else { value };
  clamp_to_float(value as f64)
}

/// A channel given as a plain literal or keyword (ResolveColorChannel,
/// style_color.cc:55-90), evaluated.
pub(crate) fn evaluate_literal_channel(literal: &Literal, max_value: f32) -> f32 {
  let pp = match literal.category() {
    Category::Angle => PixelsAndPercent {
      pixels: literal.degrees() as f32,
      percent: 0.0,
    },
    Category::Percent => PixelsAndPercent {
      pixels: 0.0,
      percent: literal.value as f32,
    },
    _ => PixelsAndPercent {
      pixels: literal.value as f32,
      percent: 0.0,
    },
  };
  calculation_value_result(pp.pixels + pp.percent / 100.0 * max_value)
}

/// The value of a channel keyword (CalculationExpressionColorChannelKeywordNode).
pub(crate) fn channel_value(channels: ChannelValues<'_>, channel: Channel) -> f32 {
  channels
    .iter()
    .find(|(c, _)| *c == channel)
    .map_or(0.0, |(_, v)| *v)
}

/// CalculationExpressionOperationNode::CreateSimplified
/// (calculation_expression_node.cc:177-493).
fn create_simplified(mut children: Vec<CalcNode>, op: Op) -> CalcNode {
  let pp = |n: &CalcNode| match n {
    CalcNode::PixelsAndPercent(pp) => Some(*pp),
    _ => None,
  };
  let px_only = |n: &CalcNode| pp(n).filter(|p| p.percent == 0.0).map(|p| p.pixels);
  let all_px = |children: &[CalcNode]| children.iter().map(px_only).collect::<Option<Vec<f32>>>();
  let pixels = |v: f32| {
    CalcNode::PixelsAndPercent(PixelsAndPercent {
      pixels: v,
      percent: 0.0,
    })
  };
  match op {
    Op::Add | Op::Subtract => {
      if let (Some(a), Some(b)) = (pp(&children[0]), pp(&children[1])) {
        return CalcNode::PixelsAndPercent(if op == Op::Add {
          PixelsAndPercent {
            pixels: a.pixels + b.pixels,
            percent: a.percent + b.percent,
          }
        } else {
          PixelsAndPercent {
            pixels: a.pixels - b.pixels,
            percent: a.percent - b.percent,
          }
        });
      }
    }
    Op::Multiply => {
      let lhs_is_number = matches!(children[0], CalcNode::Number(_));
      let (number, other) = if lhs_is_number {
        (&children[0], &children[1])
      } else {
        (&children[1], &children[0])
      };
      if let (CalcNode::Number(n), Some(mut p)) = (number, pp(other)) {
        p.pixels *= n;
        p.percent *= n;
        return CalcNode::PixelsAndPercent(p);
      }
    }
    Op::Invert => {
      if let CalcNode::Number(n) = children[0] {
        return CalcNode::Number((1.0 / n as f64) as f32);
      }
    }
    Op::Min | Op::Max => {
      if let Some(values) = all_px(&children) {
        let mut v = values[0];
        for &x in &values[1..] {
          v = if op == Op::Min {
            if x < v { x } else { v }
          } else if v < x {
            x
          } else {
            v
          };
        }
        return pixels(v);
      }
    }
    Op::Clamp => {
      if let Some(v) = all_px(&children) {
        let minimum = if v[2] < v[1] { v[2] } else { v[1] };
        return pixels(if v[0] < minimum { minimum } else { v[0] });
      }
    }
    Op::RoundNearest | Op::RoundUp | Op::RoundDown | Op::RoundToZero | Op::Mod | Op::Rem => {
      if let Some(v) = all_px(&children) {
        return pixels(stepped(op, v[0], v[1]));
      }
    }
    Op::Log => {
      if let Some(v) = all_px(&children) {
        return pixels(if v.len() == 1 {
          v[0].ln()
        } else {
          v[0].log2() / v[1].log2()
        });
      }
    }
    Op::Hypot => {
      if let Some(v) = all_px(&children) {
        return pixels(v.iter().fold(0.0_f32, |acc, &x| acc.hypot(x)));
      }
    }
    Op::Sin
    | Op::Cos
    | Op::Tan
    | Op::Asin
    | Op::Acos
    | Op::Atan
    | Op::Abs
    | Op::Exp
    | Op::Sqrt
    | Op::Sign => {
      if let Some(v) = px_only(&children[0]) {
        return match op {
          Op::Abs => pixels(v.abs()),
          Op::Sign => CalcNode::Number(sign(v)),
          Op::Exp => CalcNode::Number(v.exp()),
          Op::Sqrt => CalcNode::Number(v.sqrt()),
          // A PixelsAndPercent child is never a number: no Rad2deg.
          _ => CalcNode::Number(trig_f32(op, v, None)),
        };
      }
    }
    Op::Progress => {
      if let Some(v) = all_px(&children) {
        let value = (v[0] - v[1]) / (v[2] - v[1]);
        return CalcNode::Number(if value.is_nan() {
          f32::NAN
        } else {
          value.clamp(0.0, 1.0)
        });
      }
    }
    Op::Pow => {
      if let (CalcNode::Number(a), CalcNode::Number(b)) = (&children[0], &children[1]) {
        return CalcNode::Number(a.powf(*b));
      }
    }
    Op::Atan2 => {
      if let Some(v) = all_px(&children) {
        return pixels(trig_f32(op, v[0], Some(v[1])));
      }
    }
  }
  CalcNode::Op(op, std::mem::take(&mut children))
}

/// TanDegrees for floats: the octant test runs in float.
fn tan_degrees_f32(degrees: f32) -> f32 {
  if degrees > -90000000.0 && degrees < 90000000.0 {
    let n45degrees = (degrees as f64 / 45.0) as f32;
    let octant = n45degrees as i32;
    if octant as f32 == n45degrees {
      const TABLE: [f32; 8] = [
        0.0,
        1.0,
        f32::INFINITY,
        -1.0,
        0.0,
        1.0,
        f32::NEG_INFINITY,
        -1.0,
      ];
      return TABLE[(octant & 7) as usize];
    }
  }
  // blink::Deg2rad(float).
  (degrees * (std::f32::consts::PI / 180.0)).tan()
}

/// EvaluateTrigonometricFunction<float>.
fn trig_f32(op: Op, a: f32, b: Option<f32>) -> f32 {
  match op {
    Op::Sin => sin_cos_degrees(a as f64).0 as f32,
    Op::Cos => sin_cos_degrees(a as f64).1 as f32,
    Op::Tan => tan_degrees_f32(a),
    Op::Asin => rad_to_deg_f32(a.asin()),
    Op::Acos => rad_to_deg_f32(a.acos()),
    Op::Atan => rad_to_deg_f32(a.atan()),
    _ => rad_to_deg_f32(a.atan2(b.unwrap_or(f32::NAN))),
  }
}

impl CalcNode {
  fn evaluates_to_number(&self) -> bool {
    match self {
      CalcNode::Number(_) | CalcNode::Channel(_) => true,
      CalcNode::PixelsAndPercent(_) => false,
      CalcNode::Op(op, children) => match op {
        Op::Log
        | Op::Exp
        | Op::Sqrt
        | Op::Sign
        | Op::Pow
        | Op::Sin
        | Op::Cos
        | Op::Tan
        | Op::Progress => true,
        Op::Asin | Op::Acos | Op::Atan | Op::Atan2 => false,
        Op::Multiply => children[0].evaluates_to_number() && children[1].evaluates_to_number(),
        _ => children[0].evaluates_to_number(),
      },
    }
  }

  /// CalculationExpressionNode::Evaluate (calculation_expression_node.cc).
  fn evaluate(&self, max_value: f32, channels: ChannelValues<'_>) -> f32 {
    match self {
      CalcNode::Number(v) => *v,
      CalcNode::PixelsAndPercent(pp) => pp.pixels + pp.percent / 100.0 * max_value,
      CalcNode::Channel(c) => {
        if channels.is_empty() {
          0.0
        } else {
          channel_value(channels, *c)
        }
      }
      CalcNode::Op(op, children) => {
        let e = |i: usize| children[i].evaluate(max_value, channels);
        match op {
          Op::Add => e(0) + e(1),
          Op::Subtract => e(0) - e(1),
          Op::Multiply => e(0) * e(1),
          Op::Invert => (1.0 / e(0) as f64) as f32,
          Op::Min => {
            let mut minimum = e(0);
            for i in 0..children.len() {
              let v = e(i);
              if v < minimum {
                minimum = v;
              }
            }
            minimum
          }
          Op::Max => {
            let mut maximum = e(0);
            for i in 0..children.len() {
              let v = e(i);
              if maximum < v {
                maximum = v;
              }
            }
            maximum
          }
          Op::Clamp => {
            let (min, val, max) = (e(0), e(1), e(2));
            let minimum = if max < val { max } else { val };
            if min < minimum { minimum } else { min }
          }
          Op::RoundNearest | Op::RoundUp | Op::RoundDown | Op::RoundToZero | Op::Mod | Op::Rem => {
            stepped(*op, e(0), e(1))
          }
          Op::Log => {
            if children.len() == 1 {
              e(0).ln()
            } else {
              e(0).log2() / e(children.len() - 1).log2()
            }
          }
          Op::Hypot => (0..children.len()).fold(0.0_f32, |acc, i| acc.hypot(e(i))),
          Op::Abs => e(0).abs(),
          Op::Exp => e(0).exp(),
          Op::Sign => sign(e(0)),
          Op::Sqrt => e(0).sqrt(),
          Op::Progress => {
            let value = (e(0) - e(1)) / (e(2) - e(1));
            if value.is_nan() {
              f32::NAN
            } else {
              value.clamp(0.0, 1.0)
            }
          }
          Op::Pow => e(0).powf(e(1)),
          Op::Sin | Op::Cos | Op::Tan | Op::Asin | Op::Acos | Op::Atan | Op::Atan2 => {
            let mut a = e(0);
            if op.converts_rad_to_deg() && children[0].evaluates_to_number() {
              a = rad_to_deg_f32(a);
            }
            let b = if *op == Op::Atan2 { Some(e(1)) } else { None };
            trig_f32(*op, a, b)
          }
        }
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn parse(s: &str, allow_percent: bool) -> Option<Node> {
    let mut p = Parser::new(s);
    // As the color parser does: our depth limit, not cssparser's 75.
    p.set_nested_block_limit(0);
    let (token, _) = next_token(&mut p)?;
    let Token::Function(name) = token else {
      return None;
    };
    let options = MathOptions {
      allow_percent,
      channels: &[],
    };
    p.parse_nested_block(|q| parse_math_function(q, &name, options).ok_or_else(custom_error))
      .ok()
  }

  fn value(s: &str) -> Option<f64> {
    let node = parse(s, true)?;
    Some(node.as_literal()?.value)
  }

  #[test]
  fn folds_like_blink() {
    assert_eq!(value("calc(1 + 2 * 3)"), Some(7.0));
    assert_eq!(value("calc(1in)"), Some(96.0));
    assert_eq!(
      value("min(50%, 10%)"),
      None,
      "percentages stay an operation"
    );
    assert!(parse("min(50%, 10)", true).is_none());
    assert!(parse("calc(100-2)", true).is_none());
    assert!(parse("calc(1 +2)", true).is_none());
    assert_eq!(value("round(10.5)"), Some(11.0));
    assert_eq!(value("round(up, 10.2)"), Some(11.0));
    assert_eq!(value("clamp(none, 300, 100)"), Some(100.0));
    assert_eq!(value("progress(50, 0, 100)"), Some(0.5));
    assert_eq!(value("sign(-0.5)"), Some(-1.0));
    assert!(
      parse("calc(1in / 1px)", true)
        .unwrap()
        .as_literal()
        .is_none()
    );
  }

  #[test]
  fn expression_depth_is_limited() {
    let nested = |n: usize| format!("{}1{}", "calc(".repeat(n), ")".repeat(n));
    assert!(parse(&nested(100), true).is_some());
    assert!(parse(&nested(101), true).is_none());
  }

  #[test]
  fn tokens_keep_double_precision() {
    assert_eq!(token_number("0.1px"), 0.1);
    assert_eq!(token_number("1e3"), 1000.0);
    assert_eq!(token_number("1em"), 1.0);
    assert_eq!(token_number("-.5%"), -0.5);
  }
}
