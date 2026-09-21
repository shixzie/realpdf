import { create } from 'zustand'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { AnnotationsJSON, PageSourceInfo, PageState, Settings, Tool } from './types'
import { uid } from './lib/uid'
import { loadPdfDocument } from './lib/pdfjs'
import { emptyAnnotations } from './lib/serialize'
import { readPageFormWidgets, type FormValue, type FormWidget } from './lib/forms'
import {
  buildLibraryEntry,
  deleteProject,
  getProject,
  listProjects,
  makeThumbnail,
  projectToPdf,
  putProject,
  clearProjects,
  type LibraryMeta,
} from './lib/library'
import { restoreAssets } from './lib/assets'
import { t } from './i18n'

export type ToolsTab = 'merge' | 'split' | 'convert' | 'office'
export type PendingAction = ToolsTab | 'forms'
export type Theme = 'dark' | 'light'

function initialTheme(): Theme {
  if (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light') return 'light'
  return 'dark'
}

interface Snapshot {
  pages: PageState[]
}

export interface ToastMessage {
  id: number
  kind: 'info' | 'success' | 'error'
  message: string
}

interface LoadArgs {
  bytes: Uint8Array
  fileName: string
  pdf: PDFDocumentProxy
  pages: PageSourceInfo[]
}

interface AppState {
  fileName: string | null
  bytes: Uint8Array | null
  pdf: PDFDocumentProxy | null
  pages: PageState[]
  currentPageId: string | null
  zoom: number
  tool: Tool
  settings: Settings
  loading: boolean
  exporting: boolean
  exportProgress: number
  toast: ToastMessage | null
  error: string | null
  undoStack: Snapshot[]
  redoStack: Snapshot[]
  lastChangeAt: number
  fitNonce: number
  /** Bumped whenever the canvas selection changes, so panels re-read it. */
  selectionNonce: number
  /** Page whose objects were selected last, used to disambiguate pages. */
  selectionPage: string | null
  scrollRequest: { pageId: string; nonce: number } | null
  imagePickNonce: number
  flushFns: Set<() => void>

  theme: Theme
  pendingAction: PendingAction | null
  projectId: string | null
  libraryOpen: boolean
  libraryEntries: LibraryMeta[]
  libraryBusy: boolean
  toolsOpen: boolean
  toolsTab: ToolsTab
  hasForms: boolean
  formMode: boolean
  formLoading: boolean
  formWidgets: Record<string, FormWidget[]>
  formValues: Record<string, FormValue>
  formFlatten: boolean

  load: (args: LoadArgs) => void
  close: () => void
  setZoom: (zoom: number) => void
  zoomBy: (factor: number) => void
  requestFit: () => void
  setTool: (tool: Tool) => void
  updateSettings: (patch: Partial<Settings>) => void
  notifySelectionChange: () => void
  setSelectionPage: (pageId: string | null) => void
  setCurrentPage: (pageId: string) => void
  requestScrollTo: (pageId: string) => void
  requestImagePick: () => void
  addBlankPage: (afterIndex: number) => void
  deletePage: (pageId: string) => void
  movePage: (fromIndex: number, toIndex: number) => void
  beginChange: () => void
  commitAnnotations: (pageId: string, annotations: AnnotationsJSON) => void
  undo: () => void
  redo: () => void
  registerFlush: (fn: () => void) => () => void
  flushAll: () => Promise<void>
  setTheme: (theme: Theme) => void
  openLibrary: () => Promise<void>
  closeLibrary: () => void
  refreshLibrary: () => Promise<void>
  saveToLibrary: (exportedBytes: Uint8Array) => Promise<void>
  openLibraryEntry: (id: string) => Promise<void>
  downloadLibraryEntry: (id: string) => Promise<void>
  renameLibraryEntry: (id: string, title: string) => Promise<void>
  deleteLibraryEntry: (id: string) => Promise<void>
  clearLibrary: () => Promise<void>
  toggleTheme: () => void
  setPendingAction: (action: PendingAction | null) => void
  setToolsOpen: (open: boolean, tab?: ToolsTab) => void
  setToolsTab: (tab: ToolsTab) => void
  setHasForms: (hasForms: boolean) => void
  enterFormMode: () => Promise<void>
  exitFormMode: () => void
  setFormValue: (fieldName: string, value: FormValue) => void
  setFormFlatten: (flatten: boolean) => void
  setLoading: (loading: boolean) => void
  setExporting: (exporting: boolean, progress?: number) => void
  setError: (message: string | null) => void
  toastMessage: (kind: ToastMessage['kind'], message: string) => void
  clearToast: () => void
}

export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 4

/**
 * Monotonic sequence for external annotation replacements. It must only ever
 * increase so canvases always notice the change, even when undo restores an
 * older snapshot.
 */
let externalSeq = 0
function nextExternalRev(): number {
  externalSeq += 1
  return externalSeq
}

const DEFAULT_SETTINGS: Settings = {
  color: '#111827',
  strokeWidth: 2,
  fontSize: 16,
  fontFamily: 'Helvetica',
  highlightColor: '#facc15',
  highlightWidth: 14,
  whiteoutColor: '#ffffff',
}

function makePage(info: PageSourceInfo): PageState {
  return {
    id: uid(),
    sourceIndex: info.sourceIndex,
    width: info.width,
    height: info.height,
    transform: info.transform,
    rotation: info.rotation,
    annotations: emptyAnnotations(),
    externalRev: 0,
  }
}

/**
 * Serializes and commits every mounted canvas right away. Called before
 * history snapshots so that pending (debounced) canvas edits are included.
 */
function flushCanvasCommits(get: () => AppState): void {
  for (const fn of Array.from(get().flushFns)) {
    try {
      fn()
    } catch {
      // Keep flushing the remaining canvases.
    }
  }
}

export const useStore = create<AppState>()((set, get) => ({
  fileName: null,
  bytes: null,
  pdf: null,
  pages: [],
  currentPageId: null,
  zoom: 1,
  tool: 'select',
  settings: DEFAULT_SETTINGS,
  loading: false,
  exporting: false,
  exportProgress: 0,
  toast: null,
  error: null,
  undoStack: [],
  redoStack: [],
  lastChangeAt: 0,
  fitNonce: 0,
  selectionNonce: 0,
  selectionPage: null,
  scrollRequest: null,
  imagePickNonce: 0,
  flushFns: new Set(),

  theme: initialTheme(),
  pendingAction: null,
  projectId: null,
  libraryOpen: false,
  libraryEntries: [],
  libraryBusy: false,
  toolsOpen: false,
  toolsTab: 'merge',
  hasForms: false,
  formMode: false,
  formLoading: false,
  formWidgets: {},
  formValues: {},
  formFlatten: true,

  load: ({ bytes, fileName, pdf, pages }) =>
    set({
      bytes,
      fileName,
      pdf,
      pages: pages.map(makePage),
      currentPageId: null,
      zoom: 1,
      tool: 'select',
      undoStack: [],
      redoStack: [],
      lastChangeAt: 0,
      scrollRequest: null,
      error: null,
      fitNonce: get().fitNonce + 1,
      selectionPage: null,
      formMode: false,
      formWidgets: {},
      formValues: {},
      hasForms: false,
      projectId: null,
    }),

  close: () =>
    set({
      fileName: null,
      bytes: null,
      pdf: null,
      pages: [],
      currentPageId: null,
      undoStack: [],
      redoStack: [],
      tool: 'select',
      error: null,
      formMode: false,
      formWidgets: {},
      formValues: {},
      hasForms: false,
      toolsOpen: false,
      projectId: null,
      selectionPage: null,
    }),

  setZoom: (zoom) => set({ zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) }),
  zoomBy: (factor) => get().setZoom(get().zoom * factor),
  requestFit: () => set({ fitNonce: get().fitNonce + 1 }),
  setTool: (tool) => set({ tool }),
  updateSettings: (patch) => set({ settings: { ...get().settings, ...patch } }),
  notifySelectionChange: () => set({ selectionNonce: get().selectionNonce + 1 }),
  setSelectionPage: (pageId) => {
    if (get().selectionPage !== pageId) set({ selectionPage: pageId })
  },
  setCurrentPage: (pageId) => {
    if (get().currentPageId !== pageId) set({ currentPageId: pageId })
  },
  requestScrollTo: (pageId) => set({ scrollRequest: { pageId, nonce: Date.now() } }),
  requestImagePick: () => set({ imagePickNonce: get().imagePickNonce + 1 }),

  addBlankPage: (afterIndex) => {
    const { pages } = get()
    const source = pages[afterIndex] ?? pages[pages.length - 1]
    const width = source?.width ?? 595
    const height = source?.height ?? 842
    const page: PageState = {
      id: uid(),
      sourceIndex: null,
      width,
      height,
      transform: [1, 0, 0, -1, 0, height],
      rotation: 0,
      annotations: emptyAnnotations(),
      externalRev: 0,
    }
    get().beginChange()
    const next = [...pages]
    next.splice(afterIndex + 1, 0, page)
    set({ pages: next, currentPageId: page.id })
    requestAnimationFrame(() => get().requestScrollTo(page.id))
  },

  deletePage: (pageId) => {
    const { pages, currentPageId } = get()
    if (pages.length <= 1) {
      get().toastMessage('error', t('toasts.lastPage'))
      return
    }
    const index = pages.findIndex((p) => p.id === pageId)
    if (index < 0) return
    get().beginChange()
    const next = pages.filter((p) => p.id !== pageId)
    const neighbor = next[Math.min(index, next.length - 1)]
    set({ pages: next, currentPageId: currentPageId === pageId ? neighbor.id : currentPageId })
  },

  movePage: (fromIndex, toIndex) => {
    const { pages } = get()
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= pages.length || toIndex >= pages.length) return
    get().beginChange()
    const next = [...pages]
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    set({ pages: next })
  },

  beginChange: () => {
    const now = Date.now()
    const state = get()
    if (now - state.lastChangeAt > 500) {
      // Include pending canvas edits in the snapshot the user can return to.
      flushCanvasCommits(get)
      const fresh = get()
      set({
        undoStack: [...fresh.undoStack.slice(-39), { pages: fresh.pages }],
        redoStack: [],
        lastChangeAt: now,
      })
    } else {
      set({ lastChangeAt: now })
    }
  },

  commitAnnotations: (pageId, annotations) => {
    set((state) => ({
      pages: state.pages.map((page) => (page.id === pageId ? { ...page, annotations } : page)),
    }))
  },

  undo: () => {
    flushCanvasCommits(get)
    const state = get()
    if (!state.undoStack.length) return
    const entry = state.undoStack[state.undoStack.length - 1]
    set({
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack.slice(-39), { pages: state.pages }],
      pages: entry.pages.map((page) => ({ ...page, externalRev: nextExternalRev() })),
      lastChangeAt: 0,
    })
  },

  redo: () => {
    flushCanvasCommits(get)
    const state = get()
    if (!state.redoStack.length) return
    const entry = state.redoStack[state.redoStack.length - 1]
    set({
      redoStack: state.redoStack.slice(0, -1),
      undoStack: [...state.undoStack.slice(-39), { pages: state.pages }],
      pages: entry.pages.map((page) => ({ ...page, externalRev: nextExternalRev() })),
      lastChangeAt: 0,
    })
  },

  registerFlush: (fn) => {
    const flushFns = get().flushFns
    flushFns.add(fn)
    return () => flushFns.delete(fn)
  },

  openLibrary: async () => {
    set({ libraryOpen: true, libraryBusy: true })
    try {
      set({ libraryEntries: await listProjects(), libraryBusy: false })
    } catch (error) {
      console.error(error)
      set({ libraryBusy: false })
      get().toastMessage('error', t('toasts.libraryReadFailed'))
    }
  },

  closeLibrary: () => set({ libraryOpen: false }),

  refreshLibrary: async () => {
    try {
      set({ libraryEntries: await listProjects() })
    } catch (error) {
      console.error(error)
    }
  },

  saveToLibrary: async (exportedBytes) => {
    const state = get()
    if (!state.bytes) return
    try {
      const previous = state.projectId ? await getProject(state.projectId) : undefined
      const thumbnail = await makeThumbnail(exportedBytes)
      const entry = buildLibraryEntry({
        title: state.fileName ?? 'Untitled.pdf',
        sourceName: state.fileName ?? 'document.pdf',
        bytes: state.bytes,
        pages: state.pages,
        formValues: state.formValues,
        formFlatten: state.formFlatten,
        hasForms: state.hasForms,
        exportedBytes,
        previous,
        thumbnail,
      })
      await putProject(entry)
      set({ projectId: entry.id })
      await get().refreshLibrary()
    } catch (error) {
      console.error(error)
      const quota =
        error instanceof DOMException &&
        (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
      get().toastMessage('error', quota ? t('toasts.libraryFull') : t('toasts.librarySaveFailed'))
    }
  },

  openLibraryEntry: async (id) => {
    set({ libraryBusy: true })
    try {
      const entry = await getProject(id)
      if (!entry) {
        set({ libraryBusy: false })
        get().toastMessage('error', t('toasts.libraryMissing'))
        return
      }
      restoreAssets(entry.assets)
      const bytes = new Uint8Array(entry.sourceBytes)
      const loaded = await loadPdfDocument(bytes)
      set({
        bytes,
        fileName: entry.title,
        pdf: loaded.pdf,
        pages: entry.pages,
        currentPageId: null,
        zoom: 1,
        tool: 'select',
        undoStack: [],
        redoStack: [],
        lastChangeAt: 0,
        scrollRequest: null,
        error: null,
        fitNonce: get().fitNonce + 1,
        selectionPage: null,
        formValues: entry.formValues ?? {},
        formFlatten: entry.formFlatten ?? true,
        hasForms: entry.hasForms ?? false,
        formMode: false,
        formWidgets: {},
        projectId: entry.id,
        libraryOpen: false,
        libraryBusy: false,
      })
      get().toastMessage('success', t('toasts.restored', { title: entry.title }))
    } catch (error) {
      console.error(error)
      set({ libraryBusy: false })
      get().toastMessage('error', t('toasts.restoreFailed'))
    }
  },

  downloadLibraryEntry: async (id) => {
    set({ libraryBusy: true })
    try {
      const entry = await getProject(id)
      if (!entry) return
      const bytes = await projectToPdf(entry)
      const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = entry.title.replace(/\.pdf$/i, '') + '.pdf'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      console.error(error)
      get().toastMessage('error', t('toasts.rebuildFailed'))
    } finally {
      set({ libraryBusy: false })
    }
  },

  renameLibraryEntry: async (id, title) => {
    try {
      const entry = await getProject(id)
      if (!entry) return
      entry.title = title.trim() || entry.title
      entry.updatedAt = Date.now()
      await putProject(entry)
      await get().refreshLibrary()
      if (get().projectId === id) set({ fileName: entry.title })
    } catch (error) {
      console.error(error)
    }
  },

  deleteLibraryEntry: async (id) => {
    try {
      await deleteProject(id)
      if (get().projectId === id) set({ projectId: null })
      await get().refreshLibrary()
    } catch (error) {
      console.error(error)
    }
  },

  clearLibrary: async () => {
    try {
      await clearProjects()
      set({ projectId: null, libraryEntries: [] })
    } catch (error) {
      console.error(error)
    }
  },

  setTheme: (theme) => {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = theme
      const meta = document.querySelector('meta[name="theme-color"]')
      if (meta) meta.setAttribute('content', theme === 'light' ? '#f4efe4' : '#0b0f14')
    }
    try {
      localStorage.setItem('realpdf-theme', theme)
    } catch {
      // Storage can be unavailable in private modes; the theme still applies.
    }
    set({ theme })
  },

  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),

  setPendingAction: (pendingAction) => set({ pendingAction }),

  setToolsOpen: (open, tab) => set({ toolsOpen: open, toolsTab: tab ?? get().toolsTab }),
  setToolsTab: (tab) => set({ toolsTab: tab }),
  setHasForms: (hasForms) => set({ hasForms }),

  enterFormMode: async () => {
    const state = get()
    if (!state.pdf) return
    set({ formMode: true, formLoading: true })
    try {
      const widgets: Record<string, FormWidget[]> = {}
      for (const page of get().pages) {
        if (page.sourceIndex == null) {
          widgets[page.id] = []
          continue
        }
        widgets[page.id] = await readPageFormWidgets(get().pdf as PDFDocumentProxy, page.sourceIndex, page.id)
      }
      set({ formWidgets: widgets, formLoading: false })
    } catch (error) {
      console.error(error)
      set({ formLoading: false })
      get().toastMessage('error', t('toasts.formsReadFailed'))
    }
  },

  exitFormMode: () => set({ formMode: false }),

  setFormValue: (fieldName, value) =>
    set({ formValues: { ...get().formValues, [fieldName]: value } }),

  setFormFlatten: (formFlatten) => set({ formFlatten }),

  flushAll: async () => {
    for (const fn of Array.from(get().flushFns)) {
      try {
        fn()
      } catch {
        // Keep flushing even if one canvas fails.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  },

  setLoading: (loading) => set({ loading }),
  setExporting: (exporting, progress = 0) => set({ exporting, exportProgress: progress }),
  setError: (message) => set({ error: message }),

  toastMessage: (kind, message) => {
    const id = Date.now() + Math.random()
    set({ toast: { id, kind, message } })
    setTimeout(() => {
      if (get().toast?.id === id) set({ toast: null })
    }, 4200)
  },

  clearToast: () => set({ toast: null }),
}))
