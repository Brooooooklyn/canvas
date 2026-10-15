// shared with layer 07 (css-color)
//! CSS math functions (calc(), min(), max(), clamp(), round(), ...) with
//! Blink's typing (css_math_expression_node.cc), evaluated in f64. Only the
//! value types font parsing reaches: numbers, percentages, lengths, angles.

use cssparser::{Parser, Token};

use super::token;

/// css_math_expression_node.h kMaxExpressionDepth.
const MAX_DEPTH: usize = 100;

/// What the property accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Allowed {
  Number,
  #[allow(dead_code)]
  Length,
  LengthPercentage,
  Angle,
}

/// CalculationResultCategory, for the types fonts reach.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Category {
  Number,
  Percent,
  Length,
  LengthPercent,
  Angle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LengthUnit {
  Px,
  Em,
  Rem,
  Ex,
  Rex,
  Ch,
  Rch,
  Cap,
  Rcap,
  Ic,
  Ric,
  Lh,
  Rlh,
  Vw,
  Vh,
  Vmin,
  Vmax,
  /// Container query units: no container, so 0.
  Container,
}

impl LengthUnit {
  /// The unit of a length dimension (ASCII case-insensitive) and its factor
  /// to the unit (absolute units fold into px, css_primitive_value.cc
  /// ConversionToCanonicalUnitsScaleFactor).
  pub(crate) fn parse(unit: &str) -> Option<(LengthUnit, f64)> {
    let unit = unit.to_ascii_lowercase();
    Some(match unit.as_str() {
      "px" => (LengthUnit::Px, 1.0),
      "cm" => (LengthUnit::Px, 96.0 / 2.54),
      "mm" => (LengthUnit::Px, 96.0 / 25.4),
      "q" => (LengthUnit::Px, 96.0 / 101.6),
      "in" => (LengthUnit::Px, 96.0),
      "pt" => (LengthUnit::Px, 96.0 / 72.0),
      "pc" => (LengthUnit::Px, 16.0),
      "em" => (LengthUnit::Em, 1.0),
      "rem" => (LengthUnit::Rem, 1.0),
      "ex" => (LengthUnit::Ex, 1.0),
      "rex" => (LengthUnit::Rex, 1.0),
      "ch" => (LengthUnit::Ch, 1.0),
      "rch" => (LengthUnit::Rch, 1.0),
      "cap" => (LengthUnit::Cap, 1.0),
      "rcap" => (LengthUnit::Rcap, 1.0),
      "ic" => (LengthUnit::Ic, 1.0),
      "ric" => (LengthUnit::Ric, 1.0),
      "lh" => (LengthUnit::Lh, 1.0),
      "rlh" => (LengthUnit::Rlh, 1.0),
      "vw" | "svw" | "lvw" | "dvw" | "vi" | "svi" | "lvi" | "dvi" => (LengthUnit::Vw, 1.0),
      "vh" | "svh" | "lvh" | "dvh" | "vb" | "svb" | "lvb" | "dvb" => (LengthUnit::Vh, 1.0),
      "vmin" | "svmin" | "lvmin" | "dvmin" => (LengthUnit::Vmin, 1.0),
      "vmax" | "svmax" | "lvmax" | "dvmax" => (LengthUnit::Vmax, 1.0),
      "cqw" | "cqh" | "cqi" | "cqb" | "cqmin" | "cqmax" => (LengthUnit::Container, 1.0),
      _ => return None,
    })
  }

  /// IsFontRelativeLength (css_primitive_value.h).
  pub(crate) fn is_font_relative(self) -> bool {
    !matches!(
      self,
      LengthUnit::Px
        | LengthUnit::Vw
        | LengthUnit::Vh
        | LengthUnit::Vmin
        | LengthUnit::Vmax
        | LengthUnit::Container
    )
  }
}

