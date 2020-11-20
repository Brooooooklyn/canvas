use std::path::Path;

use napi::{Env, Error, JsBufferValue, JsObject, Ref, Result, Task};

pub struct Image {
  data: Ref<JsBufferValue>,
}

impl Task for Image {
  type Output = Vec<u8>;
  type JsValue = JsObject;

  fn compute(&mut self) -> Result<Self::Output> {
    Ok(vec![])
  }

  fn resolve(self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
    self.data.unref(env)?;
    env.create_object()
  }
}
