import { useRef } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  BookOpen,
  ClipboardList,
  Download,
  FileText,
  FolderOpen,
  Heart,
  Loader2,
  Maximize,
  Moon,
  Redo2,
  Sun,
  Undo2,
  Wrench,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useStore } from '../store'
import { openPdfFile } from '../lib/openDocument'
import { runExport } from '../lib/exportController'
import { getCanvas } from '../lib/canvasRegistry'

export function TopBar() {
  const fileName = useStore((state) => state.fileName)
  const pages = useStore((state) => state.pages)
  const currentPageId = useStore((state) => state.currentPageId)
  const zoom = useStore((state) => state.zoom)
  const loading = useStore((state) => state.loading)
  const exporting = useStore((state) => state.exporting)
  const hasForms = useStore((state) => state.hasForms)
  const theme = useStore((state) => state.theme)
  const formMode = useStore((state) => state.formMode)
  const undoCount = useStore((state) => state.undoStack.length)
  const redoCount = useStore((state) => state.redoStack.length)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const currentIndex = Math.max(
    0,
    pages.findIndex((page) => page.id === currentPageId),
  )

  const goTo = (index: number) => {
    const page = pages[Math.max(0, Math.min(pages.length - 1, index))]
    if (!page) return
    useStore.getState().setCurrentPage(page.id)
    useStore.getState().requestScrollTo(page.id)
  }

  const zoomTo = (value: number) => {
    const state = useStore.getState()
    state.setZoom(value)
    const canvas = getCanvas(state.currentPageId)
    canvas?.requestRenderAll()
  }

  return (
    <header className="topbar">
      <div className="brand">
        <FileText size={19} />
        <span>RealPDF</span>
      </div>

      <div className="topbar-group">
        <button type="button" className="button" onClick={() => fileInputRef.current?.click()} disabled={loading}>
          {loading ? <Loader2 size={16} className="spin" /> : <FolderOpen size={16} />} Open PDF
        </button>
        <input
          id="open-pdf-input"
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void openPdfFile(file)
          }}
        />
        {fileName && <span className="file-name" title={fileName}>{fileName}</span>}
        <button
          type="button"
          className="button"
          title="Merge, split and convert documents"
          onClick={() => useStore.getState().setToolsOpen(true)}
        >
          <Wrench size={15} /> Tools
        </button>
        <button
          type="button"
          className="button"
          title="Documents saved in this browser"
          onClick={() => void useStore.getState().openLibrary()}
        >
          <BookOpen size={15} /> Library
        </button>
        {(hasForms || formMode) && (
          <button
            type="button"
            className={`button ${formMode ? 'button-primary' : ''}`}
            title="Fill interactive form fields"
            onClick={() => {
              const state = useStore.getState()
              if (state.formMode) state.exitFormMode()
              else {
                state.setTool('select')
                void state.enterFormMode()
              }
            }}
          >
            <ClipboardList size={15} /> {formMode ? 'Filling forms' : 'Fill forms'}
          </button>
        )}
      </div>

      {pages.length > 0 && (
        <>
          <div className="topbar-group">
            <button
              type="button"
              className="icon-button"
              title="Undo (Ctrl+Z)"
              disabled={!undoCount}
              onClick={() => useStore.getState().undo()}
            >
              <Undo2 size={17} />
            </button>
            <button
              type="button"
              className="icon-button"
              title="Redo (Ctrl+Shift+Z)"
              disabled={!redoCount}
              onClick={() => useStore.getState().redo()}
            >
              <Redo2 size={17} />
            </button>
          </div>

          <div className="topbar-group">
            <button
              type="button"
              className="icon-button"
              title="Previous page"
              disabled={currentIndex <= 0}
              onClick={() => goTo(currentIndex - 1)}
            >
              <ChevronLeft size={17} />
            </button>
            <span className="page-indicator">
              {currentIndex + 1} / {pages.length}
            </span>
            <button
              type="button"
              className="icon-button"
              title="Next page"
              disabled={currentIndex >= pages.length - 1}
              onClick={() => goTo(currentIndex + 1)}
            >
              <ChevronRight size={17} />
            </button>
          </div>

          <div className="topbar-group">
            <button
              type="button"
              className="icon-button"
              title="Zoom out"
              onClick={() => zoomTo(zoom / 1.2)}
            >
              <ZoomOut size={17} />
            </button>
            <button type="button" className="zoom-label" onClick={() => zoomTo(1)} title="Reset zoom">
              {Math.round(zoom * 100)}%
            </button>
            <button type="button" className="icon-button" title="Zoom in" onClick={() => zoomTo(zoom * 1.2)}>
              <ZoomIn size={17} />
            </button>
            <button
              type="button"
              className="icon-button"
              title="Fit page width"
              onClick={() => useStore.getState().requestFit()}
            >
              <Maximize size={17} />
            </button>
          </div>

        </>
      )}

      <div className="topbar-spacer" />

      <button
        type="button"
        className="icon-button"
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-label="Toggle color theme"
        onClick={() => useStore.getState().toggleTheme()}
      >
        {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
      </button>
      <a
        className="button button-kofi"
        href="https://ko-fi.com/shixzie"
        target="_blank"
        rel="noreferrer noopener"
        title="Support RealPDF on Ko-fi"
      >
        <Heart size={15} /> Support
      </a>

      {pages.length > 0 && (
        <button
          type="button"
          className="button button-primary"
          onClick={() => void runExport()}
          disabled={exporting}
        >
          {exporting ? <Loader2 size={16} className="spin" /> : <Download size={16} />} Save PDF
        </button>
      )}
    </header>
  )
}