/// The px value of one unit of each relative length.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct LengthCtx {
  pub em: f64,
  pub rem: f64,
  pub ex: f64,
  pub rex: f64,
  pub ch: f64,
  pub rch: f64,
  pub cap: f64,
  pub rcap: f64,
  pub ic: f64,
  pub ric: f64,
  pub lh: f64,
  pub rlh: f64,
  pub vw: f64,
  pub vh: f64,
  /// What 100% resolves to.
  pub percent_base: f64,
}

impl LengthCtx {
  pub(crate) fn px(&self, value: f64, unit: LengthUnit) -> f64 {
    value
      * match unit {
        LengthUnit::Px => 1.0,
        LengthUnit::Em => self.em,
        LengthUnit::Rem => self.rem,
        LengthUnit::Ex => self.ex,
        LengthUnit::Rex => self.rex,
        LengthUnit::Ch => self.ch,
        LengthUnit::Rch => self.rch,
        LengthUnit::Cap => self.cap,
        LengthUnit::Rcap => self.rcap,
        LengthUnit::Ic => self.ic,
        LengthUnit::Ric => self.ric,
        LengthUnit::Lh => self.lh,
        LengthUnit::Rlh => self.rlh,
        LengthUnit::Vw => self.vw / 100.0,
        LengthUnit::Vh => self.vh / 100.0,
        LengthUnit::Vmin => self.vw.min(self.vh) / 100.0,
        LengthUnit::Vmax => self.vw.max(self.vh) / 100.0,
        LengthUnit::Container => 0.0,
      }
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RoundingStrategy {
  Nearest,
  Up,
  Down,
  ToZero,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Unary {
  Abs,
  Sign,
  Sin,
  Cos,
  Tan,
  Asin,
  Acos,
  Atan,
  Sqrt,
  Exp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Binary {
  Add,
  Sub,
  Mul,
  Div,
  Mod,
  Rem,
  Atan2,
  Pow,
  Log,
}

#[derive(Clone, Debug)]
enum Node {
  Number(f64),
  Percent(f64),
  Length(f64, LengthUnit),
  /// Degrees.
  Angle(f64),
  Unary(Unary, Category, Box<Node>),
  Binary(Binary, Box<Node>, Box<Node>),
  Min(Vec<Node>),
  Max(Vec<Node>),
  Hypot(Vec<Node>),
  Clamp(Option<Box<Node>>, Box<Node>, Option<Box<Node>>),
  Round(RoundingStrategy, Box<Node>, Box<Node>),
}

/// A parsed math function.
#[derive(Clone, Debug)]
pub(crate) struct Expr {
  node: Node,
  category: Category,
}

/// The category of `a + b` (CSSMathExpressionOperation::CreateArithmeticOperation
/// DetermineCategory): equal types, or lengths and percentages together.
fn add_category(a: Category, b: Category) -> Option<Category> {
  use Category::*;
  match (a, b) {
    _ if a == b => Some(a),
    (Length | Percent | LengthPercent, Length | Percent | LengthPercent) => Some(LengthPercent),
    _ => None,
  }
}

fn same_category(args: &[(Node, Category)]) -> Option<Category> {
  let mut iter = args.iter();
  let mut category = iter.next()?.1;
  for (_, c) in iter {
    category = add_category(category, *c)?;
  }
  Some(category)
}

struct MathParser {
  depth: usize,
}

type Parsed = Option<(Node, Category)>;

fn is_whitespace(t: &Token) -> bool {
  matches!(t, Token::WhiteSpace(_))
}

impl MathParser {
  fn function<'i>(&mut self, p: &mut Parser<'i>, name: &str) -> Parsed {
    self.depth += 1;
    if self.depth > MAX_DEPTH {
      return None;
    }
    let name = name.to_ascii_lowercase();
    let result = p
      .parse_nested_block(|p| -> Result<(Node, Category), cssparser::ParseError<()>> {
        let r = self.function_args(p, &name);
        match r {
          Some(r) if p.is_exhausted() => Ok(r),
          _ => Err(cssparser::ParseError::custom(())),
        }
      })
      .ok();
    self.depth -= 1;
    result
  }

  fn args<'i>(&mut self, p: &mut Parser<'i>) -> Option<Vec<(Node, Category)>> {
    let mut args = vec![self.sum(p)?];
    while p.try_parse(|p| p.expect_comma()).is_ok() {
      args.push(self.sum(p)?);
    }
    Some(args)
  }

  fn function_args<'i>(&mut self, p: &mut Parser<'i>, name: &str) -> Parsed {
    use Category::*;
    match name {
      "calc" => self.sum(p),
      "min" | "max" | "hypot" => {
        let args = self.args(p)?;
        let category = same_category(&args)?;
        let nodes = args.into_iter().map(|(n, _)| n).collect();
        Some((
          match name {
            "min" => Node::Min(nodes),
            "max" => Node::Max(nodes),
            _ => Node::Hypot(nodes),
          },
          category,
        ))
      }
      "clamp" => {
        let none = |p: &mut Parser<'i>| p.try_parse(|p| p.expect_ident_matching("none")).is_ok();
        let min = if none(p) { None } else { Some(self.sum(p)?) };
        p.expect_comma().ok()?;
        let value = self.sum(p)?;
        p.expect_comma().ok()?;
        let max = if none(p) { None } else { Some(self.sum(p)?) };
        let mut category = value.1;
        for bound in [&min, &max].into_iter().flatten() {
          category = add_category(category, bound.1)?;
        }
        Some((
          Node::Clamp(
            min.map(|m| Box::new(m.0)),
            Box::new(value.0),
            max.map(|m| Box::new(m.0)),
          ),
          category,
        ))
      }
      "round" => {
        let strategy = p
          .try_parse(|p| -> Result<RoundingStrategy, ()> {
            let ident = p.expect_ident().map_err(|_| ())?.clone();
            let strategy = match ident.to_ascii_lowercase().as_str() {
              "nearest" => RoundingStrategy::Nearest,
              "up" => RoundingStrategy::Up,
              "down" => RoundingStrategy::Down,
              "to-zero" => RoundingStrategy::ToZero,
              _ => return Err(()),
            };
            p.expect_comma().map_err(|_| ())?;
            Ok(strategy)
          })
          .unwrap_or(RoundingStrategy::Nearest);
        let a = self.sum(p)?;
        // B defaults to the number 1 (css-values-4 round()).
        let b = if p.try_parse(|p| p.expect_comma()).is_ok() {
          self.sum(p)?
        } else {
          (Node::Number(1.0), Number)
        };
        let category = add_category(a.1, b.1)?;
        Some((
          Node::Round(strategy, Box::new(a.0), Box::new(b.0)),
          category,
        ))
      }
      "mod" | "rem" | "atan2" | "pow" | "log" => {
        let a = self.sum(p)?;
        let b = if p.try_parse(|p| p.expect_comma()).is_ok() {
          Some(self.sum(p)?)
        } else {
          None
        };
        match name {
          "log" => {
            if a.1 != Number || b.as_ref().is_some_and(|b| b.1 != Number) {
              return None;
            }
            let b = b.map(|b| b.0).unwrap_or(Node::Number(std::f64::consts::E));
            Some((
              Node::Binary(Binary::Log, Box::new(a.0), Box::new(b)),
              Number,
            ))
          }
          _ => {
            let b = b?;
            let (op, category) = match name {
              "mod" => (Binary::Mod, add_category(a.1, b.1)?),
              "rem" => (Binary::Rem, add_category(a.1, b.1)?),
              "atan2" => {
                add_category(a.1, b.1)?;
                (Binary::Atan2, Angle)
              }
              _ => {
                if a.1 != Number || b.1 != Number {
                  return None;
                }
                (Binary::Pow, Number)
              }
            };
            Some((Node::Binary(op, Box::new(a.0), Box::new(b.0)), category))
          }
        }
      }
      "abs" | "sign" | "sin" | "cos" | "tan" | "asin" | "acos" | "atan" | "sqrt" | "exp" => {
        let (node, category) = self.sum(p)?;
        let (op, result) = match name {
          "abs" => (Unary::Abs, category),
          "sign" => (Unary::Sign, Number),
          "sin" | "cos" | "tan" => {
            if !matches!(category, Number | Angle) {
              return None;
            }
            (
              match name {
                "sin" => Unary::Sin,
                "cos" => Unary::Cos,
                _ => Unary::Tan,
              },
              Number,
            )
          }
          "asin" | "acos" | "atan" => {
            if category != Number {
              return None;
            }
            (
              match name {
                "asin" => Unary::Asin,
                "acos" => Unary::Acos,
                _ => Unary::Atan,
              },
              Angle,
            )
          }
          _ => {
            if category != Number {
              return None;
            }
            (
              if name == "sqrt" {
                Unary::Sqrt
              } else {
                Unary::Exp
              },
              Number,
            )
          }
        };
        Some((Node::Unary(op, category, Box::new(node)), result))
      }
      _ => None,
    }
  }

  fn skip_ws<'i>(p: &mut Parser<'i>) -> bool {
    let mut skipped = false;
    loop {
      let state = p.state();
      match p.next_including_whitespace() {
        Ok(t) if is_whitespace(t) => skipped = true,
        _ => {
          p.reset(&state);
          return skipped;
        }
      }
    }
  }

