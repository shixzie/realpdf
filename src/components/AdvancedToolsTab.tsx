import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Download, FileUp, Loader2, Search } from 'lucide-react'
import { useStore } from '../store'
import { formatBytes, useTranslation } from '../i18n'
import { DOCUMENT_TOOLS, EXTRA_TOOLS, type AdvancedToolId, type DocumentToolId, type ExtraToolId } from '../lib/documentToolCatalog'
import { bakedCurrentBytes } from '../lib/currentDocument'
import { downloadBlob } from '../lib/exportController'
import { openDocumentFile, openPdfBytes } from '../lib/openDocument'
import { parsePageRanges } from '../lib/pdfOps'
import { createZip } from '../lib/zip'
import { ExtraToolsPanel } from './ExtraToolsPanel'

export function AdvancedToolsTab({ initialTool }: { initialTool?: AdvancedToolId | null }) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<AdvancedToolId | null>(initialTool ?? null)
  const [search, setSearch] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    panelRef.current?.closest('.tools-body')?.scrollTo({ top: 0 })
  }, [selected])
  const tools = [
    ...DOCUMENT_TOOLS.map((tool) => ({ ...tool, titleKey: `advanced.${tool.id}`, hintKey: `advanced.${tool.id}Hint` })),
    ...EXTRA_TOOLS,
  ]
  return (
    <div ref={panelRef} className="tool-section advanced-tools">
      {selected ? (
        <>
          <button type="button" className="link-button tool-back" onClick={() => setSelected(null)}>
            <ArrowLeft size={15} /> {t('advanced.allTools')}
          </button>
          {DOCUMENT_TOOLS.some((tool) => tool.id === selected)
            ? <DocumentToolPanel key={selected} tool={selected as DocumentToolId} />
            : <ExtraToolsPanel key={selected} tool={selected as ExtraToolId} />}
        </>
      ) : (
        <>
          <p className="tool-hint">{t('advanced.localHint')}</p>
          <label className="tool-search">
            <Search size={16} />
            <input className="text-input" aria-label={t('advanced.searchTools')} placeholder={t('advanced.searchTools')} value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <div className="document-tool-grid">
            {tools.filter((tool) => `${t(tool.titleKey)} ${t(tool.hintKey)}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((tool) => (
              <button type="button" className="document-tool-card" key={tool.id} onClick={() => setSelected(tool.id)}>
                <strong>{t(tool.titleKey)}</strong>
                <span>{t(tool.hintKey)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

interface Output {
  blob: Blob
  name: string
  pdf?: Uint8Array
  note?: string
  text?: string
}

type Job = { status: 'idle' } | { status: 'working'; done: number; total: number } | { status: 'ready'; output: Output } | { status: 'error'; message: string }

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="advanced-field"><span>{label}</span>{children}</label>
}

function DocumentToolPanel({ tool }: { tool: DocumentToolId }) {
  const { t } = useTranslation()
  const fileName = useStore((state) => state.fileName)
  const pageCount = useStore((state) => state.pages.length)
  const openInput = useRef<HTMLInputElement>(null)
  const [job, setJob] = useState<Job>({ status: 'idle' })
  const [file, setFile] = useState<File | null>(null)
  const [pages, setPages] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [text, setText] = useState('')
  const [opacity, setOpacity] = useState(0.3)
  const [fontSize, setFontSize] = useState(48)
  const [angle, setAngle] = useState(90)
  const [start, setStart] = useState(1)
  const [position, setPosition] = useState<'top' | 'bottom'>('bottom')
  const [size, setSize] = useState<'a4' | 'letter'>('a4')
  const [count, setCount] = useState(1)
  const [confirmed, setConfirmed] = useState(false)
  const busy = job.status === 'working'
  const needsDocument = DOCUMENT_TOOLS.find((item) => item.id === tool)!.needsDocument
  const hasRange = ['rotate', 'watermark', 'numbers', 'overlay'].includes(tool)
  const needsFile = ['unlock', 'repair', 'overlay', 'compare'].includes(tool)

  const selection = () => {
    if (pages.trim() && !['all', '*'].includes(pages.trim().toLowerCase())) {
      for (const part of pages.split(',')) {
        const match = /^\s*(\d+)(?:\s*-\s*(\d*))?\s*$/.exec(part)
        if (!match || Number(match[1]) < 1 || Number(match[1]) > pageCount ||
          (match[2] && (Number(match[2]) < Number(match[1]) || Number(match[2]) > pageCount))) {
          throw new Error(t('advanced.invalidPages'))
        }
      }
    }
    return parsePageRanges(pages, pageCount)
  }

  const run = async () => {
    if (busy) return
    setJob({ status: 'working', done: 0, total: 0 })
    try {
      if (needsFile && !file) throw new Error(t('advanced.choosePdf'))
      if (needsDocument && !fileName) throw new Error(t('advanced.openFirst'))
      if (tool === 'protect' && (!password || password !== confirmPassword)) throw new Error(t('advanced.passwordMismatch'))
      if (tool === 'redact' && !confirmed) throw new Error(t('advanced.reviewCovers'))
      const input = needsDocument ? await bakedCurrentBytes() : new Uint8Array()
      const suffix = tool.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
      const base = (fileName || file?.name || 'document.pdf').replace(/\.pdf$/i, '')
      let result: Uint8Array
      let note: string | undefined
      let recognizedText: string | undefined
      switch (tool) {
        case 'compress': {
          const { compressPdf } = await import('../lib/localPdfEngine')
          result = await compressPdf(input)
          if (result.length >= input.length) {
            result = input
            note = t('advanced.alreadySmall')
          } else note = t('advanced.sizeChange', { before: formatBytes(input.length), after: formatBytes(result.length) })
          break
        }
        case 'optimize': {
          const { optimizePdf } = await import('../lib/localPdfEngine')
          result = await optimizePdf(input)
          break
        }
        case 'protect': {
          const { protectPdf } = await import('../lib/localPdfEngine')
          result = await protectPdf(input, password)
          break
        }
        case 'unlock':
        case 'repair': {
          const { unlockPdf, repairPdf } = await import('../lib/localPdfEngine')
          const bytes = new Uint8Array(await file!.arrayBuffer())
          result = tool === 'unlock' ? await unlockPdf(bytes, password) : await repairPdf(bytes)
          break
        }
        case 'rotate': {
          const { rotatePages } = await import('../lib/documentTools')
          result = await rotatePages(input, angle as 90 | 180 | 270, selection())
          break
        }
        case 'watermark': {
          const { addWatermark } = await import('../lib/documentTools')
          result = await addWatermark(input, { text, opacity, fontSize, angle: 0, pages: selection() })
          break
        }
        case 'numbers': {
          const { addPageNumbers } = await import('../lib/documentTools')
          result = await addPageNumbers(input, { start, position, pages: selection() })
          break
        }
        case 'overlay': {
          const { overlayPdf } = await import('../lib/documentTools')
          result = await overlayPdf(input, new Uint8Array(await file!.arrayBuffer()), { opacity, pages: selection() })
          break
        }
        case 'compare': {
          const { comparePdfs } = await import('../lib/documentTools')
          const comparison = await comparePdfs(input, new Uint8Array(await file!.arrayBuffer()))
          result = comparison.bytes
          note = t('advanced.comparisonResult', { changed: comparison.changedPages, total: comparison.totalPages })
          break
        }
        case 'extractImages': {
          const { extractEmbeddedImages } = await import('../lib/documentTools')
          const images = await extractEmbeddedImages(input)
          if (!images.length) throw new Error(t('advanced.noImages'))
          const blob = await createZip(images.map((image) => ({ name: image.name, data: image.bytes })))
          setJob({ status: 'ready', output: { blob, name: `${base}-images.zip`, note: t('advanced.imageCount', { count: images.length }) } })
          return
        }
        case 'ocr': {
          const { ocrPdf } = await import('../lib/ocr')
          const output = await ocrPdf(input, (done, total) => setJob({ status: 'working', done, total }))
          result = output.bytes
          recognizedText = output.text
          break
        }
        case 'redact':
        case 'rasterize': {
          const { rasterFlatten } = await import('../lib/documentTools')
          result = await rasterFlatten(input)
          break
        }
        case 'flatten': {
          const { applyFormValues } = await import('../lib/forms')
          const flattened = await applyFormValues(input, {}, { flatten: true })
          if (flattened.errors.length) throw new Error(t('advanced.flattenFailed'))
          result = flattened.bytes
          break
        }
        case 'html': {
          const { webpageToPdf } = await import('../lib/webpageToPdf')
          result = await webpageToPdf(text)
          break
        }
        case 'create': {
          const { createBlankPdf } = await import('../lib/documentTools')
          if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error(t('advanced.invalidBlankPage'))
          result = await createBlankPdf({ width: size === 'a4' ? 595.28 : 612, height: size === 'a4' ? 841.89 : 792, count })
          break
        }
      }
      setJob({ status: 'ready', output: { blob: new Blob([result as BlobPart], { type: 'application/pdf' }), pdf: tool === 'protect' ? undefined : result, name: `${base}-${suffix}.pdf`, note, text: recognizedText } })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      setJob({ status: 'error', message: /QPDF|OCR_|RuntimeError|WebAssembly/i.test(message) ? t(tool === 'unlock' ? 'advanced.unlockFailed' : 'advanced.engineFailed') : message || t('advanced.engineFailed') })
    }
  }

  const output = job.status === 'ready' ? job.output : null
  return (
    <section className="tool-section document-tool-panel">
      <h3>{t(`advanced.${tool}`)}</h3>
      <p className="tool-hint">{t(`advanced.${tool}Hint`)}</p>
      {needsDocument && (
        <div className="tool-source">
          <span>{fileName ? t('advanced.currentDocument', { fileName, count: pageCount }) : t('advanced.openFirst')}</span>
          {!fileName && <button type="button" className="button" onClick={() => openInput.current?.click()}><FileUp size={15} /> {t('advanced.choosePdf')}</button>}
          <input ref={openInput} type="file" accept="application/pdf,.pdf" hidden onChange={(event) => { const selected = event.target.files?.[0]; if (selected) void openDocumentFile(selected) }} />
        </div>
      )}
      <fieldset className="tool-fields" disabled={busy} onChange={() => { if (job.status !== 'idle') setJob({ status: 'idle' }) }}>
        {needsFile && <Field label={t(tool === 'overlay' ? 'advanced.overlayFile' : tool === 'compare' ? 'advanced.compareFile' : 'advanced.pdfFile')}>
          <input type="file" accept="application/pdf,.pdf" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        </Field>}
        {hasRange && <Field label={t('advanced.pages')}><input className="text-input" value={pages} placeholder={t('advanced.allPages')} onChange={(event) => setPages(event.target.value)} /></Field>}
        {tool === 'rotate' && <Field label={t('advanced.rotation')}><select className="select" value={angle} onChange={(event) => setAngle(Number(event.target.value))}>
          <option value={90}>90°</option><option value={180}>180°</option><option value={270}>270°</option>
        </select></Field>}
        {tool === 'watermark' && <>
          <Field label={t('advanced.watermarkText')}><input className="text-input" value={text} onChange={(event) => setText(event.target.value)} /></Field>
          <Field label={t('advanced.fontSize')}><input type="number" className="text-input" value={fontSize} min={6} max={200} onChange={(event) => setFontSize(Number(event.target.value))} /></Field>
        </>}
        {['watermark', 'overlay'].includes(tool) && <Field label={t('advanced.opacity')}><input type="range" value={opacity} min={0.05} max={1} step={0.05} onChange={(event) => setOpacity(Number(event.target.value))} /><output>{Math.round(opacity * 100)}%</output></Field>}
        {tool === 'numbers' && <>
          <Field label={t('advanced.startNumber')}><input className="text-input" type="number" value={start} min={0} onChange={(event) => setStart(Number(event.target.value))} /></Field>
          <Field label={t('advanced.position')}><select className="select" value={position} onChange={(event) => setPosition(event.target.value as 'top' | 'bottom')}><option value="bottom">{t('advanced.bottom')}</option><option value="top">{t('advanced.top')}</option></select></Field>
        </>}
        {['protect', 'unlock'].includes(tool) && <Field label={t('advanced.password')}><input type="password" autoComplete="new-password" className="text-input" value={password} onChange={(event) => setPassword(event.target.value)} /></Field>}
        {tool === 'protect' && <Field label={t('advanced.confirmPassword')}><input type="password" autoComplete="new-password" className="text-input" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></Field>}
        {tool === 'html' && <>
          <Field label={t('advanced.htmlFile')}><input type="file" accept="text/html,.html,.htm" onChange={async (event) => { const selected = event.target.files?.[0]; if (selected) { setText(await selected.text()); setJob({ status: 'idle' }) } }} /></Field>
          <Field label={t('advanced.htmlSource')}><textarea className="text-area" rows={8} value={text} onChange={(event) => setText(event.target.value)} /></Field>
        </>}
        {tool === 'create' && <>
          <Field label={t('advanced.pageSize')}><select className="select" value={size} onChange={(event) => setSize(event.target.value as 'a4' | 'letter')}><option value="a4">A4</option><option value="letter">Letter</option></select></Field>
          <Field label={t('advanced.pageCount')}><input type="number" className="text-input" min={1} max={100} value={count} onChange={(event) => setCount(Number(event.target.value))} /></Field>
        </>}
        {tool === 'redact' && <>
          <p className="tool-notice">{t('advanced.redactWarning')}</p>
          <button className="button" type="button" onClick={() => { const store = useStore.getState(); store.setToolsOpen(false); store.setTool('whiteout') }}>{t('advanced.placeCovers')}</button>
          <label className="check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{t('advanced.reviewCovers')}</label>
        </>}
      </fieldset>
      {job.status === 'error' && <p className="tool-error" role="alert">{job.message}</p>}
      {busy && <p className="tool-hint" role="status">{job.total ? t('advanced.progress', { done: job.done, total: job.total }) : t('advanced.processing')}</p>}
      <div className="tool-actions">
        <button type="button" className="button button-primary" disabled={busy || (needsDocument && !fileName)} onClick={() => void run()}>
          {busy && <Loader2 size={15} className="spin" />} {t('advanced.run')}
        </button>
      </div>
      {output && <div className="tool-result" role="status">
        <strong>{t('advanced.ready')}</strong>
        <span>{output.name} · {formatBytes(output.blob.size)}</span>
        {output.note && <p>{output.note}</p>}
        <div className="tool-actions">
          <button type="button" className="button button-primary" onClick={() => downloadBlob(output.blob, output.name)}><Download size={15} /> {t('common.download')}</button>
          {output.pdf && <button type="button" className="button" onClick={async () => {
            if (fileName && !window.confirm(t('advanced.replaceConfirm'))) return
            try {
              await openPdfBytes(output.pdf!, output.name)
              useStore.getState().setToolsOpen(false)
            } catch { setJob({ status: 'error', message: t('advanced.engineFailed') }) }
          }}>{t('advanced.openResult')}</button>}
          {output.text && <button type="button" className="button" onClick={() => downloadBlob(new Blob([output.text!], { type: 'text/plain' }), output.name.replace(/\.pdf$/, '.txt'))}>{t('advanced.downloadText')}</button>}
        </div>
      </div>}
    </section>
  )
}
