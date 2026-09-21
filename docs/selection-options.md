# Selection options

The options bar above the canvas follows the selection: select any result with
the select tool and the bar shows the options of the tool that produced it,
pre-filled with the result's own values. Changing them edits the selected result
in place (and updates the defaults for the next one). The select tool stays
active, so the object keeps its move/resize/rotate handles, and everything goes
through undo/redo and is written into the exported PDF.

This is the same behaviour the text tool has always had, now it applies to every
tool result.

| Selected result | Options shown | What they change |
| --- | --- | --- |
| Text box or in-place PDF text replacement | Colour, font, size | The selected text's fill, font family and size (the replacement keeps its embedded font until a family is picked) |
| Cover | Colour | The cover's fill (any solid colour, not just white) |
| Rectangle, ellipse | Colour, width | The shape's stroke colour and stroke width |
| Line | Colour, width | The line's stroke colour and stroke width |
| Arrow | Colour, width | The arrow's line **and** its head, so the exported arrow stays one colour |
| Pen drawing | Colour, width | The path's stroke colour and stroke width |
| Highlight | Colour, width | The highlighter colour and stroke width; the multiply blend and transparency are preserved |
| Image or signature | Hint | — (drag to move, handles to resize/rotate; delete with the button or `Delete`) |

Shared behaviours:

- **Multi-selection** (Shift-click): a colour or width change is applied to
  every selected result that supports it; the panel reads its values from the
  first stylable object.
- **Delete selected** is offered whenever something is selected; `Delete` /
  `Backspace` works too.
- **Undo/redo** covers restyling like any other edit.
- **Defaults**: a style change with a selection also updates the tool's
  defaults, so the next annotation you draw uses the same colour/width. With a
  drawing tool active (nothing selected) the same controls edit only the
  defaults.

Selection tracking lives in `src/lib/canvasRegistry.ts` (`activeSelection`,
preferring the page of the last selection) and the styling rules are in
`src/lib/annotationStyle.ts`; `src/components/ToolOptions.tsx` maps the selected
object to its tool and renders the options.

The end-to-end coverage is `tests/e2e/selection-options.test.mjs`.
