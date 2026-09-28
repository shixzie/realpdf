import fontkit from '@pdf-lib/fontkit'
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  StandardFonts,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  type PDFObject,
} from 'pdf-lib'
import { loadFallbackFontBytes } from '../fonts/fallback'
import { createCmsSignature, sha256, toHex } from './cms'
import type { SigningIdentity } from './identity'

/**
 * Signs a PDF with an incremental update: the input bytes are kept verbatim
 * and the signature field, its appearance and the signature dictionary are
 * appended after them with a new cross-reference section. Signatures already
 * in the file therefore stay valid, and the new one covers everything except
 * its own /Contents string (the /ByteRange gap), as ISO 32000 requires.
 */

/** Where the signature goes: a new box, an existing empty field, or nowhere visible. */
export type SignaturePlacement =
  | {
      kind: 'box'
      /** Zero-based page index in the document being signed. */
      pageIndex: number
      /** Widget rectangle in PDF user space: [x1, y1, x2, y2]. */
      rect: [number, number, number, number]
    }
  | { kind: 'field'; name: string }
  | { kind: 'invisible' }

export interface SignatureLine {
  text: string
  bold?: boolean
  /** Relative size; 1 is the body size. */
  scale?: number
}

export interface SignOptions {
  identity: SigningIdentity
  placement: SignaturePlacement
  /** Text drawn in a visible signature. */
  lines?: SignatureLine[]
  /** PNG of the handwritten signature, drawn beside the text in a visible signature. */
  image?: Uint8Array
  reason?: string
  location?: string
  contactInfo?: string
  /** Certification (DocMDP) signature: later changes other than form filling and signing invalidate it. */
  certify?: boolean
  date?: Date
}

export class SignError extends Error {
  readonly code: 'encrypted' | 'alreadyCertified' | 'noField' | 'tooLarge' | 'certified' | 'certifiedLocked'
  constructor(code: SignError['code']) {
    super(code)
    this.code = code
  }
}

const BYTE_RANGE_PLACEHOLDER = '**********'
const encoder = new TextEncoder()

function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let out = ''
  for (let i = start; i < end; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(end, i + 0x8000)))
  }
  return out
}

interface XrefTail {
  offset: number
  isStream: boolean
  size: number
}

/** Reads the last `startxref` and the /Size of the section it points to. */
function readXrefTail(bytes: Uint8Array): XrefTail | null {
  const tail = latin1(bytes, Math.max(0, bytes.length - 2048))
  const match = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail)
  if (!match) return null
  const offset = Number(match[1])
  if (!Number.isFinite(offset) || offset <= 0 || offset >= bytes.length) return null
  const head = latin1(bytes, offset, Math.min(bytes.length, offset + 64))
  if (/^\s*xref\b/.test(head)) {
    const trailerAt = latin1(bytes, offset).indexOf('trailer')
    if (trailerAt < 0) return null
    const size = /\/Size\s+(\d+)/.exec(latin1(bytes, offset + trailerAt, Math.min(bytes.length, offset + trailerAt + 4096)))
    return size ? { offset, isStream: false, size: Number(size[1]) } : null
  }
  if (/^\s*\d+\s+\d+\s+obj\b/.test(head)) {
    const dict = latin1(bytes, offset, Math.min(bytes.length, offset + 4096))
    const streamAt = dict.indexOf('stream')
    const size = /\/Size\s+(\d+)/.exec(streamAt > 0 ? dict.slice(0, streamAt) : dict)
    return size && /\/Type\s*\/XRef/.test(dict) ? { offset, isStream: true, size: Number(size[1]) } : null
  }
  return null
}

function pdfDate(date: Date): string {
  const pad = (value: number) => String(Math.floor(Math.abs(value))).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const zone = offset === 0 ? 'Z' : `${offset > 0 ? '+' : '-'}${pad(offset / 60)}'${pad(offset % 60)}'`
  return (
    `D:${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${zone}`
  )
}

interface FieldEntry {
  ref: PDFRef | null
  dict: PDFDict
  /** Fully qualified name (`parent.child`). */
  name: string
  /** Field type, inherited from ancestors. */
  type: string | null
}

