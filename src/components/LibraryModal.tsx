import { useEffect, useState } from 'react'
import { BookOpen, Download, FolderOpen, Loader2, Pencil, Trash2, X } from 'lucide-react'
import { useStore } from '../store'
import { storageEstimate } from '../lib/library'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatWhen(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`
  return new Date(timestamp).toLocaleDateString()
}

export function LibraryModal() {
  const open = useStore((state) => state.libraryOpen)
  const entries = useStore((state) => state.libraryEntries)
  const busy = useStore((state) => state.libraryBusy)
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (!open) return
    setEditingId(null)
    void storageEstimate().then(setUsage)
  }, [open])

  if (!open) return null

  const commitRename = async (id: string) => {
    const value = draft.trim()
    setEditingId(null)
    if (value) await useStore.getState().renameLibraryEntry(id, value)
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-wide">
        <div className="modal-head">
          <h2>Your library</h2>
          <button type="button" className="icon-button" onClick={() => useStore.getState().closeLibrary()} title="Close">
            <X size={17} />
          </button>
        </div>
        <p className="tool-hint">
          Documents you save are kept in this browser only — including their editable state, so you can pick up
          where you left off. Nothing is uploaded.
        </p>

        {busy && entries.length === 0 && (
          <div className="library-empty">
            <Loader2 size={18} className="spin" /> Loading…
          </div>
        )}
        {!busy && entries.length === 0 && (
          <div className="library-empty">
            <BookOpen size={22} />
            <span>No saved documents yet. Use “Save PDF” and it will show up here.</span>
          </div>
        )}

        {entries.length > 0 && (
          <ul className="library-list">
            {entries.map((entry) => (
              <li key={entry.id} className="library-item">
                <div className="library-thumb">
                  {entry.thumbnail ? (
                    <img src={entry.thumbnail} alt="" />
                  ) : (
                    <BookOpen size={18} />
                  )}
                </div>
                <div className="library-info">
                  {editingId === entry.id ? (
                    <input
                      className="library-title-input"
                      value={draft}
                      autoFocus
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={() => void commitRename(entry.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void commitRename(entry.id)
                        if (event.key === 'Escape') setEditingId(null)
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="library-title"
                      title="Rename"
                      onClick={() => {
                        setEditingId(entry.id)
                        setDraft(entry.title)
                      }}
                    >
                      {entry.title} <Pencil size={11} />
                    </button>
                  )}
                  <span className="library-meta">
                    {entry.pageCount} page{entry.pageCount === 1 ? '' : 's'} · {formatBytes(entry.size)} · saved{' '}
                    {formatWhen(entry.savedAt)}
                    {entry.saveCount > 1 ? ` · ${entry.saveCount} saves` : ''}
                  </span>
                </div>
                <div className="library-actions">
                  <button
                    type="button"
                    className="button"
                    onClick={() => void useStore.getState().openLibraryEntry(entry.id)}
                  >
                    <FolderOpen size={14} /> Open
                  </button>
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={() => void useStore.getState().downloadLibraryEntry(entry.id)}
                  >
                    <Download size={14} /> PDF
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    title="Delete"
                    onClick={() => void useStore.getState().deleteLibraryEntry(entry.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="modal-row">
          <span className="tool-hint">
            {usage && usage.quota > 0
              ? `${formatBytes(usage.usage)} used of ${formatBytes(usage.quota)} available to this site`
              : 'Local browser storage'}
          </span>
          <div className="modal-spacer" />
          {entries.length > 0 && (
            <button
              type="button"
              className="button button-ghost"
              onClick={() => {
                if (window.confirm('Delete every saved document from this browser?')) {
                  void useStore.getState().clearLibrary()
                }
              }}
            >
              <Trash2 size={14} /> Clear all
            </button>
          )}
          <button type="button" className="button" onClick={() => useStore.getState().closeLibrary()}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
