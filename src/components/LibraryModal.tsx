import { useEffect, useState } from 'react'
import { BookOpen, Download, FolderOpen, Loader2, Pencil, Trash2, X } from 'lucide-react'
import { useStore } from '../store'
import { storageEstimate } from '../lib/library'
import { formatBytes, formatDate, t, useTranslation } from '../i18n'

function formatWhen(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return t('library.justNow')
  if (diff < 3_600_000) return t('library.minutesAgo', { count: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('library.hoursAgo', { count: Math.floor(diff / 3_600_000) })
  return formatDate(timestamp)
}

export function LibraryModal() {
  const { t } = useTranslation()
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
          <h2>{t('library.title')}</h2>
          <button
            type="button"
            className="icon-button"
            onClick={() => useStore.getState().closeLibrary()}
            title={t('common.close')}
          >
            <X size={17} />
          </button>
        </div>
        <p className="tool-hint">{t('library.intro')}</p>

        {busy && entries.length === 0 && (
          <div className="library-empty">
            <Loader2 size={18} className="spin" /> {t('common.loading')}
          </div>
        )}
        {!busy && entries.length === 0 && (
          <div className="library-empty">
            <BookOpen size={22} />
            <span>{t('library.empty')}</span>
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
                      title={t('common.rename')}
                      onClick={() => {
                        setEditingId(entry.id)
                        setDraft(entry.title)
                      }}
                    >
                      {entry.title} <Pencil size={11} />
                    </button>
                  )}
                  <span className="library-meta">
                    {t('common.pages', { count: entry.pageCount })} · {formatBytes(entry.size)} ·{' '}
                    {t('library.saved', { when: formatWhen(entry.savedAt) })}
                    {entry.saveCount > 1 ? ` · ${t('library.saves', { count: entry.saveCount })}` : ''}
                  </span>
                </div>
                <div className="library-actions">
                  <button
                    type="button"
                    className="button"
                    onClick={() => void useStore.getState().openLibraryEntry(entry.id)}
                  >
                    <FolderOpen size={14} /> {t('common.open')}
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
                    title={t('common.delete')}
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
              ? t('library.usage', { used: formatBytes(usage.usage), quota: formatBytes(usage.quota) })
              : t('library.storage')}
          </span>
          <div className="modal-spacer" />
          {entries.length > 0 && (
            <button
              type="button"
              className="button button-ghost"
              onClick={() => {
                if (window.confirm(t('library.clearConfirm'))) {
                  void useStore.getState().clearLibrary()
                }
              }}
            >
              <Trash2 size={14} /> {t('library.clearAll')}
            </button>
          )}
          <button type="button" className="button" onClick={() => useStore.getState().closeLibrary()}>
            {t('common.done')}
          </button>
        </div>
      </div>
    </div>
  )
}
