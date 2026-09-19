import { useEffect } from 'react'
import { useStore } from './store'
import { TopBar } from './components/TopBar'
import { ToolRail } from './components/ToolRail'
import { ToolOptions } from './components/ToolOptions'
import { Viewer } from './components/Viewer'
import { PageSidebar } from './components/PageSidebar'
import { SignatureModal } from './components/SignatureModal'
import { FileToolsModal } from './components/FileToolsModal'
import { LibraryModal } from './components/LibraryModal'
import { FormsBar } from './components/FormsBar'
import { EmptyState } from './components/EmptyState'
import { ExportOverlay, Toast } from './components/Overlays'
import { isSupportedFileName, openDocumentFile } from './lib/openDocument'
import { runExport } from './lib/exportController'
import { activeCanvas, deleteSelection } from './lib/canvasRegistry'
import type { Tool } from './types'

const TOOL_SHORTCUTS: Record<string, Tool> = {
  v: 'select',
  t: 'text',
  x: 'textedit',
  p: 'pen',
  h: 'highlighter',
  r: 'rect',
  o: 'ellipse',
  l: 'line',
  a: 'arrow',
  w: 'whiteout',
  e: 'eraser',
  s: 'signature',
}

export default function App() {
  const hasDocument = useStore((state) => state.pages.length > 0)
  const formMode = useStore((state) => state.formMode)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }
      const state = useStore.getState()
      if (!state.pages.length) return

      const canvas = activeCanvas()
      const editing = canvas?.getActiveObject() as { isEditing?: boolean } | undefined
      if (editing?.isEditing) return

      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()

      if (mod && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) state.redo()
        else state.undo()
        return
      }
      if (mod && key === 'y') {
        event.preventDefault()
        state.redo()
        return
      }
      if (mod && key === 's') {
        event.preventDefault()
        void runExport()
        return
      }
      if (mod && key === 'o') {
        event.preventDefault()
        document.getElementById('open-pdf-input')?.click()
        return
      }
      if (mod) return

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (canvas) {
          event.preventDefault()
          deleteSelection(canvas)
        }
        return
      }
      if (event.key === 'Escape') {
        if (canvas) {
          canvas.discardActiveObject()
          canvas.requestRenderAll()
        }
        state.setTool('select')
        return
      }
      if (event.key === '+' || event.key === '=') {
        state.zoomBy(1.2)
        return
      }
      if (event.key === '-' || event.key === '_') {
        state.zoomBy(1 / 1.2)
        return
      }
      if (key === 'i') {
        state.setTool('image')
        state.requestImagePick()
        return
      }
      const tool = TOOL_SHORTCUTS[key]
      if (tool) {
        state.setTool(tool)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) event.preventDefault()
    }
    const onDrop = (event: DragEvent) => {
      const files = Array.from(event.dataTransfer?.files ?? [])
      const document = files.find((file) => isSupportedFileName(file.name) || file.type === 'application/pdf')
      if (!document) return
      if ((event.target as HTMLElement)?.closest('.page')) return
      event.preventDefault()
      void openDocumentFile(document)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  return (
    <div className="app">
      <TopBar />
      {hasDocument ? (
        <div className={`workspace ${formMode ? 'is-form-mode' : ''}`}>
          <ToolRail />
          <div className="main">
            {formMode ? <FormsBar /> : <ToolOptions />}
            <Viewer />
          </div>
          <PageSidebar />
        </div>
      ) : (
        <EmptyState />
      )}
      <SignatureModal />
      <FileToolsModal />
      <LibraryModal />
      <ExportOverlay />
      <Toast />
    </div>
  )
}
