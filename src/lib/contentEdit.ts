import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFContext,
  type PDFPage,
  type PDFPageLeaf,
} from 'pdf-lib'
import { deflate } from 'pako'

/**
 * Real text editing for text that already lives in the PDF.
 *
 * Painting a rectangle over an edited run leaves the original glyphs in the
 * file: they stay searchable, copyable and visible wherever the cover colour
 * does not match the artwork. Instead this module rewrites the page's content
 * streams and drops the text-showing operators that drew the run.
 *
 * The walk mirrors pdf.js' text-content evaluator (`getTextContent` in
 * `pdf.worker`) — same graphics-state stack, same text-matrix handling, same
 * text rendering matrix and same form-XObject recursion — so every show-text
 * operator lands at exactly the position pdf.js reported for the text item the
 * user clicked.
 *
 * Show operators that follow each other without a positioning operator advance
 * by glyph widths this walker does not measure, so they are treated as one
 * run: the run is deleted only when the retyped text accounts for every glyph
 * in it and every operator of the run can be edited. Otherwise the caller
 * falls back to its background cover, which is why only the targets that were
 * really removed are returned.
 */

type Mat = [number, number, number, number, number, number]

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0]
const MAX_FORM_DEPTH = 12

/** pdf.js `Util.transform`: apply `first`, then `second`. */
function concat(first: Mat, second: Mat): Mat {
  return [
    first[0] * second[0] + first[2] * second[1],
    first[1] * second[0] + first[3] * second[1],
    first[0] * second[2] + first[2] * second[3],
    first[1] * second[2] + first[3] * second[3],
    first[0] * second[4] + first[2] * second[5] + first[4],
    first[1] * second[4] + first[3] * second[5] + first[5],
  ]
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])

function isWhitespace(byte: number): boolean {
  return WHITESPACE.has(byte)
}

function isDelimiter(byte: number): boolean {
  return (
    byte === 0x28 ||
    byte === 0x29 ||
    byte === 0x3c ||
    byte === 0x3e ||
    byte === 0x5b ||
    byte === 0x5d ||
    byte === 0x7b ||
    byte === 0x7d ||
    byte === 0x2f ||
    byte === 0x25
  )
}

function isRegular(byte: number): boolean {
  return !isWhitespace(byte) && !isDelimiter(byte)
}

function latin1(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i])
  return out
}

function ascii(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length)
  for (let i = 0; i < value.length; i += 1) bytes[i] = value.charCodeAt(i) & 0xff
  return bytes
}

interface NumberToken {
  kind: 'number'
  value: number
  raw: string
  start: number
  end: number
}

interface NameToken {
  kind: 'name'
  name: string
  start: number
  end: number
}

interface StringToken {
  kind: 'string'
  start: number
  end: number
  /** Approximate number of glyph codes in the string. */
  byteLength: number
}

interface ArrayToken {
  kind: 'array'
  items: Token[]
  start: number
  end: number
}

interface SimpleToken {
  kind: 'keyword' | 'dict'
  start: number
  end: number
}

type Token = NumberToken | NameToken | StringToken | ArrayToken | SimpleToken

interface OperatorToken {
  kind: 'operator'
  name: string
  start: number
  end: number
}

/** Minimal PDF content-stream tokenizer (operands + operators, byte spans). */
class Scanner {
  pos = 0

  constructor(readonly bytes: Uint8Array) {}

  private skipSpace(): void {
    const { bytes } = this
    while (this.pos < bytes.length) {
      const byte = bytes[this.pos]
      if (isWhitespace(byte)) {
        this.pos += 1
        continue
      }
      if (byte === 0x25) {
        while (this.pos < bytes.length && bytes[this.pos] !== 0x0a && bytes[this.pos] !== 0x0d) this.pos += 1
        continue
      }
      break
    }
  }

