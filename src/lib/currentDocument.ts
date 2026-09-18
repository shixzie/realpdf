import { useStore } from '../store'
import { buildPdf, type ExportPageInput } from './export'
import { hydrateAnnotations } from './serialize'
import { applyFormValues } from './forms'

export function exportPageInputs(): ExportPageInput[] {
  return useStore.getState().pages.map((page) => ({
    sourceIndex: page.sourceIndex,
    width: page.width,
    height: page.height,
    transform: page.transform,
    objects: hydrateAnnotations(page.annotations).objects,
  }))
}

/**
 * Builds the current document with all edits baked in: form values applied,
 * annotations drawn and pages added/removed/reordered. Used by the merge,
 * split and conversion tools so they operate on what the user sees.
 */
export async function bakedCurrentBytes(): Promise<Uint8Array> {
  const state = useStore.getState()
  if (!state.bytes) throw new Error('Open a document first')
  await state.flushAll()
  let source = state.bytes
  const fresh = useStore.getState()
  if (fresh.hasForms && Object.keys(fresh.formValues).length > 0) {
    const filled = await applyFormValues(source, fresh.formValues, { flatten: fresh.formFlatten })
    source = filled.bytes
  }
  return await buildPdf(source, exportPageInputs())
}