  /// `+` and `-` need whitespace on both sides.
  fn sum<'i>(&mut self, p: &mut Parser<'i>) -> Parsed {
    Self::skip_ws(p);
    let (mut node, mut category) = self.product(p)?;
    loop {
      let state = p.state();
      if !Self::skip_ws(p) {
        p.reset(&state);
        break;
      }
      let op = match p.next_including_whitespace() {
        Ok(Token::Delim('+')) => Binary::Add,
        Ok(Token::Delim('-')) => Binary::Sub,
        _ => {
          // Trailing whitespace before `)` or `,`.
          p.reset(&state);
          Self::skip_ws(p);
          break;
        }
      };
      if !Self::skip_ws(p) {
        return None;
      }
      let (rhs, rhs_category) = self.product(p)?;
      category = add_category(category, rhs_category)?;
      node = Node::Binary(op, Box::new(node), Box::new(rhs));
    }
    Some((node, category))
  }

  fn product<'i>(&mut self, p: &mut Parser<'i>) -> Parsed {
    let (mut node, mut category) = self.value(p)?;
    loop {
      let state = p.state();
      Self::skip_ws(p);
      let op = match p.next_including_whitespace() {
        Ok(Token::Delim('*')) => Binary::Mul,
        Ok(Token::Delim('/')) => Binary::Div,
        _ => {
          p.reset(&state);
          break;
        }
      };
      Self::skip_ws(p);
      let (rhs, rhs_category) = self.value(p)?;
      category = match op {
        Binary::Mul if category == Category::Number => rhs_category,
        Binary::Mul if rhs_category == Category::Number => category,
        Binary::Div if rhs_category == Category::Number => category,
        _ => return None,
      };
      node = Node::Binary(op, Box::new(node), Box::new(rhs));
    }
    Some((node, category))
  }

  fn value<'i>(&mut self, p: &mut Parser<'i>) -> Parsed {
    let t = token::next_including_whitespace(p).ok()?;
    match t.token {
      Token::Number { .. } => Some((Node::Number(t.value), Category::Number)),
      Token::Percentage { .. } => Some((Node::Percent(t.value), Category::Percent)),
      Token::Dimension { ref unit, .. } => {
        if let Some((unit, factor)) = LengthUnit::parse(unit) {
          return Some((Node::Length(t.value * factor, unit), Category::Length));
        }
        angle_degrees(t.value, unit).map(|deg| (Node::Angle(deg), Category::Angle))
      }
      Token::Ident(ref name) => {
        let value = match name.to_ascii_lowercase().as_str() {
          "e" => std::f64::consts::E,
          "pi" => std::f64::consts::PI,
          "infinity" => f64::INFINITY,
          "-infinity" => f64::NEG_INFINITY,
          "nan" => f64::NAN,
          _ => return None,
        };
        Some((Node::Number(value), Category::Number))
      }
      Token::ParenthesisBlock => {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
          return None;
        }
        let result = p
          .parse_nested_block(|p| -> Result<(Node, Category), cssparser::ParseError<()>> {
            match self.sum(p) {
              Some(r) if p.is_exhausted() => Ok(r),
              _ => Err(cssparser::ParseError::custom(())),
            }
          })
          .ok();
        self.depth -= 1;
        result
      }
      Token::Function(ref name) => {
        let name = name.to_string();
        if !is_math_function(&name) {
          return None;
        }
        self.function(p, &name)
      }
      _ => None,
    }
  }
}

