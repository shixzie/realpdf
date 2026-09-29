import { useRef, useState, type ChangeEvent } from 'react'
import { FileUp } from 'lucide-react'
import { useStore } from '../store'
import { openDocumentFile, openPdfBytes } from '../lib/openDocument'
import { bakedCurrentBytes } from '../lib/currentDocument'
import { downloadBlob } from '../lib/exportController'
import { addBookmarks, changePageSize, createFillableFields, cropPages, editMetadata, halvePages, pagesPerSheet, removeMetadata, searchPdfText, setViewerPreferences, type FormFieldSpec } from '../lib/extraDocumentTools'
import { useTranslation } from '../i18n'

export type ExtraToolId = 'crop' | 'pageSize' | 'metadata' | 'removeMetadata' | 'sheet' | 'halve' | 'bookmarks' | 'search' | 'preferences' | 'fields'
export const EXTRA_TOOLS = (['crop', 'pageSize', 'metadata', 'removeMetadata', 'sheet', 'halve', 'bookmarks', 'search', 'preferences', 'fields'] as ExtraToolId[]).map((id) => ({ id, titleKey: `extraTools.${id}`, hintKey: `extraTools.${id}Hint` }))

function download(bytes: Uint8Array, fileName: string | null, suffix: string): void {
  const base = (fileName ?? 'document.pdf').replace(/\.pdf$/i, '')
  downloadBlob(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), `${base}-${suffix}.pdf`)
}

