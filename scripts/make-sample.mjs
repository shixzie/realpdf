import fs from 'node:fs'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const doc = await PDFDocument.create()
const font = await doc.embedFont(StandardFonts.Helvetica)
const bold = await doc.embedFont(StandardFonts.HelveticaBold)

const lines = [
  'RealPDF sample document',
  '',
  'This PDF exists so the editor can be exercised end to end:',
  'loading, rendering, annotating and exporting.',
  '',
  'Try the toolbar on the left:',
  '  - Draw freehand with the pen or highlight existing text',
  '  - Drop a text box over a white "Cover" rectangle to replace content',
  '  - Add rectangles, ellipses, lines and arrows',
  '  - Insert images and signatures',
  '  - Reorder or delete pages from the right sidebar',
  '',
  'Everything runs locally in the browser. No uploads, no servers.',
]

for (let index = 1; index <= 3; index += 1) {
  const page = doc.addPage([595, 842])
  page.drawText(`Page ${index} of 3`, {
    x: 56,
    y: 780,
    size: 22,
    font: bold,
    color: rgb(0.07, 0.09, 0.13),
  })
  let y = 730
  for (const line of lines) {
    page.drawText(line, { x: 56, y, size: 12, font, color: rgb(0.15, 0.18, 0.24) })
    y -= line === '' ? 10 : 19
  }
  page.drawRectangle({
    x: 56,
    y: 240,
    width: 483,
    height: 150,
    borderColor: rgb(0.8, 0.84, 0.9),
    borderWidth: 1,
  })
  page.drawText('Signature', { x: 68, y: 360, size: 10, font, color: rgb(0.55, 0.6, 0.68) })
  page.drawLine({
    start: { x: 68, y: 280 },
    end: { x: 320, y: 280 },
    thickness: 0.8,
    color: rgb(0.7, 0.74, 0.8),
  })
  page.drawText('Date', { x: 380, y: 300, size: 10, font, color: rgb(0.55, 0.6, 0.68) })
  page.drawLine({
    start: { x: 380, y: 280 },
    end: { x: 527, y: 280 },
    thickness: 0.8,
    color: rgb(0.7, 0.74, 0.8),
  })
}

fs.writeFileSync('sample.pdf', await doc.save())
console.log('Wrote sample.pdf')