/// Degrees in one unit of an angle dimension (ASCII case-insensitive).
pub(crate) fn angle_degrees(value: f64, unit: &str) -> Option<f64> {
  Some(match unit.to_ascii_lowercase().as_str() {
    "deg" => value,
    "grad" => value * 0.9,
    "rad" => value * (180.0 / std::f64::consts::PI),
    "turn" => value * 360.0,
    _ => return None,
  })
}

/// The functions this parser knows (ASCII case-insensitive).
pub(crate) fn is_math_function(name: &str) -> bool {
  matches!(
    name.to_ascii_lowercase().as_str(),
    "calc"
      | "min"
      | "max"
      | "clamp"
      | "round"
      | "mod"
      | "rem"
      | "abs"
      | "sign"
      | "sin"
      | "cos"
      | "tan"
      | "asin"
      | "acos"
      | "atan"
      | "atan2"
      | "pow"
      | "sqrt"
      | "hypot"
      | "log"
      | "exp"
  )
}

/// Parse a math function whose Function token is next in `p`, and check its
/// type against `allowed`. Returns None when the next token is not a math
/// function or the expression is invalid; `p` is then left anywhere, so call
/// it inside `try_parse`.
pub(crate) fn parse<'i>(p: &mut Parser<'i>, allowed: Allowed) -> Option<Expr> {
  let name = match p.next() {
    Ok(Token::Function(name)) => name.to_string(),
    _ => return None,
  };
  if !is_math_function(&name) {
    return None;
  }
  let (node, category) = MathParser { depth: 0 }.function(p, &name)?;
  let ok = match allowed {
    Allowed::Number => category == Category::Number,
    Allowed::Length => category == Category::Length,
    Allowed::LengthPercentage => matches!(
      category,
      Category::Length | Category::Percent | Category::LengthPercent
    ),
    Allowed::Angle => category == Category::Angle,
  };
  ok.then_some(Expr { node, category })
}

