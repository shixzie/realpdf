import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  ChevronDown,
  Download,
  FileImage,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  LetterText,
  Loader2,
  Presentation,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { useStore } from '../store'
import { runExport } from '../lib/exportController'
import { quickExport, type ExportFormatId, type ExportScope } from '../lib/quickExport'
import { useTranslation } from '../i18n'

interface MenuEntry {
  id: ExportFormatId
  labelKey: string
  hintKey: string
  icon: LucideIcon
  scope?: ExportScope
  scale?: number
}

const IMAGE_ENTRIES: MenuEntry[] = [
  { id: 'png', labelKey: 'export.pngPage', hintKey: 'export.pngPageHint', icon: FileImage },
  { id: 'jpg', labelKey: 'export.jpgPage', hintKey: 'export.jpgPageHint', icon: ImageIcon },
  { id: 'png', labelKey: 'export.pngAll', hintKey: 'export.pngAllHint', icon: Archive, scope: 'all' },
]

const TEXT_ENTRY: MenuEntry = {
  id: 'txt',
  labelKey: 'export.txt',
  hintKey: 'export.txtHint',
  icon: LetterText,
}

const OFFICE_ENTRIES: MenuEntry[] = [
  { id: 'docx', labelKey: 'export.docx', hintKey: 'export.docxHint', icon: FileText },
  { id: 'xlsx', labelKey: 'export.xlsx', hintKey: 'export.xlsxHint', icon: FileSpreadsheet },
  { id: 'pptx', labelKey: 'export.pptx', hintKey: 'export.pptxHint', icon: Presentation },
]

function useMenuDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])
  return ref
}

function MenuSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="export-menu-section">
      <span className="export-menu-heading">{title}</span>
      {children}
    </div>
  )
}

function ExportMenu({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const exporting = useStore((state) => state.exporting)
  const [busy, setBusy] = useState<string | null>(null)

  const savePdf = () => {
    onClose()
    void runExport()
  }

  const runQuick = async (entry: MenuEntry) => {
    if (busy || exporting) return
    setBusy(entry.labelKey)
    try {
      await quickExport(entry.id, { scope: entry.scope ?? 'current', scale: entry.scale ?? 2 })
    } finally {
      setBusy(null)
      onClose()
    }
  }

  const item = (entry: MenuEntry) => {
    const Icon = entry.icon
    const running = busy === entry.labelKey
    return (
      <button
        key={entry.labelKey}
        type="button"
        role="menuitem"
        className="export-menu-item"
        disabled={Boolean(busy) || exporting}
        onClick={() => void runQuick(entry)}
      >
        <span className="export-menu-icon">
          {running ? <Loader2 size={16} className="spin" /> : <Icon size={16} />}
        </span>
        <span className="export-menu-text">
          <span className="export-menu-label">{t(entry.labelKey)}</span>
          <span className="export-menu-hint">{t(entry.hintKey)}</span>
        </span>
      </button>
    )
  }

  return (
    <div className="export-menu" role="menu">
      <button
        type="button"
        role="menuitem"
        className="export-menu-item export-menu-item-pdf"
        disabled={exporting || Boolean(busy)}
        onClick={savePdf}
      >
        <span className="export-menu-icon">
          {exporting ? <Loader2 size={16} className="spin" /> : <Download size={16} />}
        </span>
        <span className="export-menu-text">
          <span className="export-menu-label">{t('export.saveAsPdf')}</span>
          <span className="export-menu-hint">{t('export.saveAsPdfHint')}</span>
        </span>
      </button>
      <MenuSection title={t('export.images')}>{IMAGE_ENTRIES.map((entry) => item(entry))}</MenuSection>
      <MenuSection title={t('export.text')}>{item(TEXT_ENTRY)}</MenuSection>
      <MenuSection title={t('export.office')}>{OFFICE_ENTRIES.map((entry) => item(entry))}</MenuSection>
      <div className="export-menu-separator" />
      <button
        type="button"
        role="menuitem"
        className="export-menu-item export-menu-tools"
        onClick={() => {
          onClose()
          useStore.getState().setToolsOpen(true, 'convert')
        }}
      >
        <span className="export-menu-icon">
          <Wrench size={16} />
        </span>
        <span className="export-menu-text">
          <span className="export-menu-label">{t('export.allTools')}</span>
        </span>
      </button>
    </div>
  )
}

/**
 * Save/export control: the primary row saves the edited PDF (and records it in
 * the local library), the rest of the menu downloads other formats directly.
 */
export function ExportControl() {
  const { t } = useTranslation()
  const exporting = useStore((state) => state.exporting)
  const [open, setOpen] = useState(false)
  const ref = useMenuDismiss(open, () => setOpen(false))
  return (
    <div className="export-wrap" ref={ref}>
      <button
        type="button"
        className="button button-primary export-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={exporting}
        onClick={() => setOpen((value) => !value)}
      >
        {exporting ? <Loader2 size={16} className="spin" /> : <Download size={16} />} {t('export.trigger')}{' '}
        <ChevronDown size={14} />
      </button>
      {open && <ExportMenu onClose={() => setOpen(false)} />}
    </div>
  )
}