export function ExtraToolsPanel({ tool }: { tool: ExtraToolId }) {
  const { t } = useTranslation()
  const fileName = useStore((state) => state.fileName)
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<string[] | null>(null)
  const [output, setOutput] = useState<{ bytes: Uint8Array; name: string } | null>(null)
  const [fields, setFields] = useState<FormFieldSpec[]>([])
  const [crop, setCrop] = useState({ top: '', right: '', bottom: '', left: '' })
  const [size, setSize] = useState<'a4' | 'letter'>('a4')
  const [metadata, setMetadata] = useState<Partial<Record<'title' | 'author' | 'subject' | 'keywords', string>>>({})
  const [choice, setChoice] = useState(tool === 'halve' ? 'vertical' : '2')
  const [lines, setLines] = useState('')
  const [query, setQuery] = useState('')
  const [prefs, setPrefs] = useState({ hideToolbar: false, hideMenubar: false, fitWindow: false, displayDocTitle: true })
  const [field, setField] = useState({ type: 'text' as 'text' | 'checkbox', page: '1', x: '20', y: '20', width: '160', height: '24', name: '', value: '', checked: false })
  const run = async (action: () => Promise<Uint8Array>, suffix: string) => {
    if (busy) return
    setBusy(true)
    setError('')
    setOutput(null)
    try {
      const bytes = await action()
      const name = `${fileName?.replace(/\.pdf$/i, '')}-${suffix}.pdf`
      download(bytes, fileName, suffix)
      setOutput({ bytes, name })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('advanced.engineFailed'))
    } finally {
      setBusy(false)
    }
  }
  const fieldSpec = (): FormFieldSpec => ({
    type: field.type,
    page: Number(field.page),
    x: Number(field.x),
    y: Number(field.y),
    width: Number(field.width),
    height: Number(field.height),
    name: field.name,
    options: field.type === 'text' ? { value: field.value } : { checked: field.checked },
  })
  if (!fileName) return <div className="tool-section"><p className="tool-hint">{t('extraTools.noDocument')}</p><button type="button" className="button" onClick={() => inputRef.current?.click()}><FileUp size={15} /> {t('extraTools.open')}</button><input ref={inputRef} hidden type="file" accept="application/pdf,.pdf" onChange={(event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void openDocumentFile(file) }} /></div>
  const number = (value: string) => Number(value) || 0
  const fieldInput = (key: keyof typeof field, label: string) => <label>{label}<input className="text-input" value={field[key] as string} onChange={(event) => setField((current) => ({ ...current, [key]: event.target.value }))} /></label>
  const action = (fn: () => Promise<Uint8Array>, suffix: string) => <button className="button" type="button" disabled={busy} onClick={() => void run(fn, suffix)}>{busy ? t('extraTools.busy') : t('extraTools.run')}</button>
  return <div className="tool-section extra-tool-panel"><h3>{t(`extraTools.${tool}`)}</h3><p className="tool-hint">{t(`extraTools.${tool}Hint`)}</p>{error && <p role="alert" className="tool-error">{error}</p>}
    {tool === 'crop' && <><div className="tool-row">{(['top', 'right', 'bottom', 'left'] as const).map((key) => <label key={key}>{t(`extraTools.${key}`)}<input className="text-input" type="number" min="0" value={crop[key]} onChange={(event) => setCrop({ ...crop, [key]: event.target.value })} /></label>)}</div>{action(async () => cropPages(await bakedCurrentBytes(), { top: number(crop.top), right: number(crop.right), bottom: number(crop.bottom), left: number(crop.left) }), 'cropped')}</>}
    {tool === 'pageSize' && <><label>{t('extraTools.preset')}<select className="select" value={size} onChange={(event) => setSize(event.target.value as 'a4' | 'letter')}><option value="a4">{t('extraTools.a4')}</option><option value="letter">{t('extraTools.letter')}</option></select></label>{action(async () => changePageSize(await bakedCurrentBytes(), size), 'resized')}</>}
    {tool === 'metadata' && <><div className="tool-row">{(['title', 'author', 'subject', 'keywords'] as const).map((key) => <label key={key}>{t(key === 'title' ? 'extraTools.metadataTitle' : `extraTools.${key}`)}<input className="text-input" value={metadata[key] ?? ''} onChange={(event) => setMetadata({ ...metadata, [key]: event.target.value })} /></label>)}</div>{action(async () => editMetadata(await bakedCurrentBytes(), metadata), 'metadata')}</>}
    {tool === 'removeMetadata' && action(async () => removeMetadata(await bakedCurrentBytes()), 'no-metadata')}
    {tool === 'sheet' && <><label>{t('extraTools.count')}<select className="select" value={choice} onChange={(event) => setChoice(event.target.value)}><option value="2">2</option><option value="4">4</option></select></label>{action(async () => pagesPerSheet(await bakedCurrentBytes(), choice === '4' ? 4 : 2), 'sheet')}</>}
    {tool === 'halve' && <><label>{t('extraTools.direction')}<select className="select" value={choice} onChange={(event) => setChoice(event.target.value)}><option value="vertical">{t('extraTools.vertical')}</option><option value="horizontal">{t('extraTools.horizontal')}</option></select></label>{action(async () => halvePages(await bakedCurrentBytes(), choice === 'horizontal' ? 'horizontal' : 'vertical'), 'halved')}</>}
    {tool === 'bookmarks' && <><label>{t('extraTools.lines')}<textarea className="text-input" value={lines} onChange={(event) => setLines(event.target.value)} /></label>{action(async () => addBookmarks(await bakedCurrentBytes(), lines), 'bookmarked')}</>}
    {tool === 'search' && <><label>{t('extraTools.query')}<input className="text-input" value={query} onChange={(event) => setQuery(event.target.value)} /></label><button className="button" type="button" disabled={busy} onClick={async () => { setBusy(true); setError(''); setResult(null); try { setResult((await searchPdfText(await bakedCurrentBytes(), query)).map((match) => `${match.page}: ${match.text}`)) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) } }}>{busy ? t('extraTools.busy') : t('extraTools.search')}</button>{result && <div role="status">{result.length ? result.map((line) => <p key={line}>{line}</p>) : <p>{t('extraTools.noMatches')}</p>}</div>}</>}
    {tool === 'preferences' && <>{(['hideToolbar', 'hideMenubar', 'fitWindow', 'displayDocTitle'] as const).map((key) => <label key={key} className="check"><input type="checkbox" checked={prefs[key]} onChange={(event) => setPrefs({ ...prefs, [key]: event.target.checked })} />{t(`extraTools.${key}`)}</label>)}{action(async () => setViewerPreferences(await bakedCurrentBytes(), prefs), 'preferences')}</>}
    {tool === 'fields' && <><div className="tool-row"><label>{t('extraTools.fieldType')}<select className="select" value={field.type} onChange={(event) => setField({ ...field, type: event.target.value as 'text' | 'checkbox' })}><option value="text">{t('extraTools.textField')}</option><option value="checkbox">{t('extraTools.checkboxField')}</option></select></label>{fieldInput('name', t('extraTools.fieldName'))}{fieldInput('page', t('extraTools.page'))}{fieldInput('x', t('extraTools.x'))}{fieldInput('y', t('extraTools.y'))}{fieldInput('width', t('extraTools.width'))}{fieldInput('height', t('extraTools.height'))}</div>{field.type === 'text' ? fieldInput('value', t('extraTools.value')) : <label className="check"><input type="checkbox" checked={field.checked} onChange={(event) => setField({ ...field, checked: event.target.checked })} />{t('extraTools.checked')}</label>}<p className="tool-hint">{t('extraTools.geometryHint')}</p>
      <button type="button" className="button" disabled={busy || !field.name.trim()} onClick={() => { setFields([...fields, fieldSpec()]); setField({ ...field, name: '', value: '' }); setOutput(null) }}>{t('extraTools.addField')}</button>
      {fields.map((entry, index) => <div className="tool-row" key={index}><span>{entry.name} · {entry.page}</span><button className="link-button" type="button" onClick={() => { setFields(fields.filter((_, item) => item !== index)); setOutput(null) }}>{t('common.delete')}</button></div>)}
      {action(async () => createFillableFields(await bakedCurrentBytes(), field.name.trim() ? [...fields, fieldSpec()] : fields), 'fillable')}</>}
    {output && <div className="tool-result" role="status"><strong>{t('extraTools.ready')}</strong><span>{output.name}</span><button type="button" className="button" onClick={async () => {
      if (!window.confirm(t('extraTools.replaceConfirm'))) return
      try {
        await openPdfBytes(output.bytes, output.name)
        useStore.getState().setToolsOpen(false)
      } catch { setError(t('advanced.engineFailed')) }
    }}>{t('extraTools.openResult')}</button></div>}
  </div>
}
