import { useMemo, useRef, useState, type ChangeEvent } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Combine,
  FileDown,
  FileText,
  FileUp,
  Image as ImageIcon,
  Loader2,
  Scissors,
  Trash2,
  X,
} from 'lucide-react'
import { useStore, type ToolsTab } from '../store'
import { openPdfBytes } from '../lib/openDocument'
import { downloadBlob } from '../lib/exportController'
import {
  extractPages,
  imagesToPdf,
  mergePdfs,
  parsePageRanges,
  pdfToText,
  renderPdfPageToBlob,
  renderPdfToImages,
  textToPdf,
  type ImagePageSize,
  type ImageSource,
  type MergeSource,
} from '../lib/pdfOps'
import { createZip } from '../lib/zip'
import { imageFileToDataUrl } from '../lib/assets'
import { bakedCurrentBytes } from '../lib/currentDocument'
import { openPdfDocumentFromBytes } from '../lib/pdfjs'
import { formatBytes, t as translate, useTranslation } from '../i18n'

interface DraftSource {
  id: string
  name: string
  bytes: Uint8Array | null
  current?: boolean
}

const TABS: Array<{ id: ToolsTab; labelKey: string; icon: typeof Combine }> = [
  { id: 'merge', labelKey: 'fileTools.tabMerge', icon: Combine },
  { id: 'split', labelKey: 'fileTools.tabSplit', icon: Scissors },
  { id: 'convert', labelKey: 'fileTools.tabConvert', icon: FileDown },
]

function baseName(name: string | null): string {
  return (name ?? 'document.pdf').replace(/\.pdf$/i, '')
}

async function readFiles(files: FileList | File[]): Promise<DraftSource[]> {
  const list = Array.from(files)
  const out: DraftSource[] = []
  for (const file of list) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    out.push({ id: crypto.randomUUID(), name: file.name, bytes })
  }
  return out
}

export function FileToolsModal() {
  const open = useStore((state) => state.toolsOpen)
  if (!open) return null
  return <Modal />
}

function Modal() {
  const { t } = useTranslation()
  const tab = useStore((state) => state.toolsTab)
  const setToolsTab = useStore((state) => state.setToolsTab)
  const close = () => useStore.getState().setToolsOpen(false)
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-wide">
        <div className="modal-head">
          <h2>{t('fileTools.title')}</h2>
          <button type="button" className="icon-button" onClick={close} title={t('common.close')}>
            <X size={17} />
          </button>
        </div>
        <div className="tabs">
          {TABS.map((entry) => {
            const Icon = entry.icon
            return (
              <button
                key={entry.id}
                type="button"
                className={`tab ${tab === entry.id ? 'is-active' : ''}`}
                onClick={() => setToolsTab(entry.id)}
              >
                <Icon size={15} /> {t(entry.labelKey)}
              </button>
            )
          })}
        </div>
        <div className="tools-body">
          {tab === 'merge' && <MergeTab />}
          {tab === 'split' && <SplitTab />}
          {tab === 'convert' && <ConvertTab />}
        </div>
      </div>
    </div>
  )
}

function useBusy() {
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (label: string, action: () => Promise<void>) => {
    if (busy) return
    setBusy(label)
    try {
      await action()
    } finally {
      setBusy(null)
    }
  }
  return { busy, run }
}

const confirmReplace = (): boolean => {
  const state = useStore.getState()
  const hasEdits = state.pages.some((page) => page.annotations.objects.length > 0)
  if (!hasEdits) return true
  return window.confirm(translate('fileTools.replaceConfirm'))
}