function collectFields(doc: PDFDocument): FieldEntry[] {
  const acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)
  const out: FieldEntry[] = []
  const visit = (array: PDFArray | undefined, prefix: string, inheritedType: string | null, depth: number) => {
    if (!array || depth > 32) return
    for (let i = 0; i < array.size(); i += 1) {
      const entry = array.get(i)
      const dict = array.lookupMaybe(i, PDFDict)
      if (!dict) continue
      const partial = dict.lookup(PDFName.of('T'))
      const own = partial instanceof PDFString || partial instanceof PDFHexString ? partial.decodeText() : ''
      const name = own ? (prefix ? `${prefix}.${own}` : own) : prefix
      const ft = dict.get(PDFName.of('FT'))
      const type = ft instanceof PDFName ? ft.decodeText() : inheritedType
      if (own) out.push({ ref: entry instanceof PDFRef ? entry : null, dict, name, type })
      visit(dict.lookupMaybe(PDFName.of('Kids'), PDFArray), name, type, depth + 1)
    }
  }
  visit(acroForm?.lookupMaybe(PDFName.of('Fields'), PDFArray), '', null, 0)
  return out
}

function isSigned(field: FieldEntry): boolean {
  return field.type === 'Sig' && field.dict.get(PDFName.of('V')) !== undefined
}

function isEmptySignatureField(field: FieldEntry): boolean {
  return field.type === 'Sig' && field.dict.get(PDFName.of('V')) === undefined
}

/** The widget annotation of a field: the field itself, or its first widget kid. */
function widgetOf(field: FieldEntry): { ref: PDFRef | null; dict: PDFDict } | null {
  const subtype = field.dict.get(PDFName.of('Subtype'))
  if (subtype instanceof PDFName && subtype.decodeText() === 'Widget') return { ref: field.ref, dict: field.dict }
  const kids = field.dict.lookupMaybe(PDFName.of('Kids'), PDFArray)
  for (let i = 0; i < (kids?.size() ?? 0); i += 1) {
    const kid = kids?.lookupMaybe(i, PDFDict)
    const kidType = kid?.get(PDFName.of('Subtype'))
    if (kid && kidType instanceof PDFName && kidType.decodeText() === 'Widget') {
      const ref = kids?.get(i)
      return { ref: ref instanceof PDFRef ? ref : null, dict: kid }
    }
  }
  return null
}

function pageIndexOf(doc: PDFDocument, widget: { ref: PDFRef | null; dict: PDFDict }): number {
  const pages = doc.getPages()
  if (widget.ref) {
    const index = pages.findIndex((page) => {
      const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
      return Boolean(annots?.asArray().some((entry) => entry === widget.ref))
    })
    if (index >= 0) return index
  }
  const owner = widget.dict.get(PDFName.of('P'))
  return Math.max(0, pages.findIndex((page) => page.ref === owner))
}

function rectOf(dict: PDFDict): [number, number, number, number] {
  const rect = dict.lookupMaybe(PDFName.of('Rect'), PDFArray)
  const values = [0, 1, 2, 3].map((index) => {
    const value = rect?.lookup(index)
    return value instanceof PDFNumber ? value.asNumber() : 0
  })
  return [
    Math.min(values[0], values[2]),
    Math.min(values[1], values[3]),
    Math.max(values[0], values[2]),
    Math.max(values[1], values[3]),
  ]
}

export interface SignatureFieldInfo {
  name: string
  /** Who should sign here (the field's tooltip), when the sender said. */
  label?: string
  pageIndex: number
  rect: [number, number, number, number]
}

export interface SignatureSummary {
  /** Number of signed signature fields. */
  signed: number
  /** Empty signature fields a signer can fill in. */
  empty: SignatureFieldInfo[]
  /** True when a certification signature (DocMDP) is present. */
  certified: boolean
  encrypted: boolean
}

/**
 * The DocMDP permission of the document's certification signature (1 no
 * changes, 2 form filling and signing, 3 also annotations), or null when the
 * document is not certified.
 */
function certificationPermission(doc: PDFDocument): 1 | 2 | 3 | null {
  const signature = doc.catalog.lookupMaybe(PDFName.of('Perms'), PDFDict)?.lookupMaybe(PDFName.of('DocMDP'), PDFDict)
  if (!signature) return null
  const references = signature.lookupMaybe(PDFName.of('Reference'), PDFArray)
  for (let i = 0; i < (references?.size() ?? 0); i += 1) {
    const params = references?.lookupMaybe(i, PDFDict)?.lookupMaybe(PDFName.of('TransformParams'), PDFDict)
    const p = params?.lookup(PDFName.of('P'))
    if (p instanceof PDFNumber && (p.asNumber() === 1 || p.asNumber() === 3)) return p.asNumber() as 1 | 3
  }
  return 2
}

