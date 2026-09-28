import type { BlobStore } from './store'
import { fromBase64, randomId, sha256Hex, timingSafeEqual } from './encoding'
import {
  importSubjectPublicKey,
  issueCertificate,
  verifyWithSubjectKey,
  type CertificateAuthority,
} from './certificateAuthority'

/**
 * Email-verified signing certificates. The flow has two calls:
 *
 * 1. `startEmailVerification` emails a six-digit code and returns a
 *    challenge id.
 * 2. `issueVerifiedCertificate` takes the code, the name to show, the
 *    browser's public key and a proof that the browser holds the private key
 *    (a signature over `enrollmentProofMessage(challengeId)`), and returns a
 *    certificate issued by RealPDF's CA.
 *
 * Only the email address is verified; the name is what the person typed.
 */

export const CODE_LIFETIME_MS = 10 * 60 * 1000
export const MAX_CODE_ATTEMPTS = 5

const PREFIX = 'challenges/'
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/

export interface EmailMessage {
  to: string
  subject: string
  text: string
}

export type SendEmail = (message: EmailMessage) => Promise<void>

export type IdentityErrorCode =
  | 'invalidEmail'
  | 'invalidName'
  | 'invalidKey'
  | 'invalidProof'
  | 'invalidChallenge'
  | 'wrongCode'
  | 'codeExpired'
  | 'tooManyAttempts'
  | 'unavailable'

const STATUS: Record<IdentityErrorCode, number> = {
  invalidEmail: 400,
  invalidName: 400,
  invalidKey: 400,
  invalidProof: 400,
  invalidChallenge: 404,
  wrongCode: 400,
  codeExpired: 410,
  tooManyAttempts: 429,
  unavailable: 503,
}

export class IdentityError extends Error {
  readonly code: IdentityErrorCode
  readonly status: number
  constructor(code: IdentityErrorCode) {
    super(code)
    this.code = code
    this.status = STATUS[code]
  }
}

interface Challenge {
  email: string
  codeHash: string
  expiresAt: number
  attempts: number
}

export function normalizeEmail(input: unknown): string {
  const email = typeof input === 'string' ? input.trim().toLowerCase() : ''
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new IdentityError('invalidEmail')
  return email
}

export function normalizeName(input: unknown): string {
  const name = typeof input === 'string' ? input.normalize('NFC').replace(/\s+/g, ' ').trim() : ''
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) throw new IdentityError('invalidName')
  return name
}

/** What the browser signs to prove it holds the private key for a challenge. */
export function enrollmentProofMessage(challengeId: string): string {
  return `realpdf-enroll:${challengeId}`
}

const hashCode = (challengeId: string, code: string) => sha256Hex(`realpdf-code:${challengeId}:${code}`)

function sixDigitCode(): string {
  // Rejection sampling keeps every code equally likely.
  const buffer = new Uint32Array(1)
  let value = 0
  do {
    crypto.getRandomValues(buffer)
    value = buffer[0]
  } while (value >= 4_294_000_000)
  return String(value % 1_000_000).padStart(6, '0')
}

export function verificationEmail(to: string, code: string): EmailMessage {
  return {
    to,
    subject: `${code} is your RealPDF signing code`,
    text: [
      `Your RealPDF verification code is ${code}.`,
      '',
      'Enter it in RealPDF to create your signing certificate. The code expires in 10 minutes.',
      "If you didn't ask for this, you can ignore this email.",
    ].join('\n'),
  }
}

export async function startEmailVerification(
  store: BlobStore,
  args: { email: unknown; send: SendEmail | null; now?: number },
): Promise<{ challengeId: string; email: string; expiresAt: number }> {
  if (!args.send) throw new IdentityError('unavailable')
  const email = normalizeEmail(args.email)
  const now = args.now ?? Date.now()
  const challengeId = randomId(16)
  const code = sixDigitCode()
  const challenge: Challenge = {
    email,
    codeHash: await hashCode(challengeId, code),
    expiresAt: now + CODE_LIFETIME_MS,
    attempts: 0,
  }
  await store.put(`${PREFIX}${challengeId}`, JSON.stringify(challenge), {
    customMetadata: { expiresAt: String(challenge.expiresAt) },
  })
  await args.send(verificationEmail(email, code))
  return { challengeId, email, expiresAt: challenge.expiresAt }
}

