# Local PDF tools

The home screen lists all tools with search and category filters. Select a tool to open it directly, then choose a file when needed. Compress PDF has a highlighted card in the first row. In the editor, open **Export → All document tools → More PDF tools**.

These tools process documents on the device. Current-document tools include edits, page order, and form values. Unlock and repair accept a separate file. Results download as new files. Opening a result replaces the current editor document after confirmation.

## Added tools

| Task | Options and output |
| --- | --- |
| Compress | Recompress PDF streams without reducing image quality. Keep the current file if compression would increase its size. |
| Protect and unlock | AES-256 password protection and password-based decryption. Passwords stay in memory during the operation. |
| Rotate | Turn selected pages clockwise by 90, 180, or 270 degrees. |
| Watermark and number pages | Select page ranges, watermark text and opacity, or a starting page number and position. |
| Extract images | Download decoded embedded images as PNG files in a ZIP. Image masks alone are not exported. |
| Overlay | Repeat a single overlay page or pair multiple pages in order. Fit within the visible page and retain aspect ratio. |
| Compare | Download a report with the original, comparison, and marked pixel differences. This is a visual comparison, not a semantic text comparison. |
| OCR | Recognize scanned English pages locally. Download a searchable PDF and recognized text. |
| Web optimize | Linearize the final PDF for first-page loading before the complete file arrives. Later edits require optimization again. |
| Repair | Rewrite the PDF structure, with a recovery pass for files with broken cross-reference offsets. Missing content cannot be recovered. |
| Redact | Cover sensitive content in the editor, review every page, then rebuild all pages from visible pixels. |
| Rasterize | Rebuild pages as images at up to 144 dpi. Very large page dimensions use a lower resolution to limit memory. |
| Flatten | Flatten form values and current editor annotations. Existing PDF comments are outside this operation. |
| Create | Start a blank A4 or Letter PDF with 1 to 100 pages. |
| Webpage to PDF | Import saved HTML or paste HTML source. Convert visible text and headings without executing scripts or fetching resources. |
| Crop | Set margins in visible-page PDF points. Cropping hides content but does not erase it. |
| Page size | Fit visible content to A4 or Letter. |
| Pages per sheet | Place two or four pages on each A4 sheet. |
| Halve | Split each visible page horizontally or vertically. |
| Document information | Edit title, author, subject, and keywords, or remove document information and XMP metadata. |
| Bookmarks | Supply one `Title | page` line for each bookmark. New bookmarks replace the document outline. |
| Search | Find current-document pages that contain a text phrase. OCR is required for image-only pages. |
| Viewer preferences | Set toolbar, menu bar, window-fit, and document-title preferences. Reader support varies. |
| Fillable fields | Add named text fields and checkboxes. Coordinates start at the top-left of the visible page, in PDF points. Add multiple fields before creating the result. |

## Limits

- OCR starts with English. Recognition is approximate and needs review. Its output uses page images plus an invisible text layer. Links, interactive fields, and vector content are not retained.
- Redaction and rasterization remove original page objects, searchable text, links, forms, and document metadata from the new file. Original files and library entries are not deleted. A cover box alone is not secure redaction.
- HTML conversion preserves headings and text. It omits layout styling, scripts, images, and remote resources. It does not fetch arbitrary webpage URLs.
- Page resizing, sheets, and halving rebuild page layout. They keep drawn text and images, but do not retain document navigation or interactive widgets. Flatten form fields first when their appearance must be retained.
- Metadata removal targets document information and document XMP. It is not a general content sanitization or redaction tool.
- Editing or rewriting signed documents invalidates existing digital signatures.
- Legacy Office formats, additional ebook/image converters, PDF/A certification, invoicing, and desktop printer software are outside this editor-focused change. Existing merge, split, edit, sign, Office conversion, image conversion, form filling, and page organization remain available.

## Runtime

PDF.js and pdf-lib handle page content and layout. The optional qpdf worker handles encryption, compression, and linearization. Tesseract.js handles OCR. The app serves the qpdf binary, OCR worker, OCR core, and English language data from `/pdf-engine-assets/`. No runtime CDN is used. The dependencies are pinned in the lockfile.

Reference inventory: [PDF24 tools](https://tools.pdf24.org/en/all-tools). Runtime documentation: [qpdf](https://qpdf.readthedocs.io/en/stable/cli.html), [qpdf WebAssembly package](https://github.com/neslinesli93/qpdf-wasm), and [Tesseract.js](https://github.com/naptha/tesseract.js).
