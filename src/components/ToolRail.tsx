import { useEffect, useRef } from 'react'
import {
  AArrowUp,
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
  Type,
  type LucideIcon,
} from 'lucide-react'
import { useStore } from '../store'
import type { Tool } from '../types'
import { commitCanvas, getCanvas, insertImageObject } from '../lib/canvasRegistry'
import { imageFileToDataUrl } from '../lib/assets'

interface ToolDef {
  id: Tool
  label: string
  shortcut: string
  icon: LucideIcon
}

export const TOOL_DEFS: ToolDef[] = [
  { id: 'select', label: 'Select', shortcut: 'V', icon: MousePointer2 },
  { id: 'text', label: 'Text', shortcut: 'T', icon: Type },
  { id: 'pen', label: 'Draw', shortcut: 'P', icon: Pen },
  { id: 'highlighter', label: 'Highlight', shortcut: 'H', icon: Highlighter },
  { id: 'rect', label: 'Rectangle', shortcut: 'R', icon: Square },
  { id: 'ellipse', label: 'Ellipse', shortcut: 'O', icon: Circle },
  { id: 'line', label: 'Line', shortcut: 'L', icon: Minus },
  { id: 'arrow', label: 'Arrow', shortcut: 'A', icon: AArrowUp },
  { id: 'whiteout', label: 'Cover (white)', shortcut: 'W', icon: PaintBucket },
  { id: 'image', label: 'Image', shortcut: 'I', icon: ImageIcon },
  { id: 'signature', label: 'Signature', shortcut: 'S', icon: Signature },
  { id: 'eraser', label: 'Erase annotation', shortcut: 'E', icon: Eraser },
]

export function ToolRail() {
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
      state.toastMessage('error', 'Scroll to a page first, then add the image.')
      return
    }
    try {
      const { src } = await imageFileToDataUrl(file)
      state.beginChange()
      await insertImageObject(canvas, src)
      if (state.currentPageId) commitCanvas(state.currentPageId)
      state.toastMessage('success', 'Image added — drag to position it.')
    } catch (error) {
      console.error(error)
      state.toastMessage('error', 'Could not add that image.')
    }
  }

  return (
    <div className="toolrail">
      {TOOL_DEFS.map((definition) => {
        const Icon = definition.icon
        const active = tool === definition.id
        return (
          <button
            key={definition.id}
            type="button"
            className={`tool ${active ? 'is-active' : ''}`}
            title={`${definition.label} (${definition.shortcut})`}
            aria-label={definition.label}
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
