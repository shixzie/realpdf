export type ToolCategory = 'edit' | 'pages' | 'convert' | 'security' | 'forms' | 'optimize'

export const DOCUMENT_TOOLS = [
  { id: 'compress', needsDocument: true, category: 'optimize' },
  { id: 'watermark', needsDocument: true, category: 'edit' },
  { id: 'numbers', needsDocument: true, category: 'pages' },
  { id: 'rotate', needsDocument: true, category: 'pages' },
  { id: 'protect', needsDocument: true, category: 'security' },
  { id: 'unlock', needsDocument: false, category: 'security' },
  { id: 'extractImages', needsDocument: true, category: 'convert' },
  { id: 'overlay', needsDocument: true, category: 'edit' },
  { id: 'compare', needsDocument: true, category: 'edit' },
  { id: 'ocr', needsDocument: true, category: 'convert' },
  { id: 'optimize', needsDocument: true, category: 'optimize' },
  { id: 'repair', needsDocument: false, category: 'optimize' },
  { id: 'redact', needsDocument: true, category: 'security' },
  { id: 'rasterize', needsDocument: true, category: 'convert' },
  { id: 'flatten', needsDocument: true, category: 'forms' },
  { id: 'html', needsDocument: false, category: 'convert' },
  { id: 'create', needsDocument: false, category: 'pages' },
] as const

export type DocumentToolId = typeof DOCUMENT_TOOLS[number]['id']

export const EXTRA_TOOLS = [
  { id: 'crop', titleKey: 'extraTools.crop', hintKey: 'extraTools.cropHint', category: 'pages' },
  { id: 'pageSize', titleKey: 'extraTools.pageSize', hintKey: 'extraTools.pageSizeHint', category: 'pages' },
  { id: 'metadata', titleKey: 'extraTools.metadata', hintKey: 'extraTools.metadataHint', category: 'edit' },
  { id: 'removeMetadata', titleKey: 'extraTools.removeMetadata', hintKey: 'extraTools.removeMetadataHint', category: 'security' },
  { id: 'sheet', titleKey: 'extraTools.sheet', hintKey: 'extraTools.sheetHint', category: 'pages' },
  { id: 'halve', titleKey: 'extraTools.halve', hintKey: 'extraTools.halveHint', category: 'pages' },
  { id: 'bookmarks', titleKey: 'extraTools.bookmarks', hintKey: 'extraTools.bookmarksHint', category: 'edit' },
  { id: 'search', titleKey: 'extraTools.search', hintKey: 'extraTools.searchHint', category: 'edit' },
  { id: 'preferences', titleKey: 'extraTools.preferences', hintKey: 'extraTools.preferencesHint', category: 'edit' },
  { id: 'fields', titleKey: 'extraTools.fields', hintKey: 'extraTools.fieldsHint', category: 'forms' },
] as const

export type ExtraToolId = typeof EXTRA_TOOLS[number]['id']

export type AdvancedToolId = DocumentToolId | ExtraToolId