/** Checks the code and consumes the challenge; returns the verified email. */
async function redeemCode(store: BlobStore, challengeId: string, code: string, now: number): Promise<string> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(challengeId)) throw new IdentityError('invalidChallenge')
  const key = `${PREFIX}${challengeId}`
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const object = await store.get(key)
    if (!object) throw new IdentityError('invalidChallenge')
    const challenge = JSON.parse(await object.text()) as Challenge
    if (challenge.expiresAt <= now) {
      await store.delete(key)
      throw new IdentityError('codeExpired')
    }
    if (challenge.attempts >= MAX_CODE_ATTEMPTS) throw new IdentityError('tooManyAttempts')
    const matches = /^\d{6}$/.test(code) && timingSafeEqual(await hashCode(challengeId, code), challenge.codeHash)
    if (matches) {
      await store.delete(key)
      return challenge.email
    }
    const counted = await store.put(
      key,
      JSON.stringify({ ...challenge, attempts: challenge.attempts + 1 }),
      { onlyIf: { etagMatches: object.etag }, customMetadata: { expiresAt: String(challenge.expiresAt) } },
    )
    if (counted) {
      throw new IdentityError(challenge.attempts + 1 >= MAX_CODE_ATTEMPTS ? 'tooManyAttempts' : 'wrongCode')
    }
  }
  throw new IdentityError('wrongCode')
}

export interface IssuedIdentity {
  /** DER of the new certificate. */
  certificate: Uint8Array<ArrayBuffer>
  /** DER of the issuing CA certificate. */
  chain: Uint8Array<ArrayBuffer>[]
  email: string
  name: string
}

export async function issueVerifiedCertificate(
  store: BlobStore,
  ca: CertificateAuthority | null,
  args: { challengeId: unknown; code: unknown; name: unknown; publicKey: unknown; proof: unknown; now?: number },
): Promise<IssuedIdentity> {
  if (!ca) throw new IdentityError('unavailable')
  const now = args.now ?? Date.now()
  const name = normalizeName(args.name)
  const challengeId = typeof args.challengeId === 'string' ? args.challengeId : ''
  const code = typeof args.code === 'string' ? args.code.replace(/\s+/g, '') : ''
  if (typeof args.publicKey !== 'string' || typeof args.proof !== 'string') throw new IdentityError('invalidKey')

  let subjectKey
  try {
    subjectKey = await importSubjectPublicKey(fromBase64(args.publicKey))
  } catch {
    throw new IdentityError('invalidKey')
  }
  const proofOk = await verifyWithSubjectKey(
    subjectKey,
    fromBase64(args.proof),
    new TextEncoder().encode(enrollmentProofMessage(challengeId)),
  )
  if (!proofOk) throw new IdentityError('invalidProof')

  const email = await redeemCode(store, challengeId, code, now)
  const certificate = await issueCertificate(ca, { name, email, subjectKey, now })
  return { certificate, chain: [ca.certificate.der], email, name }
}

/** Removes expired verification challenges. Run from the Worker's daily cron. */
export async function purgeExpiredChallenges(store: BlobStore, now = Date.now()): Promise<number> {
  let removed = 0
  let cursor: string | undefined
  do {
    const page = await store.list({ prefix: PREFIX, cursor, include: ['customMetadata'] })
    const expired = page.objects
      .filter((object) => Number(object.customMetadata?.expiresAt) <= now)
      .map((object) => object.key)
    if (expired.length) await store.delete(expired)
    removed += expired.length
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return removed
}
