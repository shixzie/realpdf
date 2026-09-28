import { ToolError } from './protocol'

/** Largest PDF a tool accepts, inline or by URL. */
export const MAX_PDF_BYTES = 25 * 1024 * 1024

export const pdfInputProperties = {
  pdf_base64: {
    type: 'string',
    description: 'The PDF file, base64-encoded. Give this or pdf_url.',
    contentEncoding: 'base64',
    contentMediaType: 'application/pdf',
  },
  pdf_url: {
    type: 'string',
    format: 'uri',
    description: 'An https URL RealPDF can download the PDF from. Give this or pdf_base64.',
  },
} as const

export function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.replace(/^data:[^,]*,/, '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  let binary: string
  try {
    binary = atob(clean)
  } catch {
    throw new ToolError('pdf_base64 is not valid base64.')
  }
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function assertPdf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.length > MAX_PDF_BYTES) throw new ToolError(`The PDF is larger than ${MAX_PDF_BYTES / 1024 / 1024} MB.`)
  // The header may follow a little junk; readers look in the first 1 KB.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024))
  if (!head.includes('%PDF-')) throw new ToolError('That file is not a PDF (no %PDF- header).')
  return new Uint8Array(bytes)
}

async function download(url: string): Promise<Uint8Array> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ToolError('pdf_url is not a valid URL.')
  }
  if (parsed.protocol !== 'https:') throw new ToolError('pdf_url must use https.')
  let response: Response
  try {
    response = await fetch(parsed.toString(), { redirect: 'follow', headers: { Accept: 'application/pdf' } })
  } catch (error) {
    throw new ToolError(`Could not download pdf_url: ${(error as Error).message}`)
  }
  if (!response.ok) throw new ToolError(`Downloading pdf_url returned HTTP ${response.status}.`)
  const tooLarge = () => new ToolError(`The PDF is larger than ${MAX_PDF_BYTES / 1024 / 1024} MB.`)
  if (Number(response.headers.get('content-length') ?? 0) > MAX_PDF_BYTES) throw tooLarge()
  // Stop reading once the limit is passed, whatever Content-Length said.
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array(await response.arrayBuffer())
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_PDF_BYTES) {
      await reader.cancel()
      throw tooLarge()
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** Reads the PDF a tool was given as pdf_base64 or pdf_url. */
export async function readPdfArgument(args: Record<string, unknown>): Promise<Uint8Array<ArrayBuffer>> {
  const inline = args.pdf_base64
  const url = args.pdf_url
  if (typeof inline === 'string' && inline) return assertPdf(decodeBase64(inline))
  if (typeof url === 'string' && url) return assertPdf(await download(url))
  throw new ToolError('Give the PDF as pdf_base64 or pdf_url.')
}
