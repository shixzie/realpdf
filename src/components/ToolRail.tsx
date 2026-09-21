import { useEffect, useRef } from 'react'
import {
  ArrowUpRight,
  Circle,
  Eraser,
  Highlighter,
  Image as ImageIcon,
  Minus,
  MousePointer2,
  PaintBucket,
  Pen,
  Signature,
  Square,
  TextCursorInput,
  Type,
  type LucideIcon,
} from 'lucide-react'
import { useStore } from '../store'
import type { Tool } from '../types'
import { commitCanvas, getCanvas, insertImageObject } from '../lib/canvasRegistry'
import { imageFileToDataUrl } from '../lib/assets'
import { useTranslation } from '../i18n'

interface ToolDef {
  id: Tool
  labelKey: string
  shortcut: string
  icon: LucideIcon
}

export const TOOL_DEFS: ToolDef[] = [
  { id: 'select', labelKey: 'tools.select', shortcut: 'V', icon: MousePointer2 },
  { id: 'text', labelKey: 'tools.text', shortcut: 'T', icon: Type },
  { id: 'textedit', labelKey: 'tools.textedit', shortcut: 'X', icon: TextCursorInput },
  { id: 'pen', labelKey: 'tools.pen', shortcut: 'P', icon: Pen },
  { id: 'highlighter', labelKey: 'tools.highlighter', shortcut: 'H', icon: Highlighter },
  { id: 'rect', labelKey: 'tools.rect', shortcut: 'R', icon: Square },
  { id: 'ellipse', labelKey: 'tools.ellipse', shortcut: 'O', icon: Circle },
  { id: 'line', labelKey: 'tools.line', shortcut: 'L', icon: Minus },
  { id: 'arrow', labelKey: 'tools.arrow', shortcut: 'A', icon: ArrowUpRight },
  { id: 'whiteout', labelKey: 'tools.whiteout', shortcut: 'W', icon: PaintBucket },
  { id: 'image', labelKey: 'tools.image', shortcut: 'I', icon: ImageIcon },
  { id: 'signature', labelKey: 'tools.signature', shortcut: 'S', icon: Signature },
  { id: 'eraser', labelKey: 'tools.eraser', shortcut: 'E', icon: Eraser },
]

export function ToolRail() {
  const { t } = useTranslation()
  const tool = useStore((state) => state.tool)
  const setTool = useStore((state) => state.setTool)
  const imagePickNonce = useStore((state) => state.imagePickNonce)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!imagePickNonce) return
    inputRef.current?.click()
  }, [imagePickNonce])

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    const onCancel = () => useStore.getState().setTool('select')
    input.addEventListener('cancel', onCancel)
    return () => input.removeEventListener('cancel', onCancel)
  }, [])

  const onPickImage = async (file: File | undefined) => {
    useStore.getState().setTool('select')
    if (!file) return
    const state = useStore.getState()
    const canvas = getCanvas(state.currentPageId)
    if (!canvas) {
      state.toastMessage('error', t('toasts.scrollFirst'))
      return
    }
    try {
      const { src } = await imageFileToDataUrl(file)
      state.beginChange()
      await insertImageObject(canvas, src)
      if (state.currentPageId) commitCanvas(state.currentPageId)
      state.toastMessage('success', t('toasts.imageAdded'))
    } catch (error) {
      console.error(error)
      state.toastMessage('error', t('toasts.addImageFailed'))
    }
  }

  return (
    <div className="toolrail">
      {TOOL_DEFS.map((definition) => {
        const Icon = definition.icon
        const active = tool === definition.id
        const label = t(definition.labelKey)
        return (
          <button
            key={definition.id}
            type="button"
            className={`tool ${active ? 'is-active' : ''}`}
            title={`${label} (${definition.shortcut})`}
            aria-label={label}
            onClick={() => {
              if (definition.id === 'image') {
                setTool('image')
                useStore.getState().requestImagePick()
              } else {
                setTool(definition.id)
              }
            }}
          >
            <Icon size={19} strokeWidth={1.8} />
          </button>
        )
      })}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          void onPickImage(file)
        }}
      />
    </div>
  )
}
