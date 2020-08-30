import test from 'ava'

import { sleep, sync } from '../index'

test('sync function from native code', (t) => {
  const fixture = 42
  t.is(sync(fixture), fixture + 100)
})

test('sleep function from native code', async (t) => {
  const timeToSleep = 200
  const value = await sleep(timeToSleep)
  t.is(value, timeToSleep * 2)
})
