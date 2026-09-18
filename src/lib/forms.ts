import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
} from 'pdf-lib'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'

export type FormValue = string | boolean | string[]

export type FormWidgetType = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'list' | 'button' | 'unknown'

export interface FormWidget {
  /** Unique key for this widget on the page. */
  id: string
  /** Fully qualified field name. */
  fieldName: string
  type: FormWidgetType
  /** Widget rectangle in page view coordinates (points at scale 1, y down). */
  rect: { x: number; y: number; width: number; height: number }
  options: string[]
  exportValue?: string
  multiLine: boolean
  readOnly: boolean
  maxLength?: number
  defaultValue: FormValue | undefined
}

interface AnnotationLike {
  id?: string
  subtype?: string
  fieldName?: string
  fieldType?: string
  fieldValue?: unknown
  defaultFieldValue?: unknown
  alternativeText?: string
  checkBox?: boolean
  radioButton?: boolean
  pushButton?: boolean
  combo?: boolean
  multiLine?: boolean
  readOnly?: boolean
  maxLen?: number
  exportValue?: string
  rect?: number[]
  options?: Array<{ exportValue?: string; displayValue?: string } | string>
}

function normalizeValue(value: unknown): FormValue | undefined {
  if (value == null) return undefined
  if (typeof value === 'boolean' || typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(String)
  return String(value)
}

function defaultFor(type: FormWidgetType, annotation: AnnotationLike): FormValue | undefined {
  const raw = annotation.fieldValue ?? annotation.defaultFieldValue
  if (type === 'checkbox') {
    if (typeof raw === 'boolean') return raw
    if (typeof raw === 'string') return raw !== '' && raw !== 'Off' && raw !== 'No' && raw !== 'false'
    return false
  }
  return normalizeValue(raw)
}

function widgetType(annotation: AnnotationLike): FormWidgetType {
  if (annotation.fieldType === 'Btn') {
    if (annotation.pushButton) return 'button'
    if (annotation.radioButton) return 'radio'
    if (annotation.checkBox) return 'checkbox'
    return 'unknown'
  }
  if (annotation.fieldType === 'Ch') return annotation.combo ? 'dropdown' : 'list'
  if (annotation.fieldType === 'Tx') return 'text'
  return 'unknown'
}

/** Reads the interactive form widgets of one page. */
export async function readPageFormWidgets(
  pdf: PDFDocumentProxy,
  pageIndex: number,
  pageId: string,
): Promise<FormWidget[]> {
  let page: PDFPageProxy
  try {
    page = await pdf.getPage(pageIndex + 1)
  } catch {
    return []
  }
  const viewport = page.getViewport({ scale: 1 })
  const annotations = (await page.getAnnotations({ intent: 'display' })) as AnnotationLike[]
  const widgets: FormWidget[] = []
  for (let i = 0; i < annotations.length; i += 1) {
    const annotation = annotations[i]
    if (annotation.subtype !== 'Widget' || !annotation.fieldName || !annotation.rect) continue
    const type = widgetType(annotation)
    if (type === 'button' || type === 'unknown') continue
    const [px1, py1, px2, py2] = annotation.rect
    const [vx1, vy1] = viewport.convertToViewportPoint(px1, py1)
    const [vx2, vy2] = viewport.convertToViewportPoint(px2, py2)
    const x = Math.min(vx1, vx2)
    const y = Math.min(vy1, vy2)
    const width = Math.abs(vx2 - vx1)
    const height = Math.abs(vy2 - vy1)
    if (width <= 0.5 || height <= 0.5) continue
    const options = (annotation.options ?? []).map((option) =>
      typeof option === 'string' ? option : String(option.exportValue ?? option.displayValue ?? ''),
    )
    widgets.push({
      id: `${pageId}:${annotation.id ?? annotation.fieldName}:${i}`,
      fieldName: annotation.fieldName,
      type,
      rect: { x, y, width, height },
      options,
      exportValue: annotation.exportValue,
      multiLine: Boolean(annotation.multiLine),
      readOnly: Boolean(annotation.readOnly),
      maxLength: annotation.maxLen && annotation.maxLen > 0 ? annotation.maxLen : undefined,
      defaultValue: defaultFor(type, annotation),
    })
  }
  return widgets
}

/** True when the document exposes fillable AcroForm fields. */
export async function pdfHasFormFields(bytes: Uint8Array): Promise<boolean> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
    return doc.getForm().getFields().length > 0
  } catch {
    return false
  }
}

function sanitize(value: string): string {
  return value.replace(/[^\n\u0020-\u00ff]/g, '?')
}

export interface ApplyFormOptions {
  flatten: boolean
}

/**
 * Writes form values into the document. Flattening bakes the values into the
 * page content, which is the safest option when the result is re-exported by
 * pdf-lib (page copies do not carry the document-level AcroForm).
 */
export async function applyFormValues(
  bytes: Uint8Array,
  values: Record<string, FormValue>,
  options: ApplyFormOptions = { flatten: true },
): Promise<{ bytes: Uint8Array; applied: number; errors: string[] }> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  const form = doc.getForm()
  const fields = form.getFields()
  const errors: string[] = []
  let applied = 0

  for (const field of fields) {
    const name = field.getName()
    if (!(name in values)) continue
    const value = values[name]
    try {
      if (field instanceof PDFTextField) {
        field.setText(typeof value === 'string' ? sanitize(value) : String(value))
        applied += 1
      } else if (field instanceof PDFCheckBox) {
        if (value === true || value === 'true' || value === field.getName()) field.check()
        else field.uncheck()
        applied += 1
      } else if (field instanceof PDFRadioGroup) {
        if (typeof value === 'string' && value) field.select(value)
        applied += 1
      } else if (field instanceof PDFDropdown) {
        const selection = Array.isArray(value) ? value[0] : value
        if (typeof selection === 'string' && selection) field.select(selection)
        applied += 1
      } else if (field instanceof PDFOptionList) {
        const selection = Array.isArray(value) ? value : [String(value)]
        const valid = selection.filter((entry) => field.getOptions().includes(entry))
        if (valid.length) field.select(valid)
        applied += 1
      }
    } catch (error) {
      errors.push(`${name}: ${(error as Error).message}`)
    }
  }

  if (options.flatten) {
    try {
      form.flatten()
    } catch (error) {
      errors.push(`flatten: ${(error as Error).message}`)
    }
  }
  const saved = await doc.save({ useObjectStreams: true })
  return { bytes: saved, applied, errors }
}