fn round(strategy: RoundingStrategy, a: f64, b: f64) -> f64 {
  // css-values-4 round(): B of 0 or both infinite is NaN; an infinite A stays.
  if b == 0.0 || (a.is_infinite() && b.is_infinite()) {
    return f64::NAN;
  }
  if a.is_infinite() {
    return a;
  }
  let b = b.abs();
  if b.is_infinite() {
    return match strategy {
      RoundingStrategy::Up if a > 0.0 => f64::INFINITY,
      RoundingStrategy::Down if a < 0.0 => f64::NEG_INFINITY,
      _ => 0.0f64.copysign(a),
    };
  }
  let lower = (a / b).floor() * b;
  let upper = lower + b;
  match strategy {
    RoundingStrategy::Nearest => {
      if a - lower < upper - a {
        lower
      } else {
        upper
      }
    }
    RoundingStrategy::Up => {
      if lower == a {
        a
      } else {
        upper
      }
    }
    RoundingStrategy::Down => lower,
    RoundingStrategy::ToZero => (a / b).trunc() * b,
  }
}

fn eval(node: &Node, ctx: &LengthCtx) -> f64 {
  match node {
    Node::Number(v) | Node::Angle(v) => *v,
    Node::Percent(v) => v / 100.0 * ctx.percent_base,
    Node::Length(v, unit) => ctx.px(*v, *unit),
    Node::Unary(op, category, a) => {
      let a = eval(a, ctx);
      // Angles evaluate in degrees; a bare number is radians.
      let radians = if *category == Category::Angle {
        a.to_radians()
      } else {
        a
      };
      match op {
        Unary::Abs => a.abs(),
        Unary::Sign => {
          if a.is_nan() || a == 0.0 {
            a
          } else {
            a.signum()
          }
        }
        Unary::Sin => radians.sin(),
        Unary::Cos => radians.cos(),
        Unary::Tan => radians.tan(),
        Unary::Asin => a.asin().to_degrees(),
        Unary::Acos => a.acos().to_degrees(),
        Unary::Atan => a.atan().to_degrees(),
        Unary::Sqrt => a.sqrt(),
        Unary::Exp => a.exp(),
      }
    }
    Node::Binary(op, a, b) => {
      let (a, b) = (eval(a, ctx), eval(b, ctx));
      match op {
        Binary::Add => a + b,
        Binary::Sub => a - b,
        Binary::Mul => a * b,
        Binary::Div => a / b,
        Binary::Mod => {
          if b == 0.0 || a.is_infinite() {
            f64::NAN
          } else if b.is_infinite() {
            if a == 0.0 || (a > 0.0) == (b > 0.0) {
              a
            } else {
              f64::NAN
            }
          } else {
            a - b * (a / b).floor()
          }
        }
        Binary::Rem => {
          if b == 0.0 || a.is_infinite() {
            f64::NAN
          } else if b.is_infinite() {
            a
          } else {
            a - b * (a / b).trunc()
          }
        }
        Binary::Atan2 => a.atan2(b).to_degrees(),
        Binary::Pow => a.powf(b),
        Binary::Log => a.ln() / b.ln(),
      }
    }
    Node::Min(args) | Node::Max(args) => {
      let is_min = matches!(node, Node::Min(_));
      let mut result: Option<f64> = None;
      for arg in args {
        let v = eval(arg, ctx);
        if v.is_nan() {
          return f64::NAN;
        }
        result = Some(match result {
          None => v,
          Some(r) if is_min => r.min(v),
          Some(r) => r.max(v),
        });
      }
      result.unwrap_or(f64::NAN)
    }
    Node::Hypot(args) => args
      .iter()
      .map(|a| {
        let v = eval(a, ctx);
        v * v
      })
      .sum::<f64>()
      .sqrt(),
    Node::Clamp(min, value, max) => {
      let mut v = eval(value, ctx);
      // max(MIN, min(VAL, MAX)): MIN wins when it is above MAX.
      if let Some(max) = max {
        let m = eval(max, ctx);
        v = if v.is_nan() || m.is_nan() {
          f64::NAN
        } else {
          v.min(m)
        };
      }
      if let Some(min) = min {
        let m = eval(min, ctx);
        v = if v.is_nan() || m.is_nan() {
          f64::NAN
        } else {
          v.max(m)
        };
      }
      v
    }
    Node::Round(strategy, a, b) => round(*strategy, eval(a, ctx), eval(b, ctx)),
  }
}

