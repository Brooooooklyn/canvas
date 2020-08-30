#[macro_use]
extern crate napi;
#[macro_use]
extern crate napi_derive;

use std::convert::TryInto;

use napi::{CallContext, Env, JsNumber, JsObject, Module, Result, Task};

#[cfg(all(unix, not(target_env = "musl")))]
#[global_allocator]
static ALLOC: jemallocator::Jemalloc = jemallocator::Jemalloc;

register_module!(example, init);

struct AsyncTask(u32);

impl Task for AsyncTask {
    type Output = u32;
    type JsValue = JsNumber;

    fn compute(&mut self) -> Result<Self::Output> {
        use std::thread::sleep;
        use std::time::Duration;
        sleep(Duration::from_millis(self.0 as u64));
        Ok(self.0 * 2)
    }

    fn resolve(&self, env: &mut Env, output: Self::Output) -> Result<Self::JsValue> {
        env.create_uint32(output)
    }
}

fn init(module: &mut Module) -> Result<()> {
    module.create_named_method("sync", sync_fn)?;

    module.create_named_method("sleep", sleep)?;
    Ok(())
}

#[js_function(1)]
fn sync_fn(ctx: CallContext) -> Result<JsNumber> {
    let argument: u32 = ctx.get::<JsNumber>(0)?.try_into()?;

    ctx.env.create_uint32(argument + 100)
}

#[js_function(1)]
fn sleep(ctx: CallContext) -> Result<JsObject> {
    let argument: u32 = ctx.get::<JsNumber>(0)?.try_into()?;
    let task = AsyncTask(argument);
    ctx.env.spawn(task)
}