  next(): Token | OperatorToken | null {
    this.skipSpace()
    const { bytes } = this
    if (this.pos >= bytes.length) return null
    const byte = bytes[this.pos]
    if (byte === 0x28) return this.readLiteralString()
    if (byte === 0x3c) {
      if (bytes[this.pos + 1] === 0x3c) return this.readDict()
      return this.readHexString()
    }
    if (byte === 0x5b) return this.readArray()
    if (byte === 0x2f) return this.readName()
    if (byte === 0x5d || byte === 0x3e || byte === 0x29 || byte === 0x7b) {
      this.pos += 1
      return this.next()
    }
    const start = this.pos
    while (this.pos < bytes.length && isRegular(bytes[this.pos])) this.pos += 1
    if (this.pos === start) {
      this.pos += 1
      return this.next()
    }
    const raw = latin1(bytes.subarray(start, this.pos))
    if (raw === 'true' || raw === 'false' || raw === 'null') {
      return { kind: 'keyword', start, end: this.pos }
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw)) {
      return { kind: 'number', value: Number(raw), raw, start, end: this.pos }
    }
    return { kind: 'operator', name: raw, start, end: this.pos }
  }

  private readLiteralString(): StringToken {
    const start = this.pos
    this.pos += 1
    this.skipLiteralStringBody()
    return { kind: 'string', start, end: this.pos, byteLength: Math.max(0, this.pos - start - 2) }
  }

  /** Advances past a `(...)` body; `pos` must point just after the opening paren. */
  private skipLiteralStringBody(): void {
    const { bytes } = this
    let depth = 1
    while (this.pos < bytes.length && depth > 0) {
      const byte = bytes[this.pos]
      if (byte === 0x5c) {
        this.pos += 2
        continue
      }
      if (byte === 0x28) depth += 1
      else if (byte === 0x29) depth -= 1
      this.pos += 1
    }
  }

  private readHexString(): StringToken {
    const start = this.pos
    this.pos += 1
    while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0x3e) this.pos += 1
    if (this.pos < this.bytes.length) this.pos += 1
    const byteLength = Math.max(0, Math.floor((this.pos - start - 2) / 2))
    return { kind: 'string', start, end: this.pos, byteLength }
  }

  private readName(): NameToken {
    const start = this.pos
    this.pos += 1
    let name = ''
    const { bytes } = this
    while (this.pos < bytes.length && isRegular(bytes[this.pos])) {
      const byte = bytes[this.pos]
      if (byte === 0x23 && this.pos + 2 < bytes.length) {
        const hex = latin1(bytes.subarray(this.pos + 1, this.pos + 3))
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          name += String.fromCharCode(parseInt(hex, 16))
          this.pos += 3
          continue
        }
      }
      name += String.fromCharCode(byte)
      this.pos += 1
    }
    return { kind: 'name', name, start, end: this.pos }
  }

  private readArray(): ArrayToken {
    const start = this.pos
    this.pos += 1
    const items: Token[] = []
    for (;;) {
      this.skipSpace()
      if (this.pos >= this.bytes.length) break
      const at = this.pos
      if (this.bytes[at] === 0x5d) {
        this.pos += 1
        break
      }
      const token = this.next()
      if (!token) break
      if (token.kind !== 'operator') items.push(token)
      if (this.pos <= at) this.pos = at + 1
    }
    return { kind: 'array', items, start, end: this.pos }
  }

  private readDict(): SimpleToken {
    const start = this.pos
    this.pos += 2
    let depth = 1
    const { bytes } = this
    while (this.pos < bytes.length && depth > 0) {
      const byte = bytes[this.pos]
      if (byte === 0x3c && bytes[this.pos + 1] === 0x3c) {
        depth += 1
        this.pos += 2
        continue
      }
      if (byte === 0x3e && bytes[this.pos + 1] === 0x3e) {
        depth -= 1
        this.pos += 2
        continue
      }
      if (byte === 0x28) {
        this.pos += 1
        this.skipLiteralStringBody()
        continue
      }
      this.pos += 1
    }
    return { kind: 'dict', start, end: this.pos }
  }
}

function numberOperands(operands: Token[], count: number): number[] | null {
  if (operands.length < count) return null
  const values: number[] = []
  for (let i = 0; i < count; i += 1) {
    const operand = operands[i]
    if (operand.kind !== 'number') return null
    values.push(operand.value)
  }
  return values
}

interface WalkState {
  ctm: Mat
  fontName: string
  fontSize: number
  textMatrix: Mat
  textLineMatrix: Mat
  leading: number
  hScale: number
  rise: number
  /** True once a show operator advanced the text position without a reset. */
  advanced: boolean
  /** Show operators since the last positioning operator. */
  run: TextRunUnit
}