impl Expr {
  pub(crate) fn category(&self) -> Category {
    self.category
  }

  /// The value in px (lengths and percentages), degrees (angles) or as a
  /// number. A NaN result is 0 (css-values-4 top-level censoring); infinities
  /// stay for the property to clamp.
  pub(crate) fn eval(&self, ctx: &LengthCtx) -> Option<f64> {
    let v = eval(&self.node, ctx);
    Some(if v.is_nan() { 0.0 } else { v })
  }
}

#[cfg(test)]
mod tests {
  use cssparser::Parser;

  use super::*;

  fn calc(input: &str, allowed: Allowed) -> Option<f64> {
    let mut p = Parser::new(input);
    p.set_nested_block_limit(u8::MAX);
    let expr = parse(&mut p, allowed)?;
    if !p.is_exhausted() {
      return None;
    }
    expr.eval(&LengthCtx {
      em: 10.0,
      rem: 16.0,
      percent_base: 10.0,
      ..Default::default()
    })
  }

  #[test]
  fn calc_matches_chrome() {
    use Allowed::*;
    // Chrome 155 `ctx.font = '<input> serif'` sizes (out/p1b, p1c).
    assert_eq!(calc("calc(10px + 2px)", LengthPercentage), Some(12.0));
    assert_eq!(calc("calc(10px+2px)", LengthPercentage), None);
    assert_eq!(calc("calc(1px + 1)", LengthPercentage), None);
    assert_eq!(calc("calc(10px*2)", LengthPercentage), Some(20.0));
    assert_eq!(calc("calc(10px / 2px)", LengthPercentage), None);
    assert_eq!(calc("calc(50% * 50%)", LengthPercentage), None);
    assert_eq!(calc("calc(10px * 1%)", LengthPercentage), None);
    assert_eq!(calc("calc(1px * 2 + 3)", LengthPercentage), None);
    assert_eq!(calc("calc(1px * (2 + 3))", LengthPercentage), Some(5.0));
    assert_eq!(calc("max(1em, 50%)", LengthPercentage), Some(10.0));
    assert_eq!(calc("min(1px, 2)", LengthPercentage), None);
    assert_eq!(calc("clamp(none, 5px, 3px)", LengthPercentage), Some(3.0));
    assert_eq!(calc("clamp(1px, 2px)", LengthPercentage), None);
    assert_eq!(calc("round(10.5px)", LengthPercentage), None);
    assert_eq!(calc("round(10.5px, 1px)", LengthPercentage), Some(11.0));
    assert_eq!(calc("round(-10.5px, 1px)", LengthPercentage), Some(-10.0));
    assert_eq!(
      calc("round(down, 10.5px, 1px)", LengthPercentage),
      Some(10.0)
    );
    assert_eq!(calc("mod(-13px, 5px)", LengthPercentage), Some(2.0));
    assert_eq!(calc("rem(-13px, 5px)", LengthPercentage), Some(-3.0));
    assert_eq!(calc("hypot(3px, 4px)", LengthPercentage), Some(5.0));
    assert_eq!(calc("calc(log(8, 2) * 1px)", LengthPercentage), Some(3.0));
    assert_eq!(calc("calc(NaN * 1px)", LengthPercentage), Some(0.0));
    assert_eq!(
      calc("calc(-INFINITY * 1px)", LengthPercentage),
      Some(f64::NEG_INFINITY)
    );
    assert_eq!(calc("calc(100 + 50)", Number), Some(150.0));
    assert_eq!(calc("sign(1px)", Number), Some(1.0));
    assert_eq!(calc("calc(14deg)", Angle), Some(14.0));
    assert_eq!(calc("calc(0.25turn)", Angle), Some(90.0));
    assert_eq!(calc("calc(var(--x))", LengthPercentage), None);
    assert_eq!(calc("calc( 5px )", LengthPercentage), Some(5.0));
    assert_eq!(
      calc("calc(1px /**/ + /**/ 2px)", LengthPercentage),
      Some(3.0)
    );
  }

  #[test]
  fn nesting_is_capped() {
    let deep = |n: usize| format!("{}1px{}", "calc(".repeat(n), ")".repeat(n));
    assert_eq!(calc(&deep(100), Allowed::Length), Some(1.0));
    assert_eq!(calc(&deep(101), Allowed::Length), None);
  }
}
