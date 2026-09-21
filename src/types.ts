export type Tool =
  | 'select'
  | 'text'
  | 'textedit'
  | 'pen'
  | 'highlighter'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'whiteout'
  | 'image'
  | 'signature'
  | 'eraser'

export type FontFamily = 'Helvetica' | 'Times New Roman' | 'Courier New'

export interface Settings {
  color: string
  strokeWidth: number
  fontSize: number
  fontFamily: FontFamily
  highlightColor: string
  highlightWidth: number
  whiteoutColor: string
}

export interface AnnotationsJSON {
  objects: unknown[]
}

export interface PageState {
  /** Stable client-side id. */
  id: string
  /** Index of the source page in the original document, or null for a blank page. */
  sourceIndex: number | null
  /** Page width in PDF points at scale 1 (as displayed, i.e. rotation applied). */
  width: number
  /** Page height in PDF points at scale 1 (as displayed, i.e. rotation applied). */
  height: number
  /** pdf.js viewport transform at scale 1: [a, b, c, d, e, f]. */
  transform: number[]
  /** Rotation reported by pdf.js for this page. */
  rotation: number
  /** Fabric.js canvas JSON for this page (image sources are stored in the asset table). */
  annotations: AnnotationsJSON
  /**
   * Bumped only when annotations are replaced from outside the page's canvas
   * (undo/redo/page operations). Canvases use it to decide when to reload, and
   * to avoid clobbering external state with a late debounced commit.
   */
  externalRev: number
}

export interface PageSourceInfo {
  sourceIndex: number
  width: number
  height: number
  transform: number[]
  rotation: number
}
