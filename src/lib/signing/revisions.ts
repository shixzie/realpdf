import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream, type PDFObject } from 'pdf-lib'

/**
 * What changed in a PDF after a signature: compares the revision a signature
 * covers with the whole file, object by object. Adding signatures is what
 * incremental updates after a signature are for, so these changes are
 * allowed: filling an empty signature field, adding signature fields and
 * their widgets, and the bookkeeping that comes with them (the AcroForm, the
 * page /Annots, document info, XMP metadata, validation data). Anything else,
 * such as new page content, other annotations, form values or catalog actions,
 * changes what the earlier signers saw.
 *
 * pdf-lib reads objects in file order rather than through the cross-reference
 * table, so an update that defines an object twice is treated as a change too.
 */

export interface LaterChanges {
  /** Signature fields or widgets were added after the signature. */
  addedSignatureFields: boolean
  /** Annotations other than signature widgets were added. */
  addedAnnotations: boolean
  /** Changes other than the above: new content, form values, actions, removed pages. */
  other: string[]
}

const CATALOG_KEYS = new Set(['AcroForm', 'DSS', 'Extensions', 'Metadata'])
const ACROFORM_KEYS = new Set(['Fields', 'SigFlags', 'DR'])
const SIGNATURE_FIELD_KEYS = new Set(['V', 'AP'])

function sameObject(a: PDFObject | undefined, b: PDFObject | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.constructor !== b.constructor) return false
  if (a instanceof PDFStream && b instanceof PDFStream) {
    if (a.dict.toString() !== b.dict.toString()) return false
    const x = a.getContents()
    const y = b.getContents()
    return x.length === y.length && x.every((byte, index) => byte === y[index])
  }
  return a.toString() === b.toString()
}

function changedKeys(before: PDFDict, after: PDFDict): string[] {
  const keys = new Set([...before.keys(), ...after.keys()].map((key) => key.decodeText()))
  return [...keys].filter((key) => !sameObject(before.get(PDFName.of(key)), after.get(PDFName.of(key))))
}

function nameOf(dict: PDFDict | undefined, key: string): string | null {
  const value = dict?.get(PDFName.of(key))
  return value instanceof PDFName ? value.decodeText() : null
}

/** The field type of a field or widget, inherited through /Parent. */
function fieldType(dict: PDFDict | undefined): string | null {
  let current = dict
  for (let depth = 0; current && depth < 32; depth += 1) {
    const type = nameOf(current, 'FT')
    if (type) return type
    current = current.lookupMaybe(PDFName.of('Parent'), PDFDict)
  }
  return null
}

function isSignatureWidget(dict: PDFDict | undefined): boolean {
  return nameOf(dict, 'Subtype') === 'Widget' && fieldType(dict) === 'Sig'
}

/** Entries of `after` that are not in `before`, or null when an entry was removed or reordered. */
function addedEntries(before: PDFArray | undefined, after: PDFArray | undefined): PDFObject[] | null {
  const old = before?.asArray() ?? []
  const next = after?.asArray() ?? []
  if (next.length < old.length) return null
  for (let i = 0; i < old.length; i += 1) if (!sameObject(old[i], next[i])) return null
  return next.slice(old.length)
}

/**
 * Object numbers with an `N G obj` header after `from`, and those defined more
 * than once inside one incremental update.
 */
function objectHeaders(bytes: Uint8Array, from: number): { defined: Set<number>; repeated: number[] } {
  let text = ''
  for (let i = from; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000)))
  }
  const defined = new Set<number>()
  const repeated = new Set<number>()
  for (const section of text.split('%%EOF')) {
    const seen = new Set<number>()
    for (const match of section.matchAll(/(?:^|[^\d])(\d+)\s+\d+\s+obj\b/g)) {
      const number = Number(match[1])
      if (seen.has(number)) repeated.add(number)
      seen.add(number)
      defined.add(number)
    }
  }
  return { defined, repeated: [...repeated] }
}

/**
 * Compares the revision that ends at `end` with the whole file. `final` is
 * the whole file, already loaded.
 */