/**
 * Show operators that follow each other without an explicit positioning
 * operator (`Td`, `Tm`, `T*`, `'`, `"`, `BT`). Their first operator sits at a
 * known point; the rest are advanced by unknown glyph widths, so the whole run
 * is only edited when the retyped text accounts for all of its glyphs.
 */
interface TextRunUnit {
  glyphs: number
  candidates: ShowCandidate[]
}

function newRun(): TextRunUnit {
  return { glyphs: 0, candidates: [] }
}

function cloneState(state: WalkState): WalkState {
  return {
    ...state,
    ctm: state.ctm.slice() as Mat,
    textMatrix: state.textMatrix.slice() as Mat,
    textLineMatrix: state.textLineMatrix.slice() as Mat,
  }
}

function initialState(): WalkState {
  return {
    ctm: IDENTITY.slice() as Mat,
    fontName: '',
    fontSize: 0,
    textMatrix: IDENTITY.slice() as Mat,
    textLineMatrix: IDENTITY.slice() as Mat,
    leading: 0,
    hScale: 1,
    rise: 0,
    advanced: false,
    run: newRun(),
  }
}

interface ShowCandidate {
  stream: PDFStream
  start: number
  end: number
  replacement: Uint8Array | null
  x: number
  y: number
  size: number
  dirX: number
  dirY: number
  /** Glyph codes shown by the operator. */
  glyphBytes: number
  /** True when the active font is composite (two-byte codes). */
  composite: boolean
  /** True when the operator's position is exactly known. */
  reliable: boolean
  run: TextRunUnit
}

interface Encounter {
  resources: PDFDict
  name: string
  stream: PDFStream
  ctmKey: string
}

interface Span {
  start: number
  end: number
  replacement: Uint8Array | null
}

/** A run the user retyped, in PDF user space. */
export interface TextRemovalTarget {
  text: string
  /** Baseline origin. */
  x: number
  y: number
  /** Advance width of the original run. */
  width: number
  /** Effective font size. */
  fontSize: number
  /** Baseline direction, radians. */
  angle: number
}

class PageTextWalker {
  readonly candidates: ShowCandidate[] = []
  readonly encounters: Encounter[] = []
  private readonly walked = new Set<PDFStream>()
  private readonly decoded = new WeakMap<PDFStream, Uint8Array | null>()

  contentBytes(stream: PDFStream): Uint8Array | null {
    const cached = this.decoded.get(stream)
    if (cached !== undefined) return cached
    let bytes: Uint8Array | null = null
    try {
      if (stream instanceof PDFRawStream) {
        // pdf-lib decodes the common filters but ignores predictors; editing a
        // stream whose bytes we cannot trust would corrupt the page.
        bytes = usesPredictor(stream) ? null : decodePDFRawStream(stream).decode()
      } else {
        const candidate = stream as unknown as { getUnencodedContents?: () => Uint8Array }
        bytes = typeof candidate.getUnencodedContents === 'function' ? candidate.getUnencodedContents() : null
      }
    } catch (error) {
      console.warn('Could not decode a content stream for text editing', error)
    }
    this.decoded.set(stream, bytes)
    return bytes
  }

