import { useEffect, useRef } from 'react'
import {
  FileText,
  FolderOpen,
  Library,
  Send,
} from 'lucide-react'
import { useStore, type PendingAction } from '../store'
import { openDocumentFile } from '../lib/openDocument'
import { useTranslation } from '../i18n'
import { SocialLinks } from './SocialLinks'
import { MyRequestsList } from './RequestSignaturesModal'
import { HomeTools } from './HomeTools'

export function EmptyState() {
  const { t } = useTranslation()
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
      <div className="home">
        <div className="empty-card">
          <div className="empty-logo">
            <FileText size={30} />
          </div>
          <h1>{t('empty.title')}</h1>
          <p>{t('empty.subtitle')}</p>
          <button type="button" className="button button-primary button-lg" onClick={() => pickFile(null)}>
            <FolderOpen size={18} /> {t('empty.choose')}
          </button>
          <span className="empty-hint">{t('empty.dragHint')}</span>
          {loading && (
            <span className="empty-hint">
              {window.location.pathname.startsWith('/sign/') ? t('signRequest.opening') : t('empty.opening')}
            </span>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf,.docx,.xlsx,.pptx"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void openDocumentFile(file)
              else useStore.getState().setPendingAction(null)
            }}
          />
        </div>

        <section className="home-section home-library" aria-labelledby="home-library-title">
          <div className="home-section-head">
            <h2 id="home-library-title">
              <Library size={15} /> {t('library.title')}
            </h2>
            {recent.length > 0 && (
              <button type="button" className="link-button" onClick={() => void useStore.getState().openLibrary()}>
                {t('empty.viewAll')}
              </button>
            )}
          </div>
          {recent.length > 0 ? (
            <div className="home-recent-grid">
              {recent.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="recent-card"
                  onClick={() => void useStore.getState().openLibraryEntry(entry.id)}
                  title={t('empty.restore', { title: entry.title })}
                >
                  {entry.thumbnail ? (
                    <img src={entry.thumbnail} alt="" />
                  ) : (
                    <div className="recent-placeholder">
                      <FileText size={16} />
                    </div>
                  )}
                  <span className="recent-name">{entry.title}</span>
                  <span className="recent-meta">{t('common.pages', { count: entry.pageCount })}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="home-section-empty">{t('library.empty')}</p>
          )}
        </section>

        <section className="home-section home-requests" aria-labelledby="home-requests-title">
          <div className="home-section-head">
            <h2 id="home-requests-title">
              <Send size={15} /> {t('empty.requests')}
            </h2>
          </div>
          <MyRequestsList empty={<p className="home-section-empty">{t('empty.requestsEmpty')}</p>} />
        </section>

        <HomeTools onPickFile={pickFile} />

        <SocialLinks />
      </div>
    </div>
  )
}
