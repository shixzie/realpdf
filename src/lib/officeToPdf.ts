import { t } from '../i18n'
import { docxToPdf } from './docxToPdf'
import { pptxToPdf } from './pptxToPdf'
import { readZip } from './zipRead'
import { xlsxToPdf } from './xlsxToPdf'

export type OfficeKind = 'docx' | 'xlsx' | 'pptx'

export const OFFICE_EXTENSIONS: readonly OfficeKind[] = ['docx', 'xlsx', 'pptx']

export function officeKindFromName(name: string): OfficeKind | null {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  return OFFICE_EXTENSIONS.includes(extension as OfficeKind) ? (extension as OfficeKind) : null
}

export function isOfficeFileName(name: string): boolean {
  return officeKindFromName(name) !== null
}

export function sniffOfficeKind(bytes: Uint8Array): OfficeKind | null {
  let entries
  try {
    entries = readZip(bytes)
  } catch {
    return null
  }
  if (entries.has('word/document.xml')) return 'docx'
  if (entries.has('xl/workbook.xml')) return 'xlsx'
  if (entries.has('ppt/presentation.xml')) return 'pptx'
  return null
}

/** Converts a Word/Excel/PowerPoint package to a PDF, entirely in the browser. */
export async function officeToPdf(bytes: Uint8Array, fileName = ''): Promise<Uint8Array> {
  const kind = officeKindFromName(fileName) ?? sniffOfficeKind(bytes)
  if (!kind) throw new Error(t('errors.unsupportedOffice'))
  if (kind === 'docx') return docxToPdf(bytes)
  if (kind === 'xlsx') return xlsxToPdf(bytes)
  return pptxToPdf(bytes)
}
