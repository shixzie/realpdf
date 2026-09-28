import { verifyPdf, VerifyError, type VerificationReport, type VerifiedSignature } from '../../../src/lib/signing/verify'
import { pdfInputProperties, readPdfArgument } from '../pdfInput'
import { ToolError, type Tool } from '../protocol'
import { trustAnchors, type McpContext } from '../context'

function describeSignature(signature: VerifiedSignature, index: number): string {
  const who = signature.signer ? `${signature.signer.name}${signature.signer.email ? ` <${signature.signer.email}>` : ''}` : 'unknown signer'
  const state = signature.intact ? 'intact' : 'NOT intact'
  const when = signature.signedAt ? ` on ${signature.signedAt}` : ''
  const certifies = signature.certifies ? `, certifies the document (DocMDP P=${signature.certifies})` : ''
  const trust =
    signature.trusted === true
      ? ', email verified by RealPDF'
      : signature.signer?.selfSigned
        ? ', self-signed certificate'
        : ''
  const problems = signature.problems.length ? `\n   Problems: ${signature.problems.join('; ')}` : ''
  return `${index + 1}. "${signature.field}" signed by ${who}${when}: ${state}${certifies}${trust}.${problems}`
}

export function summarize(report: VerificationReport): string {
  const lines: string[] = []
  if (!report.signatures.length) lines.push('The PDF has no digital signatures.')
  else {
    lines.push(
      report.valid
        ? `All ${report.signatures.length} signature(s) are intact and the last one covers the whole file.`
        : 'The signatures do NOT all verify, or the file changed after the last signature.',
    )
    report.signatures.forEach((signature, index) => lines.push(describeSignature(signature, index)))
  }
  if (report.emptyFields.length) {
    lines.push(
      `Empty signature fields: ${report.emptyFields.map((field) => `"${field.field}" (page ${field.pageIndex + 1})`).join(', ')}.`,
    )
  }
  lines.push('Revocation (OCSP/CRL) and timestamps are not checked.')
  return lines.join('\n')
}

export const verifyPdfTool: Tool<McpContext> = {
  name: 'verify_pdf',
  title: 'Verify PDF signatures',
  description:
    'Checks every digital signature in a PDF: who signed, when, whether the signed bytes are unchanged, whether ' +
    'the file was modified after the last signature, whether a signature certifies the document, and whether ' +
    'the certificate chain verifies. Also lists empty signature fields waiting to be signed. Needs no API key.',
  inputSchema: {
    type: 'object',
    properties: { ...pdfInputProperties },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async run(args, context) {
    const bytes = await readPdfArgument(args)
    let report: VerificationReport
    try {
      report = await verifyPdf(bytes, { trustAnchors: await trustAnchors(context) })
    } catch (error) {
      if (error instanceof VerifyError) throw new ToolError(`Could not read the PDF: ${error.message}`)
      throw error
    }
    return {
      content: [{ type: 'text', text: summarize(report) }],
      structuredContent: report as unknown as Record<string, unknown>,
    }
  },
}
