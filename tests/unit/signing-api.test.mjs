/**
 * The signing service behind /api/: encrypted signing requests and
 * email-verified certificates, run against the in-memory store the dev server
 * uses. Issued certificates are checked with Node's crypto.
 */
import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { handleApi } from '../../worker/api.ts'
import { memoryStore } from '../../worker/store.ts'
import { makeDevCertificateAuthority } from '../../worker/devServer.ts'
import { purgeExpiredSignRequests, REQUEST_LIFETIME_MS } from '../../worker/signRequests.ts'
import { enrollmentProofMessage, purgeExpiredChallenges } from '../../worker/signingIdentity.ts'

const token = () => crypto.randomBytes(32).toString('base64url')

function service(overrides = {}) {
  const outbox = []
  const deps = {
    store: memoryStore(),
    certificateAuthority: (() => {
      let ca
      return () => (ca ??= makeDevCertificateAuthority())
    })(),
    sendEmail: async (message) => {
      outbox.push(message)
    },
    ...overrides,
  }
  const call = (method, path, { body, headers = {} } = {}) =>
    handleApi(new Request(`http://localhost${path}`, { method, body, headers }), deps)
  const callJson = (method, path, value) =>
    call(method, path, { body: JSON.stringify(value), headers: { 'content-type': 'application/json' } })
  return { deps, outbox, call, callJson }
}

