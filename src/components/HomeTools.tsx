import { useState, type CSSProperties } from 'react'
import {
  ArrowUpRight,
  Bookmark,
  ClipboardList,
  Combine,
  Columns3,
  Crop,
  FileDown,
  FileText,
  FileType2,
  Image,
  LockKeyhole,
  LockKeyholeOpen,
  Layers,
  ListOrdered,
  Globe,
  FilePlus2,
  Eraser,
  PenLine,
  RotateCw,
  ScanText,
  Search,
  Scissors,
  Settings2,
  Shrink,
  Stamp,
  Wrench,
} from 'lucide-react'
import { useStore, type PendingAction, type ToolsTab } from '../store'
import { DOCUMENT_TOOLS, EXTRA_TOOLS, type AdvancedToolId, type DocumentToolId, type ExtraToolId, type ToolCategory } from '../lib/documentToolCatalog'
import { useTranslation } from '../i18n'
import { useActiveIndicator } from '../lib/useActiveIndicator'

type HomeToolAction =
  | { kind: 'file'; pending: PendingAction | null }
  | { kind: 'tab'; tab: ToolsTab }
  | { kind: 'tool'; tool: AdvancedToolId }

interface HomeTool {
  id: string
  category: ToolCategory
  titleKey: string
  descriptionKey: string
  icon: typeof Combine
  action: HomeToolAction
  featured?: boolean
}

const BASE_TOOLS: HomeTool[] = [
  { id: 'merge', category: 'pages', titleKey: 'empty.mergeTitle', descriptionKey: 'empty.mergeText', icon: Combine, action: { kind: 'tab', tab: 'merge' } },
  { id: 'split', category: 'pages', titleKey: 'empty.splitTitle', descriptionKey: 'empty.splitText', icon: Scissors, action: { kind: 'file', pending: 'split' } },
  { id: 'annotate', category: 'edit', titleKey: 'empty.annotateTitle', descriptionKey: 'empty.annotateText', icon: PenLine, action: { kind: 'file', pending: null } },
  { id: 'convert', category: 'convert', titleKey: 'empty.convertTitle', descriptionKey: 'empty.convertText', icon: FileDown, action: { kind: 'tab', tab: 'convert' } },
  { id: 'office', category: 'convert', titleKey: 'empty.officeTitle', descriptionKey: 'empty.officeText', icon: FileType2, action: { kind: 'tab', tab: 'office' } },
  { id: 'forms', category: 'forms', titleKey: 'empty.formsTitle', descriptionKey: 'empty.formsText', icon: ClipboardList, action: { kind: 'file', pending: 'forms' } },
]

const DOCUMENT_ICONS: Record<DocumentToolId, typeof Combine> = {
  compress: Shrink,
  watermark: Stamp,
  numbers: ListOrdered,
  rotate: RotateCw,
  protect: LockKeyhole,
  unlock: LockKeyholeOpen,
  extractImages: Image,
  overlay: Layers,
  compare: FileText,
  ocr: ScanText,
  optimize: Settings2,
  repair: Wrench,
  redact: Eraser,
  rasterize: Image,
  flatten: FileText,
  html: Globe,
  create: FilePlus2,
}

const EXTRA_ICONS: Record<ExtraToolId, typeof Combine> = {
  crop: Crop,
  pageSize: FileText,
  metadata: FileText,
  removeMetadata: FileText,
  sheet: Columns3,
  halve: Scissors,
  bookmarks: Bookmark,
  search: Search,
  preferences: Settings2,
  fields: ClipboardList,
}

const TOOLS: HomeTool[] = [
  ...BASE_TOOLS.slice(0, 2),
  {
    id: 'compress',
    category: 'optimize',
    titleKey: 'advanced.compress',
    descriptionKey: 'advanced.compressHint',
    icon: Shrink,
    action: { kind: 'tool', tool: 'compress' },
    featured: true,
  },
  ...BASE_TOOLS.slice(2),
  ...DOCUMENT_TOOLS.filter((tool) => tool.id !== 'compress').map((tool) => ({
    id: tool.id,
    category: tool.category,
    titleKey: `advanced.${tool.id}`,
    descriptionKey: `advanced.${tool.id}Hint`,
    icon: DOCUMENT_ICONS[tool.id],
    action: { kind: 'tool' as const, tool: tool.id },
  })),
  ...EXTRA_TOOLS.map((tool) => ({
    id: tool.id,
    category: tool.category,
    titleKey: tool.titleKey,
    descriptionKey: tool.hintKey,
    icon: EXTRA_ICONS[tool.id],
    action: { kind: 'tool' as const, tool: tool.id },
  })),
]

