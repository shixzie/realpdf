import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Canvas, Line, type FabricObject, type TPointerEventInfo } from 'fabric'
import { useStore } from '../store'
import { hydrateAnnotations, serializeCanvas } from '../lib/serialize'
import {
  commitCanvas,
  insertImageObject,
  registerCanvas,
  unregisterCanvas,
} from '../lib/canvasRegistry'
import {
  applyToolToCanvas,
  createShape,
  createTextObject,
  eraseObjectAt,
  finalizeArrow,
  isShapeTool,
  isTextObject,
  updateShape,
  type Vec,
} from '../lib/tools'
import {
  createPdfTextEditObject,
  fitPdfTextEditWidth,
  loadPageTextRuns,
  registerCanvasFonts,
  runAtPoint,
  runCoveredByEdit,
  sampleRunColors,
  spawnBoxOf,
  updateTextHighlight,
  type TextRun,
} from '../lib/textEdit'
import {
  applyTextEditPreviewBackgrounds,
  buildTextEditPreview,
  textEditSignature,
  type TextEditPreviewState,
} from '../lib/textEditPreview'
import { imageFileToDataUrl } from '../lib/assets'
import { useTranslation } from '../i18n'
import { FormsLayer } from './FormsLayer'

interface PageViewProps {
  pageIndex: number
}

type AnyObject = FabricObject & Record<string, any>

interface Draft {
  kind: string
  start: Vec
  obj: FabricObject | null
}

