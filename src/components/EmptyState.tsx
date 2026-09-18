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
import { useTranslation } from '../i18n'

const TOOL_CARDS: Array<{
  action: PendingAction | { tab: ToolsTab }
  icon: typeof Combine
  titleKey: string
  textKey: string
}> = [
  {
    action: { tab: 'merge' },
    icon: Combine,
    titleKey: 'empty.mergeTitle',
    textKey: 'empty.mergeText',
  },
  {
    action: 'split',
    icon: Scissors,
    titleKey: 'empty.splitTitle',
    textKey: 'empty.splitText',
  },
  {
    action: { tab: 'convert' },
    icon: FileDown,
    titleKey: 'empty.convertTitle',
    textKey: 'empty.convertText',
  },
  {
    action: 'forms',
    icon: ClipboardList,
    titleKey: 'empty.formsTitle',
    textKey: 'empty.formsText',
  },
]

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
        {loading && <span className="empty-hint">{t('empty.opening')}</span>}
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
              <History size={13} /> {t('empty.recent')}
            </span>
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
          </div>
        )}

        <div className="home-tools">
          {TOOL_CARDS.map((card) => {
            const Icon = card.icon
            return (
              <button
                key={card.titleKey}
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
                <strong>{t(card.titleKey)}</strong>
                <span>{t(card.textKey)}</span>
              </button>
            )
          })}
          <button type="button" className="home-tool home-tool-accent" onClick={() => pickFile(null)}>
            <PenLine size={18} />
            <strong>{t('empty.annotateTitle')}</strong>
            <span>{t('empty.annotateText')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
