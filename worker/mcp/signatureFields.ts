import { PDFArray, PDFDocument, PDFName, PDFSignature, PDFString } from 'pdf-lib'
import { ToolError } from './protocol'

/** An empty signature field to add before a document is sent for signing. */
export interface SignatureFieldSpec {
  /** Field name; signers pick the field by it, so use the signer's name or role. */
  name: string
  /** One-based page number. */
  page: number
  /** Lower-left corner in PDF points from the page's bottom-left. */
  x: number
  y: number
  width: number
  height: number
}

export const signatureFieldsSchema = {
  type: 'array',
  description:
    'Optional empty signature fields to add, one per signer, so each person signs in the right place and ' +
    'get_signing_request can tell who is still pending. Coordinates are PDF points (1/72 inch) from the ' +
    "page's bottom-left corner. Omit to let signers place their own signature.",
  maxItems: 20,
  items: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Field name, e.g. the signer\'s name or role ("Client").', minLength: 1, maxLength: 100 },
      page: { type: 'integer', minimum: 1, description: 'One-based page number.' },
      x: { type: 'number', minimum: 0 },
      y: { type: 'number', minimum: 0 },
      width: { type: 'number', exclusiveMinimum: 0 },
      height: { type: 'number', exclusiveMinimum: 0 },
    },
    required: ['name', 'page', 'x', 'y', 'width', 'height'],
    additionalProperties: false,
  },
} as const

export function parseSignatureFields(value: unknown): SignatureFieldSpec[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new ToolError('signature_fields must be an array.')
  if (value.length > 20) throw new ToolError('signature_fields can have at most 20 fields.')
  const names = new Set<string>()
  return value.map((entry, index) => {
    const field = entry as Record<string, unknown>
    const name = typeof field?.name === 'string' ? field.name.trim() : ''
    const numbers = ['page', 'x', 'y', 'width', 'height'].map((key) => field?.[key])
    if (!name || name.length > 100 || name.includes('.')) {
      throw new ToolError(`signature_fields[${index}].name must be 1-100 characters without dots.`)
    }
    if (names.has(name)) throw new ToolError(`Two signature fields are named "${name}".`)
    names.add(name)
    if (!numbers.every((number) => typeof number === 'number' && Number.isFinite(number))) {
      throw new ToolError(`signature_fields[${index}] needs numeric page, x, y, width and height.`)
    }
    const [page, x, y, width, height] = numbers as number[]
    if (!Number.isInteger(page) || page < 1 || width <= 0 || height <= 0) {
      throw new ToolError(`signature_fields[${index}] has an invalid page or size.`)
    }
    return { name, page, x, y, width, height }
  })
}

/**
 * Adds empty signature fields (merged field/widget annotations). The file is
 * rewritten, which would break existing signatures, so signed PDFs are refused.
 */
export async function addSignatureFields(bytes: Uint8Array, fields: SignatureFieldSpec[]): Promise<Uint8Array> {
  if (!fields.length) return bytes
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false })
  } catch (error) {
    if ((error as Error)?.name === 'EncryptedPDFError') throw new ToolError('The PDF is password-protected.')
    throw new ToolError(`Could not read the PDF: ${(error as Error).message}`)
  }
  const form = doc.getForm()
  if (form.getFields().some((field) => field instanceof PDFSignature && field.acroField.dict.has(PDFName.of('V')))) {
    throw new ToolError('The PDF is already signed; adding fields would invalidate the signature. Send it without signature_fields.')
  }
  const taken = new Set(form.getFields().map((field) => field.getName()))
  const pages = doc.getPages()
  const acroForm = form.acroForm
  for (const spec of fields) {
    if (taken.has(spec.name)) throw new ToolError(`The PDF already has a field named "${spec.name}".`)
    const page = pages[spec.page - 1]
    if (!page) throw new ToolError(`Page ${spec.page} does not exist; the PDF has ${pages.length} page(s).`)
    const widget = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      F: 4, // Print
      P: page.ref,
      Rect: [spec.x, spec.y, spec.x + spec.width, spec.y + spec.height],
    })
    widget.set(PDFName.of('T'), PDFString.of(spec.name))
    const ref = doc.context.register(widget)
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
    if (annots) annots.push(ref)
    else page.node.set(PDFName.of('Annots'), doc.context.obj([ref]))
    acroForm.addField(ref)
  }
  return doc.save({ useObjectStreams: false })
}