/**
 * A certification allows only some later changes. With P=1 nothing may be
 * added; with P=2 signers may only fill existing signature fields, since a
 * new field breaks the certification. P=3 also allows annotations.
 */
function checkCertification(doc: PDFDocument, addsField: boolean) {
  const permission = certificationPermission(doc)
  if (permission === 1) throw new SignError('certifiedLocked')
  if (permission === 2 && addsField) throw new SignError('certified')
}

/** Existing signatures and empty signature fields (all empty for unreadable files). */
export async function readSignatureSummary(bytes: Uint8Array): Promise<SignatureSummary> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
    const fields = collectFields(doc)
    const empty: SignatureFieldInfo[] = []
    for (const field of fields.filter(isEmptySignatureField)) {
      const widget = widgetOf(field)
      if (!widget) continue
      const rect = rectOf(widget.dict)
      if (rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1) continue
      const tooltip = field.dict.lookup(PDFName.of('TU'))
      const label = tooltip instanceof PDFString || tooltip instanceof PDFHexString ? tooltip.decodeText().trim() : ''
      empty.push({ name: field.name, pageIndex: pageIndexOf(doc, widget), rect, ...(label ? { label } : {}) })
    }
    const perms = doc.catalog.lookupMaybe(PDFName.of('Perms'), PDFDict)
    return {
      signed: fields.filter(isSigned).length,
      empty,
      certified: Boolean(perms?.get(PDFName.of('DocMDP'))),
      encrypted: doc.isEncrypted,
    }
  } catch {
    return { signed: 0, empty: [], certified: false, encrypted: false }
  }
}

function uniqueFieldName(taken: Set<string>): string {
  let index = 1
  while (taken.has(`Signature${index}`)) index += 1
  taken.add(`Signature${index}`)
  return `Signature${index}`
}

interface Faces {
  regular: PDFFont
  bold: PDFFont
}

async function appearanceFonts(doc: PDFDocument, lines: SignatureLine[]): Promise<Faces> {
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const encodable = lines.every((line) => {
    try {
      ;(line.bold ? bold : regular).encodeText(line.text)
      return true
    } catch {
      return false
    }
  })
  if (encodable) return { regular, bold }
  // Names and places outside WinAnsi use the bundled Noto Sans subset.
  const noto = await loadFallbackFontBytes()
  if (!noto) return { regular, bold }
  doc.registerFontkit(fontkit)
  const font = await doc.embedFont(noto, { subset: true })
  return { regular: font, bold: font }
}

function safeText(font: PDFFont, text: string): string {
  try {
    font.encodeText(text)
    return text
  } catch {
    return Array.from(text)
      .map((char) => {
        try {
          font.encodeText(char)
          return char
        } catch {
          return '?'
        }
      })
      .join('')
  }
}

interface Area {
  x: number
  y: number
  width: number
  height: number
}

/** Text lines stacked from the top of `area`, shrunk to fit its width and height. */
function lineOps(lines: SignatureLine[], faces: Faces, area: Area): string {
  const prepared = lines
    .filter((line) => line.text.trim())
    .map((line) => {
      const font = line.bold ? faces.bold : faces.regular
      const text = safeText(font, line.text)
      return { font, text, scale: line.scale ?? 1, unitWidth: font.widthOfTextAtSize(text, 1) }
    })
  const leading = 1.22
  const totalScale = prepared.reduce((sum, line) => sum + line.scale * leading, 0) || 1
  const body = Math.max(2, Math.min(11, area.height / totalScale))

  let ops = 'q\n0.08 0.16 0.35 rg\n'
  let cursor = area.y + area.height
  for (const line of prepared) {
    const size = Math.max(1.5, Math.min(body * line.scale, area.width / Math.max(line.unitWidth, 0.001)))
    cursor -= body * line.scale * leading
    const baseline = cursor + body * line.scale * (leading - 1) + size * 0.22
    const name = line.font === faces.bold && faces.bold !== faces.regular ? '/F2' : '/F1'
    ops += `BT ${name} ${size.toFixed(3)} Tf ${area.x.toFixed(3)} ${baseline.toFixed(3)} Td ${line.font.encodeText(line.text).toString()} Tj ET\n`
  }
  return `${ops}Q\n`
}

