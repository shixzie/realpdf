import {
  deriveWriteToken,
  generateRequestKey,
  openVersion,
  parseRequestLink,
  requestLink,
  sealVersion,
  type RequestHeader,
} from '../../../src/lib/signing/requestEnvelope.ts'
import { verifyPdf, type VerificationReport } from '../../../src/lib/signing/verify.ts'
import { randomId } from '../../encoding.ts'
import {
  createSignRequest,
  deleteSignRequest,
  getSignRequest,
  readSignRequestVersion,
  SignRequestError,
  type SignRequestStatus,
} from '../../signRequests.ts'
import { trustAnchors, type McpContext } from '../context.ts'
import { encodeBase64, pdfInputProperties, readPdfArgument } from '../pdfInput.ts'
import { ToolError, type Tool, type ToolResult } from '../protocol.ts'
import { addSignatureFields, parseSignatureFields, signatureFieldsSchema } from '../signatureFields.ts'
import { summarize } from './verify.ts'

const ERROR_TEXT: Record<string, string> = {
  invalidId: 'That is not a RealPDF signing link.',
  notFound: 'No signing request exists for that link (it may have been cancelled).',
  expired: 'That signing request has expired.',
  forbidden: 'The owner token does not match this signing request.',
  invalidToken: 'The owner token is not valid.',
  tooLarge: 'The PDF is too large for a signing request.',
  empty: 'The PDF is empty.',
}

function storeError(error: unknown): never {
  if (error instanceof SignRequestError) throw new ToolError(ERROR_TEXT[error.code] ?? `Signing request error: ${error.code}`)
  throw error
}

const now = (context: McpContext) => context.deps.now?.() ?? Date.now()

const linkProperty = {
  link: {
    type: 'string',
    description: 'The signing link create_signing_request returned, including the part after #.',
  },
} as const

function openLink(args: Record<string, unknown>): { id: string; key: string } {
  const link = typeof args.link === 'string' ? args.link.trim() : ''
  if (!link) throw new ToolError('Give the signing link as link.')
  const parsed = parseRequestLink(link)
  if (!parsed) {
    throw new ToolError('That is not a complete RealPDF signing link. It needs the part after #, which holds the decryption key.')
  }
  return parsed
}

async function readVersion(
  context: McpContext,
  id: string,
  key: string,
  index: number | 'latest',
): Promise<{ bytes: Uint8Array; header: RequestHeader }> {
  const ciphertext = await readSignRequestVersion(context.deps.store, id, index, now(context)).catch(storeError)
  try {
    return await openVersion(key, ciphertext)
  } catch {
    throw new ToolError('The link\'s key does not decrypt this request. Check that the link was copied in full.')
  }
}

interface RequestSummary {
  request_id: string
  created_at: string
  expires_at: string
  /** Signed copies uploaded so far (version 0 is the document as sent). */
  signed_versions: number
  file_name: string
  /** Who asked for the signatures and their note, as shown to signers. */
  from: string
  message: string
  signatures: Array<{
    field: string
    signer: string | null
    email: string | null
    email_verified_by_realpdf: boolean
    signed_at: string | null
    intact: boolean
  }>
  pending_fields: string[]
  /** Every signature field is signed and every signature verifies. */
  complete: boolean
  verification: VerificationReport
}

function requestSummary(status: SignRequestStatus, header: RequestHeader, report: VerificationReport): RequestSummary {
  return {
    request_id: status.id,
    created_at: new Date(status.createdAt).toISOString(),
    expires_at: new Date(status.expiresAt).toISOString(),
    signed_versions: Math.max(0, status.versions.length - 1),
    file_name: header.fileName,
    from: header.from,
    message: header.message,
    signatures: report.signatures.map((signature) => ({
      field: signature.field,
      signer: signature.signer?.name ?? null,
      email: signature.signer?.email ?? null,
      email_verified_by_realpdf: signature.trusted === true,
      signed_at: signature.signedAt,
      intact: signature.intact,
    })),
    pending_fields: report.emptyFields.map((field) => field.field),
    complete: report.valid && report.emptyFields.length === 0,
    verification: report,
  }
}

function describeRequest(summary: RequestSummary): string {
  const lines = [
    `Signing request ${summary.request_id} for "${summary.file_name}", expires ${summary.expires_at}.`,
  ]
  if (!summary.signatures.length) lines.push('Nobody has signed yet.')
  for (const signature of summary.signatures) {
    const email = signature.email ? ` <${signature.email}>${signature.email_verified_by_realpdf ? ' (verified by RealPDF)' : ''}` : ''
    lines.push(`- ${signature.signer ?? 'Unknown signer'}${email} signed "${signature.field}"${signature.signed_at ? ` on ${signature.signed_at}` : ''}${signature.intact ? '' : ' (signature does NOT verify)'}.`)
  }
  if (summary.pending_fields.length) lines.push(`Still waiting on: ${summary.pending_fields.map((name) => `"${name}"`).join(', ')}.`)
  if (summary.complete) lines.push('All signature fields are signed and every signature verifies.')
  return lines.join('\n')
}