export async function laterChanges(bytes: Uint8Array, end: number, final: PDFDocument): Promise<LaterChanges> {
  const result: LaterChanges = { addedSignatureFields: false, addedAnnotations: false, other: [] }
  if (end >= bytes.length) return result

  let signed: PDFDocument
  try {
    signed = await PDFDocument.load(bytes.subarray(0, end), { ignoreEncryption: true, updateMetadata: false })
  } catch {
    result.other.push('the signed revision cannot be read on its own')
    return result
  }
  const headers = objectHeaders(bytes, end)
  for (const number of headers.repeated) result.other.push(`object ${number} is defined twice in one update`)

  const before = signed.context
  const after = final.context
  if (before.trailerInfo.Root !== after.trailerInfo.Root) result.other.push('the document catalog was replaced')

  const beforePages = signed.getPages().map((page) => page.ref)
  const afterPages = final.getPages().map((page) => page.ref)
  if (beforePages.length !== afterPages.length || beforePages.some((ref, index) => ref !== afterPages[index])) {
    result.other.push('pages were added, removed or reordered')
  }

  // Objects whose changes are allowed, and how.
  const catalogRef = before.trailerInfo.Root instanceof PDFRef ? before.trailerInfo.Root : null
  const acroFormValue = signed.catalog.get(PDFName.of('AcroForm'))
  const acroFormRef = acroFormValue instanceof PDFRef ? acroFormValue : null
  const acroForm = signed.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)
  const fieldsValue = acroForm?.get(PDFName.of('Fields'))
  const fieldsRef = fieldsValue instanceof PDFRef ? fieldsValue : null
  const pageRefs = new Set(beforePages)
  const annotsRefs = new Set<PDFRef>()
  for (const page of signed.getPages()) {
    const annots = page.node.get(PDFName.of('Annots'))
    if (annots instanceof PDFRef) annotsRefs.add(annots)
  }
  const infoRef = before.trailerInfo.Info instanceof PDFRef ? before.trailerInfo.Info : null
  const metadata = signed.catalog.get(PDFName.of('Metadata'))

  const added: PDFObject[] = []
  const growOnly = (label: string, old: PDFArray | undefined, next: PDFArray | undefined) => {
    const entries = addedEntries(old, next)
    if (entries) added.push(...entries)
    else result.other.push(`entries were removed from ${label}`)
  }
  // A changed /Fields entry (inline array or a different array object) is checked here;
  // an array object edited in place is checked where it is enumerated below.
  const checkAcroForm = (old: PDFDict | undefined, next: PDFDict | undefined) => {
    if (!next) return result.other.push('the form was removed')
    const keys = old ? changedKeys(old, next) : next.keys().map((key) => key.decodeText())
    for (const key of keys) {
      if (!ACROFORM_KEYS.has(key)) result.other.push(`the form's /${key} changed`)
    }
    if (keys.includes('Fields')) {
      growOnly('the form fields', old?.lookupMaybe(PDFName.of('Fields'), PDFArray), next.lookupMaybe(PDFName.of('Fields'), PDFArray))
    }
  }

  const bookkeeping = new Set<PDFRef | null>([catalogRef, acroFormRef, fieldsRef, infoRef, ...pageRefs, ...annotsRefs])
  for (const [ref, object] of before.enumerateIndirectObjects()) {
    const next = after.lookup(ref)
    if (object instanceof PDFStream && ['XRef', 'ObjStm'].includes(nameOf(object.dict, 'Type') ?? '')) continue
    if (sameObject(object, next)) {
      // Rewritten, yet the file-order read sees the old version: a reader following
      // the cross-reference table may see a different one.
      if (headers.defined.has(ref.objectNumber) && !bookkeeping.has(ref) && ref !== metadata) {
        result.other.push(`object ${ref.objectNumber} is rewritten in an update but reads unchanged`)
      }
      continue
    }
    if (ref === infoRef || ref === metadata) continue
    const label = `object ${ref.objectNumber}`
    if (ref === catalogRef && object instanceof PDFDict && next instanceof PDFDict) {
      const keys = changedKeys(object, next)
      for (const key of keys) {
        if (!CATALOG_KEYS.has(key)) result.other.push(`the document catalog's /${key} changed`)
      }
      if (keys.includes('AcroForm')) checkAcroForm(acroForm, next.lookupMaybe(PDFName.of('AcroForm'), PDFDict))
    } else if (ref === acroFormRef && object instanceof PDFDict) {
      checkAcroForm(object, next instanceof PDFDict ? next : undefined)
    } else if ((ref === fieldsRef || annotsRefs.has(ref)) && object instanceof PDFArray) {
      growOnly(label, object, next instanceof PDFArray ? next : undefined)
    } else if (pageRefs.has(ref) && object instanceof PDFDict && next instanceof PDFDict) {
      const keys = changedKeys(object, next)
      for (const key of keys) {
        if (key !== 'Annots') result.other.push(`a page's /${key} changed`)
      }
      if (keys.includes('Annots')) {
        growOnly('a page\'s annotations', object.lookupMaybe(PDFName.of('Annots'), PDFArray), next.lookupMaybe(PDFName.of('Annots'), PDFArray))
      }
    } else if (
      object instanceof PDFDict &&
      next instanceof PDFDict &&
      fieldType(object) === 'Sig' &&
      !object.has(PDFName.of('V')) &&
      !isSignedParent(object)
    ) {
      // Filling an empty signature field: its value and its appearance.
      for (const key of changedKeys(object, next)) {
        if (!SIGNATURE_FIELD_KEYS.has(key)) result.other.push(`signature field ${label}'s /${key} changed`)
      }
    } else {
      result.other.push(`${label} changed`)
    }
  }

  for (const entry of added) {
    const dict = entry instanceof PDFRef ? after.lookupMaybe(entry, PDFDict) : entry instanceof PDFDict ? entry : undefined
    if (!dict) continue
    if (nameOf(dict, 'Subtype') === 'Widget' ? isSignatureWidget(dict) : fieldType(dict) === 'Sig') {
      result.addedSignatureFields = true
    } else if (nameOf(dict, 'Subtype') && nameOf(dict, 'Subtype') !== 'Widget') {
      result.addedAnnotations = true
    } else {
      result.other.push('form fields other than signature fields were added')
    }
  }
  return result
}

/** A widget whose parent field already carries a signature value. */
function isSignedParent(dict: PDFDict): boolean {
  const parent = dict.lookupMaybe(PDFName.of('Parent'), PDFDict)
  return Boolean(parent?.has(PDFName.of('V')))
}