const CATEGORIES: ToolCategory[] = ['edit', 'pages', 'convert', 'security', 'forms', 'optimize']

export function HomeTools({ onPickFile }: { onPickFile: (pending: PendingAction | null) => void }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<ToolCategory | null>(null)
  const filtersRef = useActiveIndicator<HTMLDivElement>(category)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleTools = TOOLS.filter((tool) => {
    if (category && tool.category !== category) return false
    if (!normalizedQuery) return true
    return `${t(tool.titleKey)} ${t(tool.descriptionKey)}`.toLocaleLowerCase().includes(normalizedQuery)
  })

  const pick = (tool: HomeTool) => {
    if (tool.action.kind === 'file') {
      onPickFile(tool.action.pending)
      return
    }
    const state = useStore.getState()
    state.setPendingAction(null)
    state.setToolsOpen(true, tool.action.kind === 'tab' ? tool.action.tab : 'more', tool.action.kind === 'tool' ? tool.action.tool : undefined)
  }

  return (
    <section className="home-section home-tools-section home-tool-catalog" aria-labelledby="home-tools-title">
      <div className="home-tools-heading">
        <div>
          <h2 id="home-tools-title">{t('homeTools.title')}</h2>
          <p>{t('homeTools.subtitle')}</p>
        </div>
        <span className="home-tools-count">{t('homeTools.count', { count: TOOLS.length })}</span>
      </div>
      <div className="home-tools-toolbar">
        <div className="home-tool-filters" role="group" aria-label={t('homeTools.categories')} ref={filtersRef}>
          <span className="active-indicator" aria-hidden="true" />
          <button type="button" className={`home-tool-filter ${category === null ? 'is-active' : ''}`} aria-pressed={category === null} onClick={() => setCategory(null)}>{t('homeTools.category.all')}</button>
          {CATEGORIES.map((item) => (
            <button key={item} type="button" className={`home-tool-filter ${category === item ? 'is-active' : ''}`} aria-pressed={category === item} onClick={() => setCategory(item)}>{t(`homeTools.category.${item}`)}</button>
          ))}
        </div>
        <label className="home-tool-search">
          <Search size={16} aria-hidden="true" />
          <input type="search" aria-label={t('homeTools.search')} placeholder={t('homeTools.search')} value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>
      {visibleTools.length ? (
        <div className="home-tools">
          {visibleTools.map((tool, index) => {
            const Icon = tool.icon
            return (
              <button key={`${category ?? 'all'}-${tool.id}`} type="button" className={`home-tool${tool.featured ? ' home-tool-featured' : ''}`} data-home-tool={tool.id} style={{ '--tool-delay': `${Math.min(index, 6) * 28}ms` } as CSSProperties} onClick={() => pick(tool)}>
                <span className="home-tool-icon" aria-hidden="true"><Icon size={18} /></span>
                <span className="home-tool-copy"><strong>{t(tool.titleKey)}</strong><span>{t(tool.descriptionKey)}</span></span>
                <ArrowUpRight className="home-tool-arrow" size={16} aria-hidden="true" />
              </button>
            )
          })}
        </div>
      ) : (
        <div className="home-tools-empty">
          <p>{t('homeTools.noResults')}</p>
          <span>{t('homeTools.tryAnother')}</span>
          <button type="button" className="button" onClick={() => { setQuery(''); setCategory(null) }}>{t('homeTools.clearSearch')}</button>
        </div>
      )}
      <div className="home-tools-status" role="status">{t('homeTools.showing', { count: visibleTools.length, total: TOOLS.length })}</div>
    </section>
  )
}