/**
 * Draws the appearance in an upright box of `width` x `height` (the box as
 * the viewer shows it). /Matrix undoes the page rotation so the text reads
 * horizontally on screen. With a handwritten image, a wide box puts the image
 * on the left and the text on the right; a squarer one puts the text below.
 */
async function buildAppearance(
  doc: PDFDocument,
  lines: SignatureLine[],
  width: number,
  height: number,
  rotation: number,
  image?: PDFImage,
) {
  const faces = await appearanceFonts(doc, lines)
  const pad = Math.min(4, width * 0.05, height * 0.08)
  const inner: Area = { x: pad, y: pad, width: Math.max(1, width - pad * 2), height: Math.max(1, height - pad * 2) }

  let ops = ''
  if (image) {
    let picture: Area
    let text: Area
    if (inner.width / inner.height >= 2.4) {
      const split = inner.width * 0.55
      picture = { ...inner, width: split }
      text = { x: inner.x + split + pad, y: inner.y, width: Math.max(1, inner.width - split - pad), height: inner.height }
    } else {
      const textHeight = Math.min(inner.height * 0.34, 26)
      picture = { x: inner.x, y: inner.y + textHeight, width: inner.width, height: Math.max(1, inner.height - textHeight) }
      text = { ...inner, height: textHeight }
    }
    const scale = Math.min(picture.width / image.width, picture.height / image.height)
    const drawnWidth = image.width * scale
    const drawnHeight = image.height * scale
    const left = picture.x + (picture.width - drawnWidth) / 2
    const bottom = picture.y + (picture.height - drawnHeight) / 2
    ops += `q ${drawnWidth.toFixed(3)} 0 0 ${drawnHeight.toFixed(3)} ${left.toFixed(3)} ${bottom.toFixed(3)} cm /Im1 Do Q\n`
    ops += lineOps(lines, faces, text)
  } else {
    ops += lineOps(lines, faces, inner)
  }
  for (const font of new Set([faces.regular, faces.bold])) await font.embed()
  if (image) await image.embed()

  const radians = (rotation * Math.PI) / 180
  const cos = Math.round(Math.cos(radians))
  const sin = Math.round(Math.sin(radians))
  const fonts: Record<string, PDFRef> = { F1: faces.regular.ref }
  if (faces.bold !== faces.regular) fonts.F2 = faces.bold.ref
  const stream = doc.context.flateStream(ops, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, width, height],
    Matrix: [cos, sin, -sin, cos, 0, 0],
    Resources: image ? { Font: fonts, XObject: { Im1: image.ref } } : { Font: fonts },
  })
  return doc.context.register(stream)
}

function serializeObject(ref: PDFRef, object: PDFObject): Uint8Array {
  const head = encoder.encode(`${ref.objectNumber} ${ref.generationNumber} obj\n`)
  const tail = encoder.encode('\nendobj\n')
  const out = new Uint8Array(head.length + object.sizeInBytes() + tail.length)
  out.set(head, 0)
  const written = object.copyBytesInto(out, head.length)
  out.set(tail, head.length + written)
  return out.subarray(0, head.length + written + tail.length)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Groups sorted object numbers into [first, count] runs. */
function runsOf(numbers: number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  for (const number of numbers) {
    const last = runs[runs.length - 1]
    if (last && last[0] + last[1] === number) last[1] += 1
    else runs.push([number, 1])
  }
  return runs
}

function trailerEntries(doc: PDFDocument, size: number, prev: number): string {
  const { Root, Info, ID } = doc.context.trailerInfo
  let entries = `/Size ${size} /Root ${String(Root)} /Prev ${prev}`
  if (Info) entries += ` /Info ${String(Info)}`
  if (ID) entries += ` /ID ${String(ID)}`
  return entries
}

/** A document loaded for an incremental update of the bytes it came from. */
interface Update {
  bytes: Uint8Array
  tail: XrefTail
  doc: PDFDocument
  /** First object number created by this update. */
  firstNew: number
  /** Existing objects this update rewrites. */
  modified: Set<PDFRef>
}

async function openForUpdate(input: Uint8Array): Promise<Update> {
  let bytes = input
  let tail = readXrefTail(bytes)
  if (!tail) {
    // A damaged cross-reference table cannot be extended; rewrite the file once.
    const repaired = await PDFDocument.load(bytes, { updateMetadata: false })
    bytes = await repaired.save({ useObjectStreams: false })
    tail = readXrefTail(bytes)
    if (!tail) throw new Error('Could not read the rewritten PDF')
  }

  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false })
  } catch (error) {
    if ((error as Error)?.name === 'EncryptedPDFError') throw new SignError('encrypted')
    throw error
  }
  const { context } = doc
  if (context.trailerInfo.Encrypt) throw new SignError('encrypted')
  context.largestObjectNumber = Math.max(context.largestObjectNumber, tail.size - 1)
  const catalogRef = context.trailerInfo.Root
  if (!(catalogRef instanceof PDFRef)) throw new Error('The document catalog is not an indirect object')
  return { bytes, tail, doc, firstNew: context.largestObjectNumber + 1, modified: new Set([catalogRef]) }
}