export const createSigningRequestTool: Tool<McpContext> = {
  name: 'create_signing_request',
  title: 'Create a signing request',
  description:
    'Uploads a PDF as a RealPDF signing request and returns a signing link to send to the signers. Each signer ' +
    'opens the link in a browser and signs with their own certificate (RealPDF can issue one by verifying their ' +
    'email); the signed copy goes back to the same request. The PDF is encrypted before it is stored and the key ' +
    'exists only in the link, so keep the link: RealPDF cannot recover it. Keep owner_token to cancel the request. ' +
    'Requests expire after 30 days. Nobody is emailed; send the link yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      ...pdfInputProperties,
      file_name: { type: 'string', description: 'File name signers see, e.g. "Contract.pdf".', maxLength: 200 },
      from: {
        type: 'string',
        description: 'Who is asking for the signatures, shown to signers (e.g. "Ada Lovelace, Analytical Engines").',
        maxLength: 200,
      },
      message: { type: 'string', description: 'A note shown to signers.', maxLength: 2000 },
      signature_fields: signatureFieldsSchema,
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async run(args, context) {
    const fields = parseSignatureFields(args.signature_fields)
    const field = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
    const header: RequestHeader = {
      v: 1,
      fileName: field(args.file_name, 200) || 'document.pdf',
      from: field(args.from, 200),
      message: field(args.message, 2000),
      signers: [],
    }
    if (context.deps.allow && !(await context.deps.allow('write', context.clientKey))) {
      throw new ToolError('Too many signing requests from this address; try again in a minute.')
    }
    const pdf = await addSignatureFields(await readPdfArgument(args), fields)
    const key = generateRequestKey()
    const ownerToken = randomId(32)
    const status = await createSignRequest(context.deps.store, {
      ciphertext: await sealVersion(key, header, pdf),
      writeToken: await deriveWriteToken(key),
      ownerToken,
      now: now(context),
    }).catch(storeError)
    const link = requestLink(context.origin, status.id, key)
    const result = {
      link,
      request_id: status.id,
      owner_token: ownerToken,
      expires_at: new Date(status.expiresAt).toISOString(),
      signature_fields: fields.map((field) => field.name),
    }
    const text = [
      `Created signing request ${status.id}. Send this link to the signers:`,
      link,
      fields.length ? `Signature fields: ${fields.map((field) => `"${field.name}"`).join(', ')}.` : '',
      `Keep the link (it holds the only key) and the owner token ${ownerToken} (needed to cancel). Expires ${result.expires_at}.`,
    ]
      .filter(Boolean)
      .join('\n')
    return { content: [{ type: 'text', text }], structuredContent: result }
  },
}

export const getSigningRequestTool: Tool<McpContext> = {
  name: 'get_signing_request',
  title: 'Check a signing request',
  description:
    'Shows who has signed a signing request so far, which signature fields are still empty, and whether every ' +
    'signature verifies. Reads the latest signed copy.',
  inputSchema: { type: 'object', properties: { ...linkProperty }, required: ['link'], additionalProperties: false },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async run(args, context) {
    const { id, key } = openLink(args)
    const status = await getSignRequest(context.deps.store, id, now(context)).catch(storeError)
    const { bytes, header } = await readVersion(context, id, key, 'latest')
    const report = await verifyPdf(bytes, { trustAnchors: await trustAnchors(context) })
    const summary = requestSummary(status, header, report)
    return { content: [{ type: 'text', text: describeRequest(summary) }], structuredContent: summary as unknown as Record<string, unknown> }
  },
}

export const downloadSignedPdfTool: Tool<McpContext> = {
  name: 'download_signed_pdf',
  title: 'Download the signed PDF',
  description:
    'Returns the latest signed copy of a signing request as a PDF (or an earlier version: 0 is the document as ' +
    'sent), along with a verification of its signatures.',
  inputSchema: {
    type: 'object',
    properties: {
      ...linkProperty,
      version: { type: 'integer', minimum: 0, description: 'Version to download; omit for the latest.' },
    },
    required: ['link'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async run(args, context): Promise<ToolResult> {
    const { id, key } = openLink(args)
    const version = typeof args.version === 'number' && Number.isInteger(args.version) && args.version >= 0 ? args.version : 'latest'
    const { bytes, header } = await readVersion(context, id, key, version)
    const report = await verifyPdf(bytes, { trustAnchors: await trustAnchors(context) }).catch(() => null)
    const name = (header.fileName || 'document.pdf').replace(/\.pdf$/i, '') + (report?.signatures.length ? '-signed.pdf' : '.pdf')
    return {
      content: [
        { type: 'text', text: `${name} (${bytes.length} bytes, version ${version}).\n${report ? summarize(report) : ''}`.trim() },
        {
          type: 'resource',
          resource: {
            uri: `realpdf://requests/${id}/${version}/${encodeURIComponent(name)}`,
            mimeType: 'application/pdf',
            blob: encodeBase64(bytes),
          },
        },
      ],
      structuredContent: { file_name: name, size: bytes.length, version, verification: report },
    }
  },
}

export const cancelSigningRequestTool: Tool<McpContext> = {
  name: 'cancel_signing_request',
  title: 'Cancel a signing request',
  description:
    'Deletes a signing request and every copy of the document RealPDF stores for it. The link stops working ' +
    'for everyone. Needs the owner token create_signing_request returned.',
  inputSchema: {
    type: 'object',
    properties: {
      ...linkProperty,
      owner_token: { type: 'string', description: 'The owner_token create_signing_request returned.' },
    },
    required: ['link', 'owner_token'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async run(args, context) {
    const { id } = openLink(args)
    const ownerToken = typeof args.owner_token === 'string' ? args.owner_token.trim() : ''
    await deleteSignRequest(context.deps.store, id, ownerToken).catch(storeError)
    return { content: [{ type: 'text', text: `Cancelled signing request ${id}; its stored copies are deleted.` }] }
  },
}

export const requestTools = [createSigningRequestTool, getSigningRequestTool, downloadSignedPdfTool, cancelSigningRequestTool]
