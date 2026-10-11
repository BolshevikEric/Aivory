import JSZip from 'jszip'
import { columnNameOf, parseXml, resolveSheets, SPREADSHEET_NS, XLSX_MIME } from '@/lib/ooxml/xlsx'

export const LONG_SPREADSHEET_ROWS = 160
export const LONG_SPREADSHEET_COLUMNS = 8
export const LONG_SPREADSHEET_LAST_ROW = 'END-ROW-160'
export const LONG_SPREADSHEET_LAST_COLUMN = 'END-COLUMN-H'

/** Extend the real workbook fixture so scrolling must reach both final edges. */
export async function createLongSpreadsheetFixture(source: ArrayBuffer): Promise<Blob> {
  const archive = await JSZip.loadAsync(source)
  const workbook = archive.file('xl/workbook.xml')
  const relationships = archive.file('xl/_rels/workbook.xml.rels')
  if (!workbook || !relationships) throw new Error('Workbook fixture has no workbook or relationships')
  const sheets = resolveSheets(await workbook.async('string'), await relationships.async('string'))
  const firstSheet = sheets[0]
  const part = firstSheet && archive.file(firstSheet.path)
  if (!part || !firstSheet) throw new Error('Workbook fixture has no first worksheet')

  const document = parseXml(await part.async('string'))
  const sheetData = document.getElementsByTagNameNS(SPREADSHEET_NS, 'sheetData')[0]
  if (!sheetData) throw new Error('Workbook fixture has no worksheet data')

  for (let rowNumber = 7; rowNumber <= LONG_SPREADSHEET_ROWS; rowNumber += 1) {
    const row = document.createElementNS(SPREADSHEET_NS, 'row')
    row.setAttribute('r', String(rowNumber))
    for (let column = 0; column < LONG_SPREADSHEET_COLUMNS; column += 1) {
      const name = columnNameOf(column)
      const cell = document.createElementNS(SPREADSHEET_NS, 'c')
      cell.setAttribute('r', `${name}${rowNumber}`)
      cell.setAttribute('t', 'inlineStr')
      const inline = document.createElementNS(SPREADSHEET_NS, 'is')
      const text = document.createElementNS(SPREADSHEET_NS, 't')
      text.textContent = rowNumber === LONG_SPREADSHEET_ROWS && column === 0
        ? LONG_SPREADSHEET_LAST_ROW
        : rowNumber === LONG_SPREADSHEET_ROWS && column === LONG_SPREADSHEET_COLUMNS - 1
          ? LONG_SPREADSHEET_LAST_COLUMN
          : `Row ${rowNumber}, column ${name}`
      inline.appendChild(text)
      cell.appendChild(inline)
      row.appendChild(cell)
    }
    sheetData.appendChild(row)
  }

  let dimension = document.getElementsByTagNameNS(SPREADSHEET_NS, 'dimension')[0]
  if (!dimension) {
    dimension = document.createElementNS(SPREADSHEET_NS, 'dimension')
    document.documentElement.insertBefore(dimension, document.documentElement.firstChild)
  }
  dimension.setAttribute('ref', `A1:${columnNameOf(LONG_SPREADSHEET_COLUMNS - 1)}${LONG_SPREADSHEET_ROWS}`)
  archive.file(firstSheet.path, new XMLSerializer().serializeToString(document))
  return archive.generateAsync({ type: 'blob', mimeType: XLSX_MIME })
}