/** Adds a widget annotation to a page's /Annots. */
function attachToPage(update: Update, page: PDFPage, widgetRef: PDFRef) {
  const { context } = update.doc
  const annots = page.node.get(PDFName.of('Annots'))
  if (annots instanceof PDFRef) {
    context.lookup(annots, PDFArray).push(widgetRef)
    update.modified.add(annots)
  } else if (annots instanceof PDFArray) {
    annots.push(widgetRef)
  } else {
    page.node.set(PDFName.of('Annots'), context.obj([widgetRef]))
  }
  update.modified.add(page.ref)
}

/** The /AcroForm dictionary, created when missing; `fields` are appended to its /Fields. */
function acroFormOf(update: Update, fields: PDFRef[]): PDFDict {
  const { context, catalog } = update.doc
  const entry = catalog.get(PDFName.of('AcroForm'))
  let acroForm: PDFDict
  if (entry instanceof PDFRef) {
    acroForm = context.lookup(entry, PDFDict)
    update.modified.add(entry)
  } else if (entry instanceof PDFDict) {
    acroForm = entry
  } else {
    acroForm = context.obj({})
    catalog.set(PDFName.of('AcroForm'), acroForm)
  }
  if (fields.length) {
    const list = acroForm.get(PDFName.of('Fields'))
    if (list instanceof PDFRef) {
      const array = context.lookup(list, PDFArray)
      for (const field of fields) array.push(field)
      update.modified.add(list)
    } else if (list instanceof PDFArray) {
      for (const field of fields) list.push(field)
    } else {
      acroForm.set(PDFName.of('Fields'), context.obj(fields))
    }
  }
  return acroForm
}

/** Serializes the changed and new objects after the original bytes, with a cross-reference section. */
function writeUpdate(update: Update): Uint8Array {
  const { bytes, tail, doc, firstNew, modified } = update
  const { context } = doc
  const refs = new Map<number, PDFRef>()
  for (const ref of modified) refs.set(ref.objectNumber, ref)
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (ref.objectNumber >= firstNew) refs.set(ref.objectNumber, ref)
  }
  const ordered = Array.from(refs.values()).sort((a, b) => a.objectNumber - b.objectNumber)
  const parts: Uint8Array[] = [encoder.encode(bytes[bytes.length - 1] === 0x0a ? '' : '\n')]
  let position = bytes.length + parts[0].length
  const offsets = new Map<number, number>()
  for (const ref of ordered) {
    const chunk = serializeObject(ref, context.lookup(ref) as PDFObject)
    offsets.set(ref.objectNumber, position)
    parts.push(chunk)
    position += chunk.length
  }

  const largest = Math.max(context.largestObjectNumber, ...ordered.map((ref) => ref.objectNumber))
  if (tail.isStream) {
    // Cross-reference stream (PDF 1.5+), matching the section it extends.
    const xrefNumber = largest + 1
    offsets.set(xrefNumber, position)
    const numbers = [...ordered.map((ref) => ref.objectNumber), xrefNumber]
    const rows = new Uint8Array(numbers.length * 7)
    numbers.forEach((number, index) => {
      const offset = offsets.get(number) ?? 0
      const row = index * 7
      rows[row] = 1
      rows[row + 1] = (offset >>> 24) & 0xff
      rows[row + 2] = (offset >>> 16) & 0xff
      rows[row + 3] = (offset >>> 8) & 0xff
      rows[row + 4] = offset & 0xff
      const generation = number === xrefNumber ? 0 : (refs.get(number)?.generationNumber ?? 0)
      rows[row + 5] = (generation >>> 8) & 0xff
      rows[row + 6] = generation & 0xff
    })
    const index = runsOf(numbers).flat().join(' ')
    parts.push(
      encoder.encode(
        `${xrefNumber} 0 obj\n<< /Type /XRef ${trailerEntries(doc, xrefNumber + 1, tail.offset)} ` +
          `/W [1 4 2] /Index [${index}] /Length ${rows.length} >>\nstream\n`,
      ),
      rows,
      encoder.encode(`\nendstream\nendobj\nstartxref\n${position}\n%%EOF\n`),
    )
  } else {
    let table = 'xref\n'
    for (const [first, count] of runsOf(ordered.map((ref) => ref.objectNumber))) {
      table += `${first} ${count}\n`
      for (let number = first; number < first + count; number += 1) {
        const generation = refs.get(number)?.generationNumber ?? 0
        table += `${String(offsets.get(number)).padStart(10, '0')} ${String(generation).padStart(5, '0')} n\r\n`
      }
    }
    table += `trailer\n<< ${trailerEntries(doc, largest + 1, tail.offset)} >>\nstartxref\n${position}\n%%EOF\n`
    parts.push(encoder.encode(table))
  }
  return concat([bytes, ...parts])
}

