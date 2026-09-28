import forge from 'node-forge'

/**
 * Small DER helpers over node-forge's ASN.1 module. forge works on "binary
 * strings" (one char per byte); everything outside this folder uses
 * Uint8Array, so conversions happen at the edges.
 */

export type Asn1 = forge.asn1.Asn1

const { asn1 } = forge
const { Class, Type } = asn1

export function toBinary(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return out
}

export function fromBinary(binary: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i) & 0xff
  return out
}

export function parseDer(bytes: Uint8Array): Asn1 {
  return asn1.fromDer(forge.util.createBuffer(toBinary(bytes)), false)
}

export function encodeDer(node: Asn1): Uint8Array<ArrayBuffer> {
  return fromBinary(asn1.toDer(node).getBytes())
}

export const der = {
  seq: (items: Asn1[]) => asn1.create(Class.UNIVERSAL, Type.SEQUENCE, true, items),
  set: (items: Asn1[]) => asn1.create(Class.UNIVERSAL, Type.SET, true, items),
  oid: (id: string) => asn1.create(Class.UNIVERSAL, Type.OID, false, asn1.oidToDer(id).getBytes()),
  int: (value: number) => asn1.create(Class.UNIVERSAL, Type.INTEGER, false, asn1.integerToDer(value).getBytes()),
  octets: (bytes: Uint8Array) => asn1.create(Class.UNIVERSAL, Type.OCTETSTRING, false, toBinary(bytes)),
  null: () => asn1.create(Class.UNIVERSAL, Type.NULL, false, ''),
  /** Context-specific constructed tag, e.g. `[0]` (IMPLICIT SET OF or EXPLICIT wrapper). */
  tagged: (tag: number, items: Asn1[]) => asn1.create(Class.CONTEXT_SPECIFIC, tag, true, items),
  /** Unsigned big-endian integer bytes, as used by ECDSA signatures. */
  unsigned: (bytes: Uint8Array) => {
    let start = 0
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1
    const trimmed = bytes.subarray(start)
    const padded = trimmed[0] & 0x80 ? Uint8Array.of(0, ...trimmed) : trimmed
    return asn1.create(Class.UNIVERSAL, Type.INTEGER, false, toBinary(padded))
  },
}

export function oidOf(node: Asn1 | undefined): string | null {
  if (!node || node.tagClass !== Class.UNIVERSAL || node.type !== Type.OID) return null
  return asn1.derToOid(node.value as string)
}

export function children(node: Asn1 | undefined): Asn1[] {
  return node && Array.isArray(node.value) ? node.value : []
}

/** Decodes the ASN.1 string types that appear in X.509 names. */
export function asn1String(node: Asn1 | undefined): string {
  if (!node || typeof node.value !== 'string') return ''
  const raw = node.value
  if (node.type === Type.UTF8) {
    try {
      return forge.util.decodeUtf8(raw)
    } catch {
      return raw
    }
  }
  if (node.type === Type.BMPSTRING) {
    let out = ''
    for (let i = 0; i + 1 < raw.length; i += 2) out += String.fromCharCode((raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1))
    return out
  }
  return raw
}

export function asn1Date(node: Asn1 | undefined): Date | null {
  if (!node || typeof node.value !== 'string') return null
  try {
    if (node.type === Type.UTCTIME) return asn1.utcTimeToDate(node.value)
    if (node.type === Type.GENERALIZEDTIME) return asn1.generalizedTimeToDate(node.value)
  } catch {
    // Malformed dates are reported as unknown.
  }
  return null
}

/** Byte-wise comparison used to sort DER `SET OF` members. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && compareBytes(a, b) === 0
}
