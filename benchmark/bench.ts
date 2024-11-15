import { house } from './house'
import { gradient } from './gradient'

async function run() {
  await house()
  await gradient()
}

run().catch((e) => {
  console.error(e)
})
