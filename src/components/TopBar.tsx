import { useRef } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  BookOpen,
  ClipboardList,
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
import { openDocumentFile } from '../lib/openDocument'
import { getCanvas } from '../lib/canvasRegistry'
import { useTranslation } from '../i18n'
import { LanguagePicker } from './LanguagePicker'
import { ExportControl } from './ExportControl'

export function TopBar() {
  const { t } = useTranslation()
  const fileName = useStore((state) => state.fileName)
  const pages = useStore((state) => state.pages)
  const currentPageId = useStore((state) => state.currentPageId)
  const zoom = useStore((state) => state.zoom)
  const loading = useStore((state) => state.loading)
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
      <button
        type="button"
        className="brand brand-home"
        title={t('topbar.homeTitle')}
        onClick={() => useStore.getState().close()}
      >
        <FileText size={19} />
        <span>RealPDF</span>
      </button>

      <div className="topbar-group">
        <button type="button" className="button" onClick={() => fileInputRef.current?.click()} disabled={loading}>
          {loading ? <Loader2 size={16} className="spin" /> : <FolderOpen size={16} />} {t('topbar.openPdf')}
        </button>
        <input
          id="open-pdf-input"
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf,.docx,.xlsx,.pptx"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void openDocumentFile(file)
          }}
        />
        {fileName && <span className="file-name" title={fileName}>{fileName}</span>}
        <button
          type="button"
          className="button"
          title={t('topbar.toolsTitle')}
          onClick={() => useStore.getState().setToolsOpen(true)}
        >
          <Wrench size={15} /> {t('topbar.tools')}
        </button>
        <button
          type="button"
          className="button"
          title={t('topbar.libraryTitle')}
          onClick={() => void useStore.getState().openLibrary()}
        >
          <BookOpen size={15} /> {t('topbar.library')}
        </button>
        {(hasForms || formMode) && (
          <button
            type="button"
            className={`button ${formMode ? 'button-primary' : ''}`}
            title={t('topbar.fillFormsTitle')}
            onClick={() => {
              const state = useStore.getState()
              if (state.formMode) state.exitFormMode()
              else {
                state.setTool('select')
                void state.enterFormMode()
              }
            }}
          >
            <ClipboardList size={15} /> {formMode ? t('topbar.fillingForms') : t('topbar.fillForms')}
          </button>
        )}
      </div>

      {pages.length > 0 && (
        <>
          <div className="topbar-group">
            <button
              type="button"
              className="icon-button"
              title={t('topbar.undo')}
              disabled={!undoCount}
              onClick={() => useStore.getState().undo()}
            >
              <Undo2 size={17} />
            </button>
            <button
              type="button"
              className="icon-button"
              title={t('topbar.redo')}
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
              title={t('topbar.previousPage')}
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
              title={t('topbar.nextPage')}
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
              title={t('topbar.zoomOut')}
              onClick={() => zoomTo(zoom / 1.2)}
            >
              <ZoomOut size={17} />
            </button>
            <button type="button" className="zoom-label" onClick={() => zoomTo(1)} title={t('topbar.resetZoom')}>
              {Math.round(zoom * 100)}%
            </button>
            <button type="button" className="icon-button" title={t('topbar.zoomIn')} onClick={() => zoomTo(zoom * 1.2)}>
              <ZoomIn size={17} />
            </button>
            <button
              type="button"
              className="icon-button"
              title={t('topbar.fitWidth')}
              onClick={() => useStore.getState().requestFit()}
            >
              <Maximize size={17} />
            </button>
          </div>

        </>
      )}

      <div className="topbar-spacer" />

      <LanguagePicker />

      <button
        type="button"
        className="icon-button"
        title={theme === 'dark' ? t('topbar.switchToLight') : t('topbar.switchToDark')}
        aria-label={t('topbar.toggleTheme')}
        onClick={() => useStore.getState().toggleTheme()}
      >
        {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
      </button>
      <a
        className="button button-kofi"
        href="https://ko-fi.com/shixzie"
        target="_blank"
        rel="noreferrer noopener"
        title={t('topbar.supportTitle')}
      >
        <Heart size={15} /> {t('topbar.support')}
      </a>

      {pages.length > 0 && <ExportControl />}
    </header>
  )
}
