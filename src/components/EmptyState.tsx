import { useEffect, useRef } from 'react'
import {
  ClipboardList,
  Combine,
  FileDown,
  FileText,
  FolderOpen,
  History,
  PenLine,
  Scissors,
} from 'lucide-react'
import { useStore, type PendingAction, type ToolsTab } from '../store'
import { openPdfFile } from '../lib/openDocument'

const TOOL_CARDS: Array<{
  action: PendingAction | { tab: ToolsTab }
  icon: typeof Combine
  title: string
  text: string
}> = [
  {
    action: { tab: 'merge' },
    icon: Combine,
    title: 'Merge PDFs',
    text: 'Combine files into one document, in the order you choose.',
  },
  {
    action: 'split',
    icon: Scissors,
    title: 'Split PDF',
    text: 'Extract page ranges or split every page apart.',
  },
  {
    action: { tab: 'convert' },
    icon: FileDown,
    title: 'Convert',
    text: 'PDF to images or text, images and text to PDF.',
  },
  {
    action: 'forms',
    icon: ClipboardList,
    title: 'Fill a form',
    text: 'Type into interactive fields and save them in.',
  },
]

export function EmptyState() {
  const inputRef = useRef<HTMLInputElement>(null)
  const loading = useStore((state) => state.loading)
  const recent = useStore((state) => state.libraryEntries).slice(0, 4)

  useEffect(() => {
    void useStore.getState().refreshLibrary()
  }, [])

  const pickFile = (pending: PendingAction | null) => {
    useStore.getState().setPendingAction(pending)
    inputRef.current?.click()
  }

  return (
    <div className="empty">
      <div className="empty-card">
        <div className="empty-logo">
          <FileText size={30} />
        </div>
        <h1>Edit PDFs without uploading them</h1>
        <p>
          RealPDF runs entirely in your browser. Your document never leaves your device — annotate it, fill forms,
          merge, split and convert files, then download the result.
        </p>
        <button type="button" className="button button-primary button-lg" onClick={() => pickFile(null)}>
          <FolderOpen size={18} /> Choose a PDF
        </button>
        <span className="empty-hint">or drag &amp; drop a PDF anywhere</span>
        {loading && <span className="empty-hint">Opening document…</span>}
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void openPdfFile(file)
            else useStore.getState().setPendingAction(null)
          }}
        />

        {recent.length > 0 && (
          <div className="home-recent">
            <span className="home-recent-title">
              <History size={13} /> Recent work
            </span>
            <div className="home-recent-grid">
              {recent.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="recent-card"
                  onClick={() => void useStore.getState().openLibraryEntry(entry.id)}
                  title={`Restore ${entry.title}`}
                >
                  {entry.thumbnail ? (
                    <img src={entry.thumbnail} alt="" />
                  ) : (
                    <div className="recent-placeholder">
                      <FileText size={16} />
                    </div>
                  )}
                  <span className="recent-name">{entry.title}</span>
                  <span className="recent-meta">
                    {entry.pageCount} page{entry.pageCount === 1 ? '' : 's'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="home-tools">
          {TOOL_CARDS.map((card) => {
            const Icon = card.icon
            return (
              <button
                key={card.title}
                type="button"
                className="home-tool"
                onClick={() => {
                  if (typeof card.action === 'string') {
                    pickFile(card.action)
                  } else {
                    const state = useStore.getState()
                    state.setPendingAction(null)
                    state.setToolsOpen(true, card.action.tab)
                  }
                }}
              >
                <Icon size={18} />
                <strong>{card.title}</strong>
                <span>{card.text}</span>
              </button>
            )
          })}
          <button type="button" className="home-tool home-tool-accent" onClick={() => pickFile(null)}>
            <PenLine size={18} />
            <strong>Annotate &amp; sign</strong>
            <span>Draw, highlight, add text, images and signatures.</span>
          </button>
        </div>
      </div>
    </div>
  )
}
