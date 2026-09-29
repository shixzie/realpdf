import createQpdf from '@neslinesli93/qpdf-wasm'

console.log = () => undefined
console.error = () => undefined

interface Job {
  id: number
  op: 'compress' | 'optimize' | 'protect' | 'unlock' | 'repair'
  bytes: Uint8Array
  password?: string
}

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<Job>) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

function assetUrl(): string {
  return new URL('/pdf-engine-assets/qpdf.wasm', self.location.origin).toString()
}

async function run(job: Job): Promise<Uint8Array> {
  const qpdf = await createQpdf({ locateFile: assetUrl })
  const input = '/input.pdf'
  const output = '/output.pdf'
  ;(qpdf.FS as unknown as { writeFile: (path: string, data: Uint8Array) => void }).writeFile(input, job.bytes)
  let args: string[]
  if (job.op === 'protect') {
    args = [input, '--encrypt', `--user-password=${job.password ?? ''}`, `--owner-password=${job.password ?? ''}`, '--bits=256', '--', output]
  } else if (job.op === 'unlock') {
    args = [input, `--password=${job.password ?? ''}`, '--decrypt', output]
  } else if (job.op === 'optimize') {
    args = [input, '--linearize', '--compress-streams=y', '--object-streams=generate', '--recompress-flate', '--compression-level=9', output]
  } else if (job.op === 'repair') {
    args = [input, '--object-streams=generate', output]
  } else {
    args = [input, '--compress-streams=y', '--object-streams=generate', '--recompress-flate', '--compression-level=9', output]
  }
  const code = qpdf.callMain(args)
  if (code !== 0 && code !== 3) throw new Error(`QPDF_EXIT_${code}`)
  let result: Uint8Array
  try {
    result = qpdf.FS.readFile(output).slice()
  } catch {
    throw new Error(`QPDF_EXIT_${code}`)
  }
  if (!result.length) throw new Error('QPDF_EMPTY_OUTPUT')
  return result
}

ctx.onmessage = async (event: MessageEvent<Job>) => {
  const job = event.data
  try {
    const bytes = await run(job)
    ctx.postMessage({ id: job.id, bytes }, [bytes.buffer])
  } catch (error) {
    ctx.postMessage({ id: job.id, error: error instanceof Error ? error.message : 'QPDF_FAILED' })
  }
}