export interface NewSignatureField {
  /** Zero-based page index. */
  pageIndex: number
  /** Widget rectangle in PDF user space: [x1, y1, x2, y2]. */
  rect: [number, number, number, number]
  /** Who should sign here, stored as the field's tooltip. */
  label?: string
}

/**
 * Adds empty signature fields ("sign here" spots for the people asked to
 * sign) as an incremental update, so signatures already in the file stay valid.
 */
export async function addSignatureFields(input: Uint8Array, fields: NewSignatureField[]): Promise<Uint8Array> {
  if (!fields.length) return input
  const update = await openForUpdate(input)
  const { doc } = update
  const { context } = doc
  checkCertification(doc, true)
  const taken = new Set(collectFields(doc).map((field) => field.name))
  const created: PDFRef[] = []
  for (const field of fields) {
    const page = doc.getPage(Math.max(0, Math.min(doc.getPageCount() - 1, field.pageIndex)))
    const widget = context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      F: 4, // Print
      P: page.ref,
      Rect: field.rect.map((value) => Number(value.toFixed(3))),
    })
    widget.set(PDFName.of('T'), PDFString.of(uniqueFieldName(taken)))
    if (field.label) widget.set(PDFName.of('TU'), PDFHexString.fromText(field.label))
    const ref = context.register(widget)
    attachToPage(update, page, ref)
    created.push(ref)
  }
  acroFormOf(update, created)
  return writeUpdate(update)
}