  walk(stream: PDFStream, resources: PDFDict | undefined, initial: WalkState, depth: number): void {
    if (this.walked.has(stream)) return
    this.walked.add(stream)
    const bytes = this.contentBytes(stream)
    if (!bytes) return
    const scanner = new Scanner(bytes)
    const operands: Token[] = []
    const stack: WalkState[] = []
    let state = cloneState(initial)
    for (;;) {
      const token = scanner.next()
      if (!token) break
      if (token.kind !== 'operator') {
        operands.push(token)
        continue
      }
      const op = token.name
      if (op === 'q') {
        stack.push(cloneState(state))
      } else if (op === 'Q') {
        state = stack.pop() ?? state
      } else if (op === 'cm') {
        const values = numberOperands(operands, 6)
        if (values) state.ctm = concat(state.ctm, values as Mat)
      } else if (op === 'BT') {
        this.reposition(state)
        state.textMatrix = IDENTITY.slice() as Mat
        state.textLineMatrix = IDENTITY.slice() as Mat
      } else if (op === 'Tf') {
        const [name, size] = operands
        if (name?.kind === 'name' && size?.kind === 'number') {
          state.fontName = name.name
          state.fontSize = size.value
        }
      } else if (op === 'Tm') {
        const values = numberOperands(operands, 6)
        if (values) {
          this.reposition(state)
          state.textMatrix = values as Mat
          state.textLineMatrix = values.slice() as Mat
        }
      } else if (op === 'Td' || op === 'TD') {
        const values = numberOperands(operands, 2)
        if (values) {
          if (op === 'TD') state.leading = -values[1]
          this.reposition(state)
          state.textLineMatrix = concat(state.textLineMatrix, [1, 0, 0, 1, values[0], values[1]])
          state.textMatrix = state.textLineMatrix.slice() as Mat
        }
      } else if (op === 'T*') {
        this.reposition(state)
        this.nextLine(state)
      } else if (op === 'TL') {
        const values = numberOperands(operands, 1)
        if (values) state.leading = values[0]
      } else if (op === 'Tz') {
        const values = numberOperands(operands, 1)
        if (values) state.hScale = values[0] / 100
      } else if (op === 'Ts') {
        const values = numberOperands(operands, 1)
        if (values) state.rise = values[0]
      } else if (op === 'Tj' || op === 'TJ') {
        this.record(stream, resources, state, token, operands, null)
      } else if (op === "'") {
        this.reposition(state)
        this.nextLine(state)
        this.record(stream, resources, state, token, operands, ascii('T*'))
      } else if (op === '"') {
        this.reposition(state)
        this.nextLine(state)
        const word = operands[0]?.kind === 'number' ? operands[0].raw : '0'
        const char = operands[1]?.kind === 'number' ? operands[1].raw : '0'
        this.record(stream, resources, state, token, operands, ascii(`${word} Tw ${char} Tc T*`))
      } else if (op === 'Do') {
        const name = operands[0]
        if (name?.kind === 'name') this.walkForm(name.name, resources, state, depth)
      } else if (op === 'BI') {
        this.skipInlineImage(scanner, bytes)
      }
      operands.length = 0
    }
  }

  /** A positioning operator: the next show op starts a fresh, known run. */
  private reposition(state: WalkState): void {
    state.advanced = false
    state.run = newRun()
  }

  private nextLine(state: WalkState): void {
    state.textLineMatrix = concat(state.textLineMatrix, [1, 0, 0, 1, 0, -state.leading])
    state.textMatrix = state.textLineMatrix.slice() as Mat
  }

  private record(
    stream: PDFStream,
    resources: PDFDict | undefined,
    state: WalkState,
    token: OperatorToken,
    operands: Token[],
    replacement: Uint8Array | null,
  ): void {
    const tsm: Mat = [state.fontSize * state.hScale, 0, 0, state.fontSize, 0, state.rise]
    const trm = concat(state.ctm, concat(state.textMatrix, tsm))
    const size = Math.hypot(trm[2], trm[3])
    if (!(size > 0)) return
    const scale = Math.hypot(trm[0], trm[1]) || 1
    const first = operands[0]
    let glyphBytes = 0
    if (token.name === 'TJ' && first?.kind === 'array') {
      for (const item of first.items) {
        if (item.kind === 'string') glyphBytes += item.byteLength
      }
    } else {
      const string = operands.find((operand) => operand.kind === 'string')
      glyphBytes = string?.kind === 'string' ? string.byteLength : 0
    }
    const candidate: ShowCandidate = {
      stream,
      start: first ? first.start : token.start,
      end: token.end,
      replacement,
      x: trm[4],
      y: trm[5],
      size,
      dirX: trm[0] / scale,
      dirY: trm[1] / scale,
      glyphBytes,
      composite: this.isCompositeFont(resources, state.fontName),
      reliable: !state.advanced,
      run: state.run,
    }
    state.run.candidates.push(candidate)
    state.run.glyphs += this.glyphCount(candidate)
    state.advanced = true
    this.candidates.push(candidate)
  }

  private glyphCount(candidate: ShowCandidate): number {
    return candidate.composite ? Math.ceil(candidate.glyphBytes / 2) : candidate.glyphBytes
  }

  private isCompositeFont(resources: PDFDict | undefined, name: string): boolean {
    if (!resources || !name) return false
    const fonts = resources.lookupMaybe(PDFName.of('Font'), PDFDict)
    const font = fonts?.lookupMaybe(PDFName.of(name), PDFDict)
    const subtype = font?.lookupMaybe(PDFName.of('Subtype'), PDFName)
    return subtype?.asString() === '/Type0'
  }

