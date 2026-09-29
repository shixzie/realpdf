export const DOCUMENT_TOOLS = [
  { id: 'compress', needsDocument: true },
  { id: 'watermark', needsDocument: true },
  { id: 'numbers', needsDocument: true },
  { id: 'rotate', needsDocument: true },
  { id: 'protect', needsDocument: true },
  { id: 'unlock', needsDocument: false },
  { id: 'extractImages', needsDocument: true },
  { id: 'overlay', needsDocument: true },
  { id: 'compare', needsDocument: true },
  { id: 'ocr', needsDocument: true },
  { id: 'optimize', needsDocument: true },
  { id: 'repair', needsDocument: false },
  { id: 'redact', needsDocument: true },
  { id: 'rasterize', needsDocument: true },
  { id: 'flatten', needsDocument: true },
  { id: 'html', needsDocument: false },
  { id: 'create', needsDocument: false },
] as const

export type DocumentToolId = typeof DOCUMENT_TOOLS[number]['id']