describe('signing requests API', () => {
  it('stores encrypted versions and only lets link holders add to them', async () => {
    const { call, deps } = service()
    const writeToken = token()
    const ownerToken = token()
    const original = crypto.randomBytes(2000)

    const created = await call('POST', '/api/sign-requests', {
      body: original,
      headers: { 'x-write-token': writeToken, 'x-owner-token': ownerToken },
    })
    expect(created.status).toBe(201)
    const { id, versions, expiresAt, createdAt } = await created.json()
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(versions).toHaveLength(1)
    expect(expiresAt - createdAt).toBe(REQUEST_LIFETIME_MS)

    const latest = await call('GET', `/api/sign-requests/${id}/versions/latest`)
    expect(Buffer.from(await latest.arrayBuffer()).equals(original)).toBe(true)

    const wrong = await call('POST', `/api/sign-requests/${id}/versions`, {
      body: crypto.randomBytes(10),
      headers: { 'x-write-token': token() },
    })
    expect(wrong.status).toBe(403)

    const signed = crypto.randomBytes(3000)
    const added = await call('POST', `/api/sign-requests/${id}/versions`, {
      body: signed,
      headers: { 'x-write-token': writeToken },
    })
    expect(added.status).toBe(201)
    expect((await added.json()).versions).toHaveLength(2)
    const first = await call('GET', `/api/sign-requests/${id}/versions/0`)
    expect(Buffer.from(await first.arrayBuffer()).equals(original)).toBe(true)
    const newest = await call('GET', `/api/sign-requests/${id}/versions/latest`)
    expect(Buffer.from(await newest.arrayBuffer()).equals(signed)).toBe(true)

    // Concurrent uploads each become their own version.
    await Promise.all(
      [1, 2, 3].map(() =>
        call('POST', `/api/sign-requests/${id}/versions`, { body: crypto.randomBytes(50), headers: { 'x-write-token': writeToken } }),
      ),
    )
    expect((await (await call('GET', `/api/sign-requests/${id}`)).json()).versions).toHaveLength(5)

    // Only the owner token deletes, and the blobs go with it.
    expect((await call('DELETE', `/api/sign-requests/${id}`, { headers: { 'x-owner-token': writeToken } })).status).toBe(403)
    expect((await call('DELETE', `/api/sign-requests/${id}`, { headers: { 'x-owner-token': ownerToken } })).status).toBe(204)
    expect((await call('GET', `/api/sign-requests/${id}`)).status).toBe(404)
    expect((await deps.store.list({ prefix: 'requests/' })).objects).toHaveLength(0)
  })

  it('rejects bad input and expires requests', async () => {
    const { call, deps } = service()
    expect((await call('POST', '/api/sign-requests', { body: new Uint8Array(4), headers: {} })).status).toBe(400)
    expect((await call('GET', '/api/sign-requests/not-an-id!')).status).toBe(400)
    expect((await call('GET', '/api/sign-requests/AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404)

    const created = await call('POST', '/api/sign-requests', {
      body: crypto.randomBytes(100),
      headers: { 'x-write-token': token(), 'x-owner-token': token() },
    })
    const { id, expiresAt } = await created.json()
    expect(await purgeExpiredSignRequests(deps.store, expiresAt - 1)).toBe(0)
    expect(await purgeExpiredSignRequests(deps.store, expiresAt + 1)).toBe(1)
    expect((await call('GET', `/api/sign-requests/${id}`)).status).toBe(404)
  })

  it('answers 429 when the rate limiter says no', async () => {
    const { call } = service({ allow: async () => false })
    const response = await call('POST', '/api/sign-requests', {
      body: crypto.randomBytes(10),
      headers: { 'x-write-token': token(), 'x-owner-token': token() },
    })
    expect(response.status).toBe(429)
  })
})

async function browserKey() {
  const keys = await crypto.webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  const spki = Buffer.from(await crypto.webcrypto.subtle.exportKey('spki', keys.publicKey))
  const prove = async (challengeId) =>
    Buffer.from(
      await crypto.webcrypto.subtle.sign(
        { name: 'RSASSA-PKCS1-v1_5' },
        keys.privateKey,
        new TextEncoder().encode(enrollmentProofMessage(challengeId)),
      ),
    ).toString('base64')
  return { spki, prove }
}

describe('email-verified certificates API', () => {
  it('emails a code and issues a certificate for the verified address', async () => {
    const { callJson, outbox, deps, call } = service()
    const started = await callJson('POST', '/api/identity/verify-email', { email: '  Ada@Example.com ' })
    expect(started.status).toBe(201)
    const { challengeId, email } = await started.json()
    expect(email).toBe('ada@example.com')
    expect(outbox).toHaveLength(1)
    expect(outbox[0].to).toBe('ada@example.com')
    const code = outbox[0].text.match(/\b(\d{6})\b/)?.[1]
    expect(code).toMatch(/^\d{6}$/)

    const key = await browserKey()
    const request = (overrides = {}) => ({
      challengeId,
      code,
      name: 'Ada Lovelace',
      publicKey: key.spki.toString('base64'),
      ...overrides,
    })

    // The proof must come from the key being certified.
    const other = await browserKey()
    const badProof = await callJson('POST', '/api/identity/certificate', request({ proof: await other.prove(challengeId) }))
    expect((await badProof.json()).error).toBe('invalidProof')

    const wrongCode = await callJson(
      'POST',
      '/api/identity/certificate',
      request({ code: code === '000000' ? '111111' : '000000', proof: await key.prove(challengeId) }),
    )
    expect((await wrongCode.json()).error).toBe('wrongCode')

    const issued = await callJson('POST', '/api/identity/certificate', request({ proof: await key.prove(challengeId) }))
    expect(issued.status).toBe(201)
    const body = await issued.json()
    const certificate = new crypto.X509Certificate(Buffer.from(body.certificate, 'base64'))
    const ca = new crypto.X509Certificate(Buffer.from(body.chain[0], 'base64'))
    expect(certificate.checkIssued(ca)).toBe(true)
    expect(certificate.verify(ca.publicKey)).toBe(true)
    expect(certificate.subject).toContain('CN=Ada Lovelace')
    expect(certificate.subject).toContain('Email verified by RealPDF')
    expect(certificate.subjectAltName).toBe('email:ada@example.com')
    expect(certificate.ca).toBe(false)
    expect(certificate.keyUsage).toEqual(expect.arrayContaining(['1.3.6.1.5.5.7.3.36']))
    expect(Buffer.from(certificate.publicKey.export({ type: 'spki', format: 'der' })).equals(key.spki)).toBe(true)
    const days = (Date.parse(certificate.validTo) - Date.now()) / 86400000
    expect(days).toBeGreaterThan(360)

    // The code is single-use.
    const again = await callJson('POST', '/api/identity/certificate', request({ proof: await key.prove(challengeId) }))
    expect((await again.json()).error).toBe('invalidChallenge')

    // The CA certificate is published for people who want to trust it.
    const pem = await (await call('GET', '/api/identity/ca.pem')).text()
    expect(new crypto.X509Certificate(pem).fingerprint256).toBe(ca.fingerprint256)
    expect((await deps.store.list({ prefix: 'challenges/' })).objects).toHaveLength(0)
  })

  it('locks a code after five wrong attempts and cleans up expired ones', async () => {
    const { callJson, outbox, deps } = service()
    const { challengeId, expiresAt } = await (await callJson('POST', '/api/identity/verify-email', { email: 'b@example.org' })).json()
    const code = outbox[0].text.match(/\b(\d{6})\b/)[1]
    const key = await browserKey()
    const proof = await key.prove(challengeId)
    const attempt = (value) =>
      callJson('POST', '/api/identity/certificate', {
        challengeId,
        code: value,
        name: 'B',
        publicKey: key.spki.toString('base64'),
        proof,
      }).then((response) => response.json())
    const wrong = code === '123456' ? '654321' : '123456'
    const results = []
    for (let i = 0; i < 5; i += 1) results.push((await attempt(wrong)).error)
    expect(results).toEqual(['wrongCode', 'wrongCode', 'wrongCode', 'wrongCode', 'tooManyAttempts'])
    expect((await attempt(code)).error).toBe('tooManyAttempts')
    expect(await purgeExpiredChallenges(deps.store, expiresAt + 1)).toBe(1)
  })

  it('validates input and reports a missing email service or CA', async () => {
    const { callJson } = service({ sendEmail: null, certificateAuthority: async () => null })
    expect((await (await callJson('POST', '/api/identity/verify-email', { email: 'nope' })).json()).error).toBe('unavailable')
    const configured = service()
    expect((await (await configured.callJson('POST', '/api/identity/verify-email', { email: 'not an email' })).json()).error).toBe(
      'invalidEmail',
    )
    const key = await browserKey()
    const noCa = await callJson('POST', '/api/identity/certificate', {
      challengeId: 'AAAAAAAAAAAAAAAAAAAAAA',
      code: '123456',
      name: 'X',
      publicKey: key.spki.toString('base64'),
      proof: await key.prove('AAAAAAAAAAAAAAAAAAAAAA'),
    })
    expect(noCa.status).toBe(503)
  })
})