export async function signPdf(input: Uint8Array, options: SignOptions): Promise<Uint8Array> {
  const update = await openForUpdate(input)
  const { bytes, doc, modified } = update
  const { context, catalog } = doc

  const fields = collectFields(doc)
  if (options.certify && fields.some(isSigned)) throw new SignError('alreadyCertified')
  checkCertification(doc, options.placement.kind !== 'field')
  let target: FieldEntry | null = null
  if (options.placement.kind === 'field') {
    const name = options.placement.name
    target = fields.find((field) => field.name === name && isEmptySignatureField(field)) ?? null
    if (!target?.ref) throw new SignError('noField')
  }

  // Signature dictionary with placeholders for /ByteRange and /Contents.
  const reserve = 4096 + options.identity.certificate.length + options.identity.chain.reduce((sum, cert) => sum + cert.length, 0)
  const contents = PDFHexString.of('0'.repeat(reserve * 2))
  const byteRange = PDFArray.withContext(context)
  byteRange.push(PDFNumber.of(0))
  for (let i = 0; i < 3; i += 1) byteRange.push(PDFName.of(BYTE_RANGE_PLACEHOLDER))
  const signature = context.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'ETSI.CAdES.detached',
    M: PDFString.of(pdfDate(options.date ?? new Date())),
    Prop_Build: { App: { Name: 'RealPDF' } },
  })
  signature.set(PDFName.of('ByteRange'), byteRange)
  signature.set(PDFName.of('Contents'), contents)
  signature.set(PDFName.of('Name'), PDFHexString.fromText(options.identity.info.name))
  if (options.reason) signature.set(PDFName.of('Reason'), PDFHexString.fromText(options.reason))
  if (options.location) signature.set(PDFName.of('Location'), PDFHexString.fromText(options.location))
  if (options.contactInfo) signature.set(PDFName.of('ContactInfo'), PDFHexString.fromText(options.contactInfo))
  if (options.certify) {
    signature.set(
      PDFName.of('Reference'),
      context.obj([
        {
          Type: 'SigRef',
          TransformMethod: 'DocMDP',
          TransformParams: { Type: 'TransformParams', P: 2, V: '1.2' },
        },
      ]),
    )
  }
  const signatureRef = context.register(signature)

  const lines = options.lines ?? []
  const image = options.image ? await doc.embedPng(options.image) : undefined
  const appearanceFor = async (page: PDFPage, rect: [number, number, number, number]) => {
    const [x1, y1, x2, y2] = rect
    const rotation = ((page.getRotation().angle % 360) + 360) % 360
    const quarter = rotation === 90 || rotation === 270
    const width = Math.abs(quarter ? y2 - y1 : x2 - x1)
    const height = Math.abs(quarter ? x2 - x1 : y2 - y1)
    return context.obj({ N: await buildAppearance(doc, lines, width, height, rotation, image) })
  }

  let widgetRef: PDFRef | null = null
  if (target?.ref) {
    // Fill in an existing empty field: set its value and redraw its widget.
    target.dict.set(PDFName.of('V'), signatureRef)
    modified.add(target.ref)
    const widget = widgetOf(target)
    if (widget) {
      const page = doc.getPage(pageIndexOf(doc, widget))
      widget.dict.set(PDFName.of('AP'), await appearanceFor(page, rectOf(widget.dict)))
      if (widget.ref) modified.add(widget.ref)
    }
  } else {
    // A new field merged with its widget annotation.
    const placement = options.placement
    const pageIndex = placement.kind === 'box' ? placement.pageIndex : 0
    const page = doc.getPage(Math.max(0, Math.min(doc.getPageCount() - 1, pageIndex)))
    const widget = context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      F: 132, // Print + Locked
      P: page.ref,
      Rect: placement.kind === 'box' ? placement.rect.map((value) => Number(value.toFixed(3))) : [0, 0, 0, 0],
    })
    widget.set(PDFName.of('T'), PDFString.of(uniqueFieldName(new Set(fields.map((field) => field.name)))))
    widget.set(PDFName.of('V'), signatureRef)
    if (placement.kind === 'box') {
      widget.set(PDFName.of('AP'), await appearanceFor(page, placement.rect))
    } else {
      const empty = context.formXObject([], { BBox: [0, 0, 0, 0] })
      widget.set(PDFName.of('AP'), context.obj({ N: context.register(empty) }))
    }
    widgetRef = context.register(widget)
    attachToPage(update, page, widgetRef)
  }

  const acroForm = acroFormOf(update, widgetRef ? [widgetRef] : [])
  acroForm.set(PDFName.of('SigFlags'), PDFNumber.of(3))
  if (options.certify) catalog.set(PDFName.of('Perms'), context.obj({ DocMDP: signatureRef }))

  const output = writeUpdate(update)

  // Fill in /ByteRange around the /Contents placeholder, then sign.
  const written = latin1(output, bytes.length)
  const placeholder = contents.toString()
  const contentsAt = written.indexOf(placeholder)
  const rangeText = byteRange.toString()
  const rangeAt = written.indexOf(rangeText)
  if (contentsAt < 0 || rangeAt < 0) throw new Error('Signature placeholders not found')
  const gapStart = bytes.length + contentsAt
  const gapEnd = gapStart + placeholder.length
  const ranges = [0, gapStart, gapEnd, output.length - gapEnd]
  const rangeValue = `[${ranges.join(' ')}]`
  if (rangeValue.length > rangeText.length) throw new Error('Signature byte range does not fit')
  output.set(encoder.encode(rangeValue.padEnd(rangeText.length, ' ')), bytes.length + rangeAt)

  const digest = await sha256(output.subarray(0, gapStart), output.subarray(gapEnd))
  const cms = await createCmsSignature(options.identity, digest)
  const hex = toHex(cms)
  if (hex.length > placeholder.length - 2) throw new SignError('tooLarge')
  output.set(encoder.encode(hex), gapStart + 1)
  return output
}