function MergeTab() {
  const { t } = useTranslation()
  const fileName = useStore((state) => state.fileName)
  const { busy, run } = useBusy()
  const inputRef = useRef<HTMLInputElement>(null)
  const [sources, setSources] = useState<DraftSource[]>([])
  const [includeCurrent, setIncludeCurrent] = useState(true)

  const move = (index: number, delta: number) => {
    setSources((current) => {
      const next = [...current]
      const target = index + delta
      if (target < 0 || target >= next.length) return current
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      return next
    })
  }

  const resolveSources = async (): Promise<MergeSource[]> => {
    const out: MergeSource[] = []
    for (const source of sources) {
      if (!source.bytes) continue
      out.push({ name: source.name, bytes: source.bytes })
    }
    if (includeCurrent && fileName) {
      const baked = await bakedCurrentBytes()
      out.unshift({ name: `${baseName(fileName)} (edited)`, bytes: baked })
    }
    return out
  }

  const total = sources.length + (includeCurrent && fileName ? 1 : 0)

  return (
    <div className="tool-section">
      <p className="tool-hint">{t('fileTools.mergeHint')}</p>
      <div className="tool-row">
        <button type="button" className="button" onClick={() => inputRef.current?.click()}>
          <FileUp size={15} /> {t('fileTools.addPdfs')}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          onChange={async (event: ChangeEvent<HTMLInputElement>) => {
            const files = event.target.files ? Array.from(event.target.files) : []
            event.target.value = ''
            if (!files.length) return
            const drafts = await readFiles(files)
            setSources((current) => [...current, ...drafts])
          }}
        />
        {fileName && (
            <label className="check">
            <input
              type="checkbox"
              checked={includeCurrent}
              onChange={(event) => setIncludeCurrent(event.target.checked)}
            />
            {t('fileTools.includeCurrent')}
          </label>
        )}
      </div>

      {total === 0 && <p className="tool-empty">{t('fileTools.none')}</p>}
      <ul className="source-list">
        {includeCurrent && fileName && (
          <li className="source-item is-current">
            <span className="source-name">{t('fileTools.current', { fileName })}</span>
          </li>
        )}
        {sources.map((source, index) => (
          <li key={source.id} className="source-item">
            <span className="source-name">{source.name}</span>
            <span className="source-size">{source.bytes ? formatBytes(source.bytes.length) : ''}</span>
            <button type="button" className="icon-button" onClick={() => move(index, -1)} disabled={index === 0}>
              <ArrowUp size={14} />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => move(index, 1)}
              disabled={index === sources.length - 1}
            >
              <ArrowDown size={14} />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => setSources((current) => current.filter((entry) => entry.id !== source.id))}
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>

      <div className="tool-actions">
        <button
          type="button"
          className="button"
          disabled={Boolean(busy) || total < 2}
          onClick={() =>
            void run('merge', async () => {
              const merged = await mergePdfs(await resolveSources())
              downloadBlob(new Blob([merged as BlobPart], { type: 'application/pdf' }), 'merged.pdf')
              useStore.getState().toastMessage('success', t('fileTools.merged'))
            })
          }
        >
          {busy === 'merge' ? <Loader2 size={15} className="spin" /> : <FileDown size={15} />}{' '}
          {t('fileTools.mergeDownload')}
        </button>
        <button
          type="button"
          className="button button-primary"
          disabled={Boolean(busy) || total < 2}
          onClick={() =>
            void run('open', async () => {
              const merged = await mergePdfs(await resolveSources())
              if (!confirmReplace()) return
              await openPdfBytes(merged, 'merged.pdf')
              useStore.getState().setToolsOpen(false)
            })
          }
        >
          {busy === 'open' ? <Loader2 size={15} className="spin" /> : <Combine size={15} />}{' '}
          {t('fileTools.mergeOpen')}
        </button>
      </div>
    </div>
  )
}

function SplitTab() {
  const { t } = useTranslation()
  const fileName = useStore((state) => state.fileName)
  const pageCount = useStore((state) => state.pages.length)
  const { busy, run } = useBusy()
  const [range, setRange] = useState('')

  const parsed = useMemo(() => {
    try {
      return { indices: parsePageRanges(range || 'all', pageCount), error: null as string | null }
    } catch (error) {
      return { indices: [] as number[], error: (error as Error).message }
    }
  }, [range, pageCount])

  const extract = async (): Promise<Uint8Array> => {
    // Bake edits so the extracted pages keep annotations and form values.
    const baked = await bakedCurrentBytes()
    return extractPages(baked, parsed.indices)
  }

  return (
    <div className="tool-section">
      <p className="tool-hint">
        {t('fileTools.splitHint', { pages: t('common.pages', { count: pageCount }) })}
      </p>
      <div className="tool-row">
        <input
          className="text-input"
          placeholder={t('fileTools.rangePlaceholder')}
          value={range}
          onChange={(event) => setRange(event.target.value)}
        />
        <button type="button" className="button button-ghost" onClick={() => setRange('all')}>
          {t('fileTools.allPages')}
        </button>
      </div>
      {parsed.error && <p className="tool-error">{parsed.error}</p>}
      <p className="tool-hint">{t('fileTools.selected', { count: parsed.indices.length })}</p>
      <div className="tool-actions">
        <button
          type="button"
          className="button"
          disabled={Boolean(busy) || !pageCount || !parsed.indices.length}
          onClick={() =>
            void run('extract-download', async () => {
              const bytes = await extract()
              downloadBlob(
                new Blob([bytes as BlobPart], { type: 'application/pdf' }),
                `${baseName(fileName)}-pages.pdf`,
              )
              useStore.getState().toastMessage('success', t('fileTools.extracted'))
            })
          }
        >
          {busy === 'extract-download' ? <Loader2 size={15} className="spin" /> : <FileDown size={15} />}{' '}
          {t('fileTools.download')}
        </button>
        <button
          type="button"
          className="button button-primary"
          disabled={Boolean(busy) || !pageCount || !parsed.indices.length}
          onClick={() =>
            void run('extract-open', async () => {
              if (!confirmReplace()) return
              const bytes = await extract()
              await openPdfBytes(bytes, `${baseName(fileName)}-pages.pdf`)
              useStore.getState().setToolsOpen(false)
            })
          }
        >
          {busy === 'extract-open' ? <Loader2 size={15} className="spin" /> : <Scissors size={15} />}{' '}
          {t('fileTools.extractOpen')}
        </button>
        <button
          type="button"
          className="button"
          disabled={Boolean(busy) || !pageCount}
          onClick={() =>
            void run('split-zip', async () => {
              const baked = await bakedCurrentBytes()
              const entries: Array<{ name: string; data: Uint8Array }> = []
              const width = String(pageCount).length
              for (let index = 0; index < pageCount; index += 1) {
                const single = await extractPages(baked, [index])
                entries.push({ name: `page-${String(index + 1).padStart(width, '0')}.pdf`, data: single })
              }
              const zip = await createZip(entries)
              downloadBlob(zip, `${baseName(fileName)}-split.zip`)
              useStore.getState().toastMessage('success', t('fileTools.splitDone'))
            })
          }
        >
          {busy === 'split-zip' ? <Loader2 size={15} className="spin" /> : <FileDown size={15} />}{' '}
          {t('fileTools.splitZip')}
        </button>
      </div>
      <p className="tool-note">{t('fileTools.splitTip')}</p>
    </div>
  )
}

function ConvertTab() {
  const { t } = useTranslation()
  const fileName = useStore((state) => state.fileName)
  const pdf = useStore((state) => state.pdf)
  const pageCount = useStore((state) => state.pages.length)
  const currentPageId = useStore((state) => state.currentPageId)
  const pages = useStore((state) => state.pages)
  const { busy, run } = useBusy()
  const [format, setFormat] = useState<'png' | 'jpeg'>('png')
  const [scale, setScale] = useState(2)
  const [imageSources, setImageSources] = useState<ImageSource[]>([])
  const [imagePageSize, setImagePageSize] = useState<ImagePageSize>('a4')
  const [text, setText] = useState('')
  const imageInputRef = useRef<HTMLInputElement>(null)

  const currentIndex = Math.max(
    0,
    pages.findIndex((page) => page.id === currentPageId),
  )

  return (
    <div className="tool-section">
      <section className="tool-block">
        <h3>
          <ImageIcon size={15} /> {t('fileTools.pdfToImages')}
        </h3>
        <div className="tool-row">
          <select className="select" value={format} onChange={(event) => setFormat(event.target.value as 'png' | 'jpeg')}>
            <option value="png">PNG</option>
            <option value="jpeg">JPEG</option>
          </select>
          <select className="select" value={scale} onChange={(event) => setScale(Number(event.target.value))}>
            <option value={1}>72 dpi (1x)</option>
            <option value={2}>144 dpi (2x)</option>
            <option value={3}>216 dpi (3x)</option>
          </select>
          <button
            type="button"
            className="button"
            disabled={Boolean(busy) || !pdf || !pageCount}
            onClick={() =>
              void run('img-current', async () => {
                const scratch = await openPdfDocumentFromBytes(await bakedCurrentBytes())
                try {
                  const blob = await renderPdfPageToBlob(scratch, currentIndex, scale, format)
                  downloadBlob(
                    blob,
                    `${baseName(fileName)}-page-${currentIndex + 1}.${format === 'jpeg' ? 'jpg' : 'png'}`,
                  )
                } finally {
                  void scratch.loadingTask.destroy()
                }
              })
            }
          >
            {busy === 'img-current' ? <Loader2 size={15} className="spin" /> : <FileDown size={15} />}{' '}
            {t('fileTools.currentPage')}
          </button>
          <button
            type="button"
            className="button"
            disabled={Boolean(busy) || !pdf || !pageCount}
            onClick={() =>
              void run('img-zip', async () => {
                const scratch = await openPdfDocumentFromBytes(await bakedCurrentBytes())
                try {
                  const rendered = await renderPdfToImages(
                    scratch,
                    Array.from({ length: scratch.numPages }, (_, index) => index),
                    scale,
                    format,
                  )
                  const zip = await createZip(rendered.map((page) => ({ name: page.name, data: page.blob })))
                  downloadBlob(zip, `${baseName(fileName)}-images.zip`)
                  useStore.getState().toastMessage('success', t('fileTools.imagesDone'))
                } finally {
                  void scratch.loadingTask.destroy()
                }
              })
            }
          >
            {busy === 'img-zip' ? <Loader2 size={15} className="spin" /> : <FileDown size={15} />}{' '}
            {t('fileTools.allPagesZip')}
          </button>
        </div>
      </section>

      <section className="tool-block">
        <h3>
          <FileText size={15} /> {t('fileTools.pdfToText')}
        </h3>
        <div className="tool-row">
          <button
            type="button"
            className="button"
            disabled={Boolean(busy) || !pdf}
            onClick={() =>
              void run('text-out', async () => {
                const scratch = await openPdfDocumentFromBytes(await bakedCurrentBytes())
                try {
                  const content = await pdfToText(scratch)
                  downloadBlob(new Blob([content], { type: 'text/plain' }), `${baseName(fileName)}.txt`)
                } finally {
                  void scratch.loadingTask.destroy()
                }
              })
            }
          >
            {busy === 'text-out' ? <Loader2 size={15} className="spin" /> : <FileDown size={15} />}{' '}
            {t('fileTools.downloadTxt')}
          </button>
          <span className="tool-hint">{t('fileTools.textHint')}</span>
        </div>
      </section>

      <section className="tool-block">
        <h3>
          <FileUp size={15} /> {t('fileTools.imagesToPdf')}
        </h3>
        <div className="tool-row">
          <button type="button" className="button" onClick={() => imageInputRef.current?.click()}>
            <ImageIcon size={15} /> {t('fileTools.addImages')}
          </button>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
            multiple
            hidden
            onChange={async (event) => {
              const files = event.target.files ? Array.from(event.target.files) : []
              event.target.value = ''
              if (!files.length) return
              const loaded: ImageSource[] = []
              for (const file of files) {
                try {
                  const { src, width, height } = await imageFileToDataUrl(file)
                  loaded.push({ name: file.name, src, width, height })
                } catch (error) {
                  console.error(error)
                }
              }
              setImageSources((current) => [...current, ...loaded])
            }}
          />
          <select
            className="select"
            value={imagePageSize}
            onChange={(event) => setImagePageSize(event.target.value as ImagePageSize)}
          >
            <option value="a4">{t('fileTools.fitA4')}</option>
            <option value="image">{t('fileTools.pageImageSize')}</option>
          </select>
        </div>
        {imageSources.length > 0 && (
          <ul className="source-list">
            {imageSources.map((source, index) => (
              <li key={`${source.name}-${index}`} className="source-item">
                <span className="source-name">{source.name}</span>
                <span className="source-size">
                  {source.width}×{source.height}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() =>
                    setImageSources((current) => {
                      const next = [...current]
                      if (index === 0) return current
                      const [item] = next.splice(index, 1)
                      next.splice(index - 1, 0, item)
                      return next
                    })
                  }
                  disabled={index === 0}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() =>
                    setImageSources((current) => {
                      const next = [...current]
                      if (index === next.length - 1) return current
                      const [item] = next.splice(index, 1)
                      next.splice(index + 1, 0, item)
                      return next
                    })
                  }
                  disabled={index === imageSources.length - 1}
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setImageSources((current) => current.filter((_, i) => i !== index))}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="tool-actions">
          <button
            type="button"
            className="button button-primary"
            disabled={Boolean(busy) || !imageSources.length}
            onClick={() =>
              void run('images-pdf', async () => {
                if (!confirmReplace()) return
                const bytes = await imagesToPdf(imageSources, imagePageSize)
                await openPdfBytes(bytes, 'images.pdf')
                setImageSources([])
                useStore.getState().setToolsOpen(false)
              })
            }
          >
            {busy === 'images-pdf' ? <Loader2 size={15} className="spin" /> : <Combine size={15} />}{' '}
            {t('fileTools.createOpen')}
          </button>
        </div>
      </section>

      <section className="tool-block">
        <h3>
          <FileText size={15} /> {t('fileTools.textToPdf')}
        </h3>
        <textarea
          className="text-area"
          placeholder={t('fileTools.pasteText')}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="tool-actions">
          <button
            type="button"
            className="button button-primary"
            disabled={Boolean(busy) || !text.trim()}
            onClick={() =>
              void run('text-pdf', async () => {
                if (!confirmReplace()) return
                const bytes = await textToPdf(text)
                await openPdfBytes(bytes, 'text.pdf')
                setText('')
                useStore.getState().setToolsOpen(false)
              })
            }
          >
            {busy === 'text-pdf' ? <Loader2 size={15} className="spin" /> : <Combine size={15} />}{' '}
            {t('fileTools.createOpen')}
          </button>
        </div>
      </section>

      <p className="tool-note">{t('fileTools.convertNote')}</p>
    </div>
  )
}