  private walkForm(name: string, resources: PDFDict | undefined, state: WalkState, depth: number): void {
    if (!resources) return
    const xobjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict)
    const form = xobjects?.lookupMaybe(PDFName.of(name), PDFStream)
    if (!form) return
    const subtype = form.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)
    if (subtype?.asString() !== '/Form') return
    const ctmKey = state.ctm.map((value) => value.toFixed(4)).join(',')
    this.encounters.push({ resources, name, stream: form, ctmKey })
    if (depth >= MAX_FORM_DEPTH || this.walked.has(form)) return
    const matrix = form.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray)
    const values: number[] | null = matrix
      ? Array.from({ length: matrix.size() }, (_, index) => matrix.lookupMaybe(index, PDFNumber))
          .filter((value): value is PDFNumber => value != null)
          .map((value) => value.asNumber())
      : null
    const formState = cloneState(state)
    if (values && values.length === 6) formState.ctm = concat(state.ctm, values as Mat)
    formState.run = newRun()
    formState.advanced = true
    const formResources = form.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources
    this.walk(form, formResources, formState, depth + 1)
  }

  private skipInlineImage(scanner: Scanner, bytes: Uint8Array): void {
    let token = scanner.next()
    while (token && !(token.kind === 'operator' && token.name === 'ID')) token = scanner.next()
    let pos = scanner.pos
    if (pos < bytes.length) pos += 1
    while (pos < bytes.length - 1) {
      if (bytes[pos] === 0x45 && bytes[pos + 1] === 0x49) {
        const before = pos > 0 ? bytes[pos - 1] : 0x20
        const after = pos + 2 < bytes.length ? bytes[pos + 2] : 0x20
        if (isWhitespace(before) && (pos + 2 >= bytes.length || isWhitespace(after) || isDelimiter(after))) {
          scanner.pos = pos + 2
          return
        }
      }
      pos += 1
    }
    scanner.pos = bytes.length
  }
}

function pageResources(leaf: PDFPageLeaf): PDFDict | undefined {
  const object = leaf.getInheritableAttribute(PDFName.of('Resources'))
  return leaf.context.lookupMaybe(object, PDFDict)
}

/** True when a stream's decode parameters apply a PNG predictor. */
function usesPredictor(stream: PDFRawStream): boolean {
  const parms = stream.dict.lookup(PDFName.of('DecodeParms'))
  const dicts: PDFDict[] = []
  if (parms instanceof PDFDict) dicts.push(parms)
  else if (parms instanceof PDFArray) {
    for (let index = 0; index < parms.size(); index += 1) {
      const entry = parms.lookupMaybe(index, PDFDict)
      if (entry) dicts.push(entry)
    }
  }
  return dicts.some((dict) => {
    const predictor = dict.lookupMaybe(PDFName.of('Predictor'), PDFNumber)
    return predictor != null && predictor.asNumber() > 1
  })
}

/**
 * True when the retyped text accounts for every glyph in the run. Removing a
 * run also removes the text advance it applied, so runs that only partly match
 * a run are left alone and fall back to the background cover.
 */
function coversRun(target: TextRemovalTarget, run: TextRunUnit): boolean {
  return target.text.length >= run.glyphs
}

