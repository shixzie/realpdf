import { fromBinary, toBinary } from './der'
import { certificateInfo, parseCertificate, type SigningIdentity } from './identity'
import { rememberIdentity, type SavedIdentityMeta } from './keystore'

/**
 * Creating a signing ID without a certificate file: the browser makes a key
 * pair (the private key is non-extractable and never leaves this device),
 * RealPDF emails a code to verify the address, and its CA issues a
 * certificate for the public key. The result is remembered on this device.
 */

export type EnrollErrorCode =
  | 'invalidEmail'
  | 'invalidName'
  | 'wrongCode'
  | 'codeExpired'
  | 'tooManyAttempts'
  | 'invalidChallenge'
  | 'rateLimited'
  | 'tooManyCodes'
  | 'unavailable'
  | 'network'

const KNOWN: EnrollErrorCode[] = [
  'invalidEmail',
  'invalidName',
  'wrongCode',
  'codeExpired',
  'tooManyAttempts',
  'invalidChallenge',
  'rateLimited',
  'tooManyCodes',
  'unavailable',
]

export class EnrollError extends Error {
  readonly code: EnrollErrorCode
  constructor(code: EnrollErrorCode) {
    super(code)
    this.code = code
  }
}

export interface PendingEnrollment {
  challengeId: string
  email: string
  expiresAt: number
  keys: CryptoKeyPair
}

const base64 = (bytes: Uint8Array) => btoa(toBinary(bytes))

async function post<T>(path: string, body: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new EnrollError('network')
  }
  const data = (await response.json().catch(() => null)) as (T & { error?: string }) | null
  if (!response.ok || !data) {
    const code = data?.error as EnrollErrorCode | undefined
    throw new EnrollError(code && KNOWN.includes(code) ? code : response.status >= 500 ? 'unavailable' : 'network')
  }
  return data
}

function generateKeys(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

/** Emails a verification code. Pass the previous attempt to resend with the same key. */
export async function startEnrollment(email: string, previous?: PendingEnrollment): Promise<PendingEnrollment> {
  const [keys, challenge] = await Promise.all([
    previous ? Promise.resolve(previous.keys) : generateKeys(),
    post<{ challengeId: string; email: string; expiresAt: number }>('/api/identity/verify-email', { email }),
  ])
  return { ...challenge, keys }
}

/** Redeems the code and returns the new identity, already remembered on this device. */
export async function completeEnrollment(
  pending: PendingEnrollment,
  code: string,
  name: string,
): Promise<{ identity: SigningIdentity; saved: SavedIdentityMeta }> {
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pending.keys.publicKey))
  const proof = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      pending.keys.privateKey,
      new TextEncoder().encode(`realpdf-enroll:${pending.challengeId}`),
    ),
  )
  const issued = await post<{ certificate: string; chain: string[] }>('/api/identity/certificate', {
    challengeId: pending.challengeId,
    code: code.replace(/\s+/g, ''),
    name,
    publicKey: base64(spki),
    proof: base64(proof),
  })
  const certificate = fromBinary(atob(issued.certificate))
  const identity: SigningIdentity = {
    certificate,
    chain: issued.chain.map((der) => fromBinary(atob(der))),
    key: pending.keys.privateKey,
    keyType: 'RSA',
    info: certificateInfo(parseCertificate(certificate)),
  }
  const saved = await rememberIdentity(identity)
  return { identity, saved }
}
