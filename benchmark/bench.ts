import { promises as fs } from 'fs'
import { join } from 'path'

import { Summary } from 'benny/lib/internal/common-types'

import { house } from './house'
import { gradient } from './gradient'

async function run() {
  const output = [await house(), await gradient()].map(formatSummary).join('\n')
  await fs.writeFile(join(process.cwd(), 'bench.txt'), output, 'utf8')
}

run().catch((e) => {
  console.error(e)
})

function formatSummary(summary: Summary): string {
  return summary.results
    .map(
      (result) =>
        `${summary.name}#${result.name} x ${result.ops} ops/sec ±${result.margin}% (${result.samples} runs sampled)`,
    )
    .join('\n')
}