function applySpans(bytes: Uint8Array, spans: Span[]): Uint8Array {
  const ordered = [...spans].sort((a, b) => a.start - b.start)
  const parts: Uint8Array[] = []
  let position = 0
  let length = 0
  for (const span of ordered) {
    if (span.start < position) continue
    const chunk = bytes.subarray(position, span.start)
    parts.push(chunk)
    length += chunk.length
    if (span.replacement?.length) {
      parts.push(span.replacement)
      length += span.replacement.length
    }
    position = span.end
  }
  const tail = bytes.subarray(position)
  parts.push(tail)
  length += tail.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function replacementStream(context: PDFContext, original: PDFStream, bytes: Uint8Array): PDFRawStream {
  const dict = PDFDict.withContext(context)
  for (const [key, value] of original.dict.entries()) {
    const name = key.asString()
    if (name === '/Filter' || name === '/DecodeParms' || name === '/Length') continue
    dict.set(key, value)
  }
  let encoded = bytes
  try {
    encoded = deflate(bytes)
    dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'))
  } catch {
    // Uncompressed streams are valid, just larger.
  }
  return PDFRawStream.of(dict, encoded)
}

/**
 * Deletes the original glyphs of `targets` from a (copied) page.
 * Returns the indexes of the targets that were located and removed.
 */
export function removeTextRuns(page: PDFPage, targets: TextRemovalTarget[]): Set<number> {
  const removed = new Set<number>()
  if (!targets.length) return removed
  const leaf = page.node
  const context = page.doc.context

  const entries: PDFStream[] = []
  const contents = leaf.Contents()
  if (contents instanceof PDFArray) {
    for (let index = 0; index < contents.size(); index += 1) {
      const stream = context.lookup(contents.get(index))
      if (stream instanceof PDFStream) entries.push(stream)
    }
  } else if (contents instanceof PDFStream) {
    entries.push(contents)
  }
  if (!entries.length) return removed

  const walker = new PageTextWalker()
  const resources = pageResources(leaf)
  for (const entry of entries) walker.walk(entry, resources, initialState(), 0)
  if (!walker.candidates.length) return removed

  // A form XObject can be painted more than once; deleting an operator there
  // would remove every instance. Only edit forms that are always drawn with the
  // same transform.
  const eligible = new Set<PDFStream>(entries)
  const encounterKeys = new Map<PDFStream, Set<string>>()
  for (const encounter of walker.encounters) {
    let keys = encounterKeys.get(encounter.stream)
    if (!keys) {
      keys = new Set()
      encounterKeys.set(encounter.stream, keys)
    }
    keys.add(encounter.ctmKey)
  }
  for (const [stream, keys] of encounterKeys) {
    if (keys.size === 1) eligible.add(stream)
  }

  const matchedRuns = new Set<TextRunUnit>()
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]
    if (!(target.width > 0) || !(target.fontSize > 0)) continue
    const cos = Math.cos(target.angle)
    const sin = Math.sin(target.angle)
    const maxU = Math.max(-0.2, target.width - 0.15)
    const maxV = Math.max(1.5, target.fontSize * 0.6)
    const maxSize = Math.max(0.8, target.fontSize * 0.15)
    for (const candidate of walker.candidates) {
      // Only the first operator of a run sits at a point pdf.js reported; the
      // rest are advanced by glyph widths this walker does not measure.
      if (!candidate.reliable) continue
      const run = candidate.run
      if (matchedRuns.has(run)) continue
      if (!run.candidates.every((member) => eligible.has(member.stream))) continue
      const dx = candidate.x - target.x
      const dy = candidate.y - target.y
      const u = dx * cos + dy * sin
      if (u < -0.75 || u > maxU) continue
      const v = -dx * sin + dy * cos
      if (Math.abs(v) > maxV) continue
      if (Math.abs(candidate.size - target.fontSize) > maxSize) continue
      if (candidate.dirX * cos + candidate.dirY * sin < 0.999) continue
      if (!coversRun(target, run)) continue
      matchedRuns.add(run)
      removed.add(index)
      break
    }
  }
  if (!matchedRuns.size) return removed

  const spans = new Map<PDFStream, Span[]>()
  for (const run of matchedRuns) {
    for (const candidate of run.candidates) {
      const list = spans.get(candidate.stream)
      const span: Span = { start: candidate.start, end: candidate.end, replacement: candidate.replacement }
      if (list) list.push(span)
      else spans.set(candidate.stream, [span])
    }
  }

  const replacements = new Map<PDFStream, PDFRef>()
  for (const [stream, list] of spans) {
    const bytes = walker.contentBytes(stream)
    if (!bytes) continue
    const next = replacementStream(context, stream, applySpans(bytes, list))
    replacements.set(stream, context.register(next))
  }

  if (contents instanceof PDFArray) {
    for (let index = 0; index < contents.size(); index += 1) {
      const stream = context.lookup(contents.get(index))
      const ref = stream instanceof PDFStream ? replacements.get(stream) : undefined
      if (ref) contents.set(index, ref)
    }
  } else if (contents instanceof PDFStream) {
    const ref = replacements.get(contents)
    if (ref) leaf.set(PDFName.of('Contents'), ref)
  }

  for (const encounter of walker.encounters) {
    const ref = replacements.get(encounter.stream)
    if (!ref) continue
    const xobjects = encounter.resources.lookupMaybe(PDFName.of('XObject'), PDFDict)
    xobjects?.set(PDFName.of(encounter.name), ref)
  }

  return removed
}
