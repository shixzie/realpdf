# MCP server

RealPDF serves a [Model Context Protocol](https://modelcontextprotocol.io) server at
`https://realpdf.app/mcp`, so agents can send PDFs for signature, track them and check
signatures. It runs in the same Worker as the app (`worker/mcp/`) and uses the same
signing-request store and envelope as the browser, so a request an agent creates opens in
the app and a copy someone signs in the app is visible to the agent.

## Connecting

The transport is Streamable HTTP with plain JSON responses; the server is stateless (no
`Mcp-Session-Id`, no SSE stream on `GET`). There is no API key: see [Security](#security).

```bash
# Claude Code
claude mcp add --transport http realpdf https://realpdf.app/mcp
```

Other clients: add a remote/HTTP MCP server with the URL `https://realpdf.app/mcp` and no
authentication. For local development, `npm run cf:dev` serves it at
`http://127.0.0.1:8787/mcp` with a local R2 bucket.

## Tools

| Tool | What it does |
| --- | --- |
| `create_signing_request` | Takes a PDF (`pdf_base64` or an https `pdf_url`), an optional file name, sender and message, and optional empty `signature_fields` (one per signer: name, page, x, y, width, height in PDF points). Returns the signing `link`, the `request_id`, an `owner_token` and the expiry (30 days). Nobody is emailed: the agent sends the link. |
| `get_signing_request` | For a `link`: who has signed (name, email, whether RealPDF verified that email, time, whether the signature verifies), which signature fields are still empty, `document_replaced` when the latest copy is not the sent document plus signatures, and `complete` once every field is signed, every signature verifies and the document was not replaced. |
| `download_signed_pdf` | For a `link`: the latest version (or `version`, where 0 is the document as sent) as an embedded `application/pdf` resource, with its verification report. |
| `cancel_signing_request` | For a `link` and its `owner_token`: deletes the request and every stored copy. |
| `verify_pdf` | For any PDF: every signature's signer, time, reason and location, whether the signed bytes are unchanged, whether the file changed after the last signature, whether a signature certifies the document (DocMDP), whether the chain verifies and whether it was issued by RealPDF's CA (so the signer's email was verified); plus the empty signature fields. |

Results carry a readable summary as text and the full data as `structuredContent`. Bad input
(a truncated link, a page that does not exist, a PDF that is already signed when fields are
requested) comes back as a tool result with `isError: true` and a sentence the agent can act on.

## Security

- **The link is the credential.** A signing link is `https://realpdf.app/sign/<id>#<key>`; the
  `#key` is the AES-256-GCM key the document is encrypted with (format in
  `src/lib/signing/requestEnvelope.ts`). Like the app, the MCP server keeps no accounts: whoever
  holds the link can read the request and add a signed copy, and only the `owner_token` can
  delete it. RealPDF cannot recover a lost link.
- **What the server sees.** When an agent creates a request, the Worker receives the PDF,
  encrypts it in memory, stores only ciphertext in R2 and forgets the key. When an agent reads
  a request, it sends the link and the Worker decrypts in memory for that call. Nothing
  decrypted is logged or stored. Requests made in the browser are never decrypted server-side
  unless an agent passes their link to a tool.
- **Agents cannot sign.** Signing always happens in a signer's browser with their own key
  (an email-verified certificate RealPDF issued, or their own `.p12`), so the server never
  holds a private key and an agent cannot sign on anyone's behalf.
- **Limits.** PDFs up to 25 MB; request creation shares the `/api/` per-IP write limit.

## Verification scope

`verify_pdf` (`src/lib/signing/verify.ts`) checks the byte range, the CMS signed attributes and
signature (RSA PKCS#1 v1.5, RSA-PSS and ECDSA P-256/384/521 with SHA-1/256/384/512), the
certificate chain present in the file (only CA certificates may issue others), and validity at
the signing time. For every signature that does not cover the whole file it compares the signed
revision with the final file object by object (`src/lib/signing/revisions.ts`): adding signatures
and signature fields is allowed, anything else (new page content, other annotations, form
values, catalog changes) is listed in `unauthorizedChanges` and makes the report invalid, as do
changes a certification (DocMDP P=1/2/3) does not permit. pdf-lib reads objects in file order,
not through the cross-reference table, so updates that define an object twice or rewrite an
object without changing it are flagged too. Revocation (OCSP/CRL) and timestamps are not
checked.

`get_signing_request` also reports `document_replaced` when the latest copy does not start with
the document as sent (signing only appends), and then never reports `complete`.