export function PageView({ pageIndex }: PageViewProps) {
  const { t } = useTranslation()
  const page = useStore((state) => state.pages[pageIndex])
  const zoom = useStore((state) => state.zoom)
  const tool = useStore((state) => state.tool)
  const settings = useStore((state) => state.settings)
  const formMode = useStore((state) => state.formMode)
  const pdf = useStore((state) => state.pdf)
  const bytes = useStore((state) => state.bytes)

  const slotRef = useRef<HTMLDivElement>(null)
  const baseRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<Canvas | null>(null)
  const loadedExternalRef = useRef(-1)
  const suppressRef = useRef(false)
  const readyRef = useRef(false)
  const draftingRef = useRef(false)
  const draftRef = useRef<Draft | null>(null)
  const commitTimerRef = useRef<number | null>(null)
  const loadTokenRef = useRef(0)
  const textRunsRef = useRef<TextRun[] | null>(null)
  const hoverRectRef = useRef<FabricObject | null>(null)
  const textEditTokenRef = useRef(0)
  const downTextRef = useRef<{ hadActiveText: boolean; target: AnyObject | null } | null>(null)
  const previewRef = useRef<TextEditPreviewState | null>(null)
  const previewPageRef = useRef<string | null>(null)
  const previewBuildRef = useRef<{ pageId: string; signature: string } | null>(null)
  const previewTokenRef = useRef(0)
  // Bumps when the live preview changes so the base canvas re-renders.
  const [previewRev, setPreviewRev] = useState(0)

  const latest = useRef({ tool, settings, pageId: page?.id ?? '' })
  latest.current = { tool, settings, pageId: page?.id ?? '' }

  const commitNow = useCallback(() => {
    if (commitTimerRef.current != null) {
      window.clearTimeout(commitTimerRef.current)
      commitTimerRef.current = null
    }
    const canvas = canvasRef.current
    // Never serialize a canvas whose annotations are still loading — that
    // would store an empty page and wipe the real one.
    if (!canvas || !readyRef.current) return
    const store = useStore.getState()
    const pageId = latest.current.pageId
    const page = store.pages.find((candidate) => candidate.id === pageId)
    // If the page changed externally (undo/redo/page ops) after the canvas was
    // loaded, the external state wins — committing here would clobber it.
    if (!page || page.externalRev !== loadedExternalRef.current) return
    store.commitAnnotations(pageId, serializeCanvas(canvas))
  }, [])

  const scheduleCommit = useCallback(() => {
    if (commitTimerRef.current != null) window.clearTimeout(commitTimerRef.current)
    commitTimerRef.current = window.setTimeout(commitNow, 350)
  }, [commitNow])

  /** Draws the hover highlight without recording it as an annotation change. */
  const setHighlight = useCallback((canvas: Canvas, bounds: TextRun['bounds'] | null) => {
    suppressRef.current = true
    try {
      hoverRectRef.current = updateTextHighlight(canvas, hoverRectRef.current, bounds)
    } finally {
      suppressRef.current = false
    }
  }, [])

  /**
   * Selects the whole replacement text once the pointer interaction is over;
   * fabric positions the caret on mouse-up, after this handler has run.
   */
  const selectAllWhenEditing = useCallback((target: AnyObject, canvas: Canvas) => {
    const focus = () => {
      if (!(target as { isEditing?: boolean }).isEditing) return
      target.selectAll?.()
      canvas.requestRenderAll()
    }
    focus()
    window.setTimeout(focus, 50)
  }, [])

  /** Runs that no existing replacement already consumed (deleted or covered). */
  const runsAvailableForEdit = useCallback((canvas: Canvas, runs: TextRun[]): TextRun[] => {
    const spawns = canvas.getObjects().map(spawnBoxOf).filter((spawn): spawn is NonNullable<typeof spawn> => spawn != null)
    if (!spawns.length) return runs
    return runs.filter((run) => !spawns.some((spawn) => runCoveredByEdit(run, spawn)))
  }, [])

  const onTextEditClick = useCallback(async (canvas: Canvas, event: TPointerEventInfo) => {
    const token = textEditTokenRef.current + 1
    textEditTokenRef.current = token
    const target = canvas.findTarget(event.e).target as (FabricObject & Record<string, any>) | undefined
    if (target?.data?.kind === 'pdftext') {
      if (target.isEditing) return
      canvas.setActiveObject(target)
      target.enterEditing?.()
      selectAllWhenEditing(target, canvas)
      canvas.requestRenderAll()
      return
    }
    const store = useStore.getState()
    const current = store.pages.find((candidate) => candidate.id === latest.current.pageId)
    if (!current || current.sourceIndex == null || !store.pdf) return
    const scene = canvas.getScenePoint(event.e)
    const available = await loadPageTextRuns(store.pdf, current.sourceIndex, current.transform)
    if (token !== textEditTokenRef.current || canvasRef.current !== canvas) return
    const run = runsAvailableForEdit(canvas, available).find((candidate) => runAtPoint(candidate, scene.x, scene.y))
    if (!run) return
    const pdfPage = await store.pdf.getPage(current.sourceIndex + 1)
    const colors = await sampleRunColors(pdfPage, run)
    if (token !== textEditTokenRef.current || canvasRef.current !== canvas) return
    useStore.getState().beginChange()
    const object = createPdfTextEditObject(run, colors)
    // Measured with the loaded face, so the run never wraps even before typing.
    fitPdfTextEditWidth(object)
    canvas.add(object)
    // Publish the edit right away so the final-result preview starts building.
    commitCanvas(latest.current.pageId)
    setHighlight(canvas, null)
    canvas.setActiveObject(object)
    object.enterEditing()
    selectAllWhenEditing(object, canvas)
    canvas.requestRenderAll()
    scheduleCommit()
  }, [runsAvailableForEdit, scheduleCommit, setHighlight, selectAllWhenEditing])

  const viewWidth = Math.max(1, (page?.width ?? 1) * zoom)
  const viewHeight = Math.max(1, (page?.height ?? 1) * zoom)
  const initialSize = useMemo(() => ({ width: viewWidth, height: viewHeight }), [])
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  // Create the fabric overlay once per mounted page.
  useEffect(() => {
    const host = hostRef.current
    if (!host || !page) return
    // Drop any canvas left behind by a previous mount of this page.
    host.replaceChildren()
    const element = document.createElement('canvas')
    host.appendChild(element)
    const canvas = new Canvas(element, {
      width: initialSize.width,
      height: initialSize.height,
      selection: false,
      preserveObjectStacking: true,
      stopContextMenu: true,
      fireRightClick: false,
    })
    canvas.setZoom(zoomRef.current)
    canvasRef.current = canvas
    registerCanvas(page.id, canvas)
    latest.current.pageId = page.id
    loadedExternalRef.current = page.externalRev

    const onChange = () => {
      if (suppressRef.current || draftingRef.current) return
      useStore.getState().beginChange()
      scheduleCommit()
    }

    canvas.on('object:added', onChange)
    canvas.on('object:removed', onChange)
    canvas.on('object:modified', onChange)
    canvas.on('text:changed', (event) => {
      const target = event.target as AnyObject | undefined
      // A replacement extends along the baseline as it is typed, like the run
      // it replaces, instead of wrapping inside the original run's width.
      if (target?.data?.kind === 'pdftext') fitPdfTextEditWidth(target)
      onChange()
    })

    canvas.on('path:created', (event) => {
      const path = (event as unknown as { path: AnyObject }).path
      if (!path) return
      const kind = latest.current.tool === 'highlighter' ? 'highlight' : 'draw'
      path.set({ data: { kind } })
      if (kind === 'highlight') {
        path.set({ opacity: 0.35, globalCompositeOperation: 'multiply' })
      }
      onChange()
    })

    // Selecting a text object activates the text tool so its style options are
    // shown and apply to the selection.
    const onSelectionChange = () => {
      const store = useStore.getState()
      const selected = canvas.getActiveObjects()
      if (selected.some((object) => isTextObject(object))) {
        store.setTextSelectionPage(page.id)
        if (latest.current.tool !== 'text') store.setTool('text')
      } else if (!selected.length && store.textSelectionPage === page.id) {
        store.setTextSelectionPage(null)
      }
      store.notifySelectionChange()
    }
    canvas.on('selection:created', onSelectionChange)
    canvas.on('selection:updated', onSelectionChange)
    canvas.on('selection:cleared', onSelectionChange)

    canvas.on('text:editing:exited', (event) => {
      const target = event.target as AnyObject | undefined
      if (!target) return
      if (target.data?.kind === 'pdftext') {
        const value = String(target.text ?? '')
        const spawn = target.data?.spawn as
          | { left: number; top: number; width: number; angle: number }
          | undefined
        const styled = Boolean(target.data?.styled)
        // Width is managed by the auto-fit (the box grows with the text), so
        // only the text, place and style decide whether anything changed.
        const untouched =
          !styled &&
          spawn != null &&
          value === target.data?.originalText &&
          Math.abs((target.left ?? 0) - spawn.left) < 0.75 &&
          Math.abs((target.top ?? 0) - spawn.top) < 0.75 &&
          Math.abs((target.angle ?? 0) - spawn.angle) < 0.5
        if (!value.trim() || untouched) {
          canvas.remove(target)
          canvas.requestRenderAll()
          onChange()
        }
        // Finishing a replacement leaves the edit-text tool active so the next
        // run can be clicked without re-picking the tool.
        const store = useStore.getState()
        if (store.tool === 'text') store.setTool('textedit')
        return
      }
      if (target.data?.kind !== 'text') return
      const value = String(target.text ?? '')
      const placeholderText = target.data?.placeholderText
      if (value.trim() === '' || (target.data?.placeholder && placeholderText && value.trim() === placeholderText)) {
        canvas.remove(target)
        canvas.requestRenderAll()
        onChange()
      } else if (target.data?.placeholder) {
        target.set({ data: { ...target.data, placeholder: false } })
      }
    })

    // Snapshot the selection before fabric processes the click, so the text
    // tool can tell a click on a text from a click that only deselects one.
    canvas.on('mouse:down:before', (opt: TPointerEventInfo) => {
      if (latest.current.tool !== 'text') return
      const target = canvas.findTarget(opt.e).target as AnyObject | undefined
      downTextRef.current = {
        hadActiveText: isTextObject(canvas.getActiveObject()),
        target: target && isTextObject(target) ? target : null,
      }
    })

    canvas.on('mouse:down', (opt: TPointerEventInfo) => {
      const { tool: activeTool, settings: activeSettings } = latest.current
      if (activeTool === 'textedit') {
        void onTextEditClick(canvas, opt)
        return
      }
      if (activeTool === 'text') {
        const down = downTextRef.current
        downTextRef.current = null
        const target = down?.target
        if (target) {
          // Clicking a PDF text replacement opens it for editing, like the
          // edit-text tool. Plain text boxes are left to fabric: the first
          // click selects them, clicking a selected one starts editing.
          if (target.data?.kind === 'pdftext' && !target.isEditing && !target.getActiveControl?.()) {
            canvas.setActiveObject(target)
            target.enterEditing?.()
            selectAllWhenEditing(target, canvas)
            canvas.requestRenderAll()
          }
          return
        }
        // A click away from a selected text box only clears it; the next click
        // creates a new one.
        if (down?.hadActiveText) return
        useStore.getState().beginChange()
        const point = canvas.getScenePoint(opt.e)
        createTextObject(canvas, point, activeSettings)
        return
      }
      if (activeTool === 'eraser') {
        if (eraseObjectAt(canvas, opt.e)) commitCanvas(latest.current.pageId)
        return
      }
      if (activeTool === 'select') {
        // Clicking a text that is already selected fires no selection event,
        // so pick the text tool here too.
        const target = canvas.findTarget(opt.e).target as AnyObject | undefined
        if (target && isTextObject(target) && canvas.getActiveObject() === target) {
          useStore.getState().setTool('text')
        }
        return
      }
      if (!isShapeTool(activeTool)) return
      if (canvas.getActiveObject()) canvas.discardActiveObject()
      useStore.getState().beginChange()
      draftingRef.current = true
      draftRef.current = { kind: activeTool, start: canvas.getScenePoint(opt.e), obj: null }
    })

    canvas.on('mouse:move', (opt: TPointerEventInfo) => {
      if (latest.current.tool === 'textedit') {
        const target = canvas.findTarget(opt.e).target as AnyObject | undefined
        const point = canvas.getScenePoint(opt.e)
        let bounds: TextRun['bounds'] | null = null
        if (target?.data?.kind !== 'pdftext') {
          const runs = runsAvailableForEdit(canvas, textRunsRef.current ?? [])
          const run = runs.find((candidate) => runAtPoint(candidate, point.x, point.y))
          if (run) bounds = run.bounds
        }
        setHighlight(canvas, bounds)
        return
      }
      const draft = draftRef.current
      if (!draft) return
      const point = canvas.getScenePoint(opt.e)
      const { settings: activeSettings } = latest.current
      const needsRecreate = !draft.obj || draft.kind === 'line' || draft.kind === 'arrow'
      if (needsRecreate) {
        if (draft.obj) canvas.remove(draft.obj)
        draft.obj = createShape(draft.kind as never, draft.start, point, activeSettings)
        canvas.add(draft.obj)
      } else if (draft.obj) {
        updateShape(draft.kind as never, draft.obj, draft.start, point)
      }
      canvas.requestRenderAll()
    })

    canvas.on('mouse:up', () => {
      const draft = draftRef.current
      if (!draft) return
      draftRef.current = null
      draftingRef.current = false
      const { settings: activeSettings } = latest.current
      if (!draft.obj) return
      if (draft.kind === 'arrow') {
        canvas.remove(draft.obj)
        const group = finalizeArrow(canvas, draft.obj as Line, activeSettings)
        canvas.add(group)
        canvas.setActiveObject(group)
      } else {
        canvas.setActiveObject(draft.obj)
      }
      canvas.requestRenderAll()
      useStore.getState().setTool('select')
      onChange()
    })

    const unregisterFlush = useStore.getState().registerFlush(commitNow)

    suppressRef.current = true
    readyRef.current = false
    const token = loadTokenRef.current + 1
    loadTokenRef.current = token
    void canvas.loadFromJSON(hydrateAnnotations(page.annotations)).then(() => {
      if (loadTokenRef.current !== token || canvasRef.current !== canvas) return
      suppressRef.current = false
      readyRef.current = true
      canvas.setDimensions({ width: initialSize.width, height: initialSize.height })
      canvas.setZoom(zoomRef.current)
      applyToolToCanvas(canvas, latest.current.tool, latest.current.settings)
      applyTextEditPreviewBackgrounds(
        canvas,
        previewPageRef.current === page.id ? (previewRef.current?.removedIds ?? new Set<string>()) : null,
      )
      canvas.requestRenderAll()
      void registerCanvasFonts(canvas)
    })

    return () => {
      unregisterFlush()
      commitNow()
      unregisterCanvas(page.id, canvas)
      canvasRef.current = null
      hoverRectRef.current = null
      void canvas.dispose()
      suppressRef.current = false
      readyRef.current = false
      draftRef.current = null
      draftingRef.current = false
      downTextRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.id])

  // Keep the overlay in sync with the zoom level.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.setDimensions({ width: viewWidth, height: viewHeight })
    canvas.setZoom(zoom)
    canvas.requestRenderAll()
  }, [viewWidth, viewHeight, zoom])

  // Re-load annotations when they were replaced externally (undo/redo/page ops).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !page) return
    if (loadedExternalRef.current === page.externalRev) return
    // An external change (undo/redo/page op) wins over any pending commit.
    if (commitTimerRef.current != null) {
      window.clearTimeout(commitTimerRef.current)
      commitTimerRef.current = null
    }
    const token = loadTokenRef.current + 1
    loadTokenRef.current = token
    suppressRef.current = true
    readyRef.current = false
    canvas.discardActiveObject()
    void canvas.loadFromJSON(hydrateAnnotations(page.annotations)).then(() => {
      if (loadTokenRef.current !== token || canvasRef.current !== canvas) return
      suppressRef.current = false
      readyRef.current = true
      loadedExternalRef.current = page.externalRev
      canvas.setDimensions({ width: viewWidth, height: viewHeight })
      canvas.setZoom(zoom)
      applyToolToCanvas(canvas, latest.current.tool, latest.current.settings)
      applyTextEditPreviewBackgrounds(
        canvas,
        previewPageRef.current === page.id ? (previewRef.current?.removedIds ?? new Set<string>()) : null,
      )
      canvas.requestRenderAll()
      void registerCanvasFonts(canvas)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.externalRev])

  // Pre-load the page's existing text while the edit tool is active.
  useEffect(() => {
    if (tool !== 'textedit' || !page || page.sourceIndex == null || !pdf) {
      textRunsRef.current = null
      return
    }
    let cancelled = false
    void loadPageTextRuns(pdf, page.sourceIndex, page.transform).then((runs) => {
      if (!cancelled) textRunsRef.current = runs
    })
    return () => {
      cancelled = true
    }
  }, [tool, page?.id, page?.sourceIndex, pdf])

  // Drop the hover highlight when leaving the edit tool.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || tool === 'textedit') return
    setHighlight(canvas, null)
  }, [tool, setHighlight])

  // Apply the active tool.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    applyToolToCanvas(canvas, tool, settings)
  }, [tool, settings])

  /**
   * Rebuild the final-result preview whenever the page's real text edits
   * change. The exporter deletes the original runs from the content stream;
   * the preview applies the exact same rewrite to a scratch copy of the page
   * and renders it, so what is on screen is what will be saved.
   *
   * Commits that do not change the removal set (typing, styling the overlay)
   * keep the in-flight or finished build instead of restarting it.
   */
  useEffect(() => {
    const pageId = page?.id
    const sourceIndex = page?.sourceIndex
    if (!pageId || sourceIndex == null || !bytes) return
    const annotations = page.annotations
    const signature = textEditSignature(annotations.objects)
    if (!signature) {
      const hadPreview = previewPageRef.current != null || previewRef.current != null || previewBuildRef.current != null
      if (!hadPreview) return
      previewTokenRef.current += 1
      previewRef.current = null
      previewPageRef.current = null
      previewBuildRef.current = null
      setPreviewRev((value) => value + 1)
      return
    }
    const building = previewBuildRef.current
    if (building && building.pageId === pageId && building.signature === signature) return
    if (previewPageRef.current === pageId && previewRef.current?.signature === signature) return
    const token = previewTokenRef.current + 1
    previewTokenRef.current = token
    previewBuildRef.current = { pageId, signature }
    void buildTextEditPreview(bytes, { sourceIndex, transform: page.transform }, annotations.objects).then((state) => {
      if (previewTokenRef.current !== token) return
      previewRef.current = state
      previewPageRef.current = pageId
      previewBuildRef.current = null
      setPreviewRev((value) => value + 1)
    })
  }, [page?.id, page?.sourceIndex, page?.transform, page?.annotations, bytes])

  // Render the PDF page bitmap, from the preview copy when one exists.
  const sourceIndex = page?.sourceIndex ?? null
  useEffect(() => {
    const element = baseRef.current
    if (!element || !page) return
    let cancelled = false
    let task: { cancel: () => void; promise: Promise<void> } | null = null
    if (sourceIndex == null || !pdf) {
      element.width = 1
      element.height = 1
      element.style.width = `${page.width * zoom}px`
      element.style.height = `${page.height * zoom}px`
      return
    }
    const preview = previewPageRef.current === page.id ? previewRef.current : null
    const previewDoc = preview?.pdf ?? null
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    void (async () => {
      try {
        const pdfPage = previewDoc ? await previewDoc.getPage(1) : await pdf.getPage(sourceIndex + 1)
        if (cancelled) return
        const viewport = pdfPage.getViewport({ scale: zoom * dpr })
        element.width = Math.max(1, Math.floor(viewport.width))
        element.height = Math.max(1, Math.floor(viewport.height))
        element.style.width = `${page.width * zoom}px`
        element.style.height = `${page.height * zoom}px`
        const renderTask = pdfPage.render({ canvas: element, viewport })
        task = renderTask as unknown as { cancel: () => void; promise: Promise<void> }
        await renderTask.promise
        // Only drop the covers once the patched bitmap is actually painted.
        if (!cancelled) applyTextEditPreviewBackgrounds(canvasRef.current, preview ? preview.removedIds : null)
      } catch (error) {
        if ((error as Error)?.name !== 'RenderingCancelledException') console.error(error)
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [pdf, sourceIndex, zoom, page?.width, page?.height, previewRev])

  const onDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      const file = Array.from(event.dataTransfer.files).find((f) => f.type.startsWith('image/'))
      if (!file) return
      const canvas = canvasRef.current
      const slot = slotRef.current
      if (!canvas || !slot || !page) return
      event.preventDefault()
      event.stopPropagation()
      const rect = slot.getBoundingClientRect()
      const center = {
        x: (event.clientX - rect.left) / zoom,
        y: (event.clientY - rect.top) / zoom,
      }
      try {
        const { src } = await imageFileToDataUrl(file)
        useStore.getState().beginChange()
        await insertImageObject(canvas, src, { center })
        commitCanvas(page.id)
        useStore.getState().setTool('select')
      } catch (error) {
        console.error(error)
        useStore.getState().toastMessage('error', t('toasts.addImageFailed'))
      }
    },
    [page, zoom, t],
  )

  if (!page) return null

  return (
    <div
      ref={slotRef}
      className={`page ${formMode ? 'is-form-mode' : ''}`}
      data-page-index={pageIndex}
      style={{ width: viewWidth, height: viewHeight }}
      onDrop={onDrop}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault()
      }}
    >
      <canvas ref={baseRef} className="page-base" />
      <div ref={hostRef} className="page-overlay" />
      {formMode && <FormsLayer page={page} />}
      <div className="page-number" aria-hidden>
        {pageIndex + 1}
      </div>
    </div>
  )
}
