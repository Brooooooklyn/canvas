import { house } from './house'
import { gradient } from './gradient'
import { svgImage } from './svg-image'

async function run() {
  await house()
  await gradient()
  await svgImage()
}

run().catch((e) => {
  console.error(e)
})
