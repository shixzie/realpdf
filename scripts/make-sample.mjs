import { buildSamplePdf } from '../tests/helpers/fixtures.mjs'

const file = await buildSamplePdf('sample.pdf')
console.log(`Wrote ${file}`)
