type QpdfOperation = 'compress' | 'optimize' | 'protect' | 'unlock' | 'repair'

interface Reply {
  id: number
  bytes?: Uint8Array
  error?: string
}

let nextId = 1

function execute(op: QpdfOperation, bytes: Uint8Array, password?: string): Promise<Uint8Array> {
  const worker = new Worker(new URL('./qpdf.worker.ts', import.meta.url), { type: 'module' })
  const id = nextId++
  return new Promise((resolve, reject) => {
    const finish = () => worker.terminate()
    worker.onmessage = (event: MessageEvent<Reply>) => {
      if (event.data.id !== id) return
      finish()
      if (event.data.error) reject(new Error(event.data.error))
      else if (event.data.bytes) resolve(event.data.bytes)
      else reject(new Error('QPDF_EMPTY_OUTPUT'))
    }
    worker.onerror = (event) => {
      finish()
      reject(new Error(event.message || 'QPDF_WORKER_FAILED'))
    }
    const input = bytes.slice()
    worker.postMessage({ id, op, bytes: input, password }, [input.buffer])
  })
}

export const compressPdf = (bytes: Uint8Array) => execute('compress', bytes)
export const optimizePdf = (bytes: Uint8Array) => execute('optimize', bytes)
export const protectPdf = (bytes: Uint8Array, password: string) => {
  if (!password || password.includes('\0')) return Promise.reject(new Error('QPDF_INVALID_PASSWORD'))
  return execute('protect', bytes, password)
}
export const unlockPdf = (bytes: Uint8Array, password: string) => {
  if (password.includes('\0')) return Promise.reject(new Error('QPDF_INVALID_PASSWORD'))
  return execute('unlock', bytes, password)
}
export async function repairPdf(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    return await execute('repair', bytes)
  } catch {
    const { PDFDocument } = await import('pdf-lib')
    const recovered = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true })
    return execute('repair', await recovered.save())
  }
}
