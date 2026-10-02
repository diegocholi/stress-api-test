const Excel = require('exceljs')
async function comparisonWorkbook(comparison) {
  const book = new Excel.Workbook()
  book.creator = 'Stress Lab'
  book.created = new Date()
  const add = (name, columns) => {
    const sheet = book.addWorksheet(name, {
      views: [{ state: 'frozen', ySplit: 1 }],
      pageSetup: {
        orientation: 'landscape',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
      },
    })
    sheet.columns = columns.map(([header, width]) => ({ header, width }))
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF162331' },
    }
    return sheet
  }
  const overview = add('Resumo', [
    ['Indicador', 38],
    ['Valor', 100],
  ])
  overview.addRows([
    ['Referência', comparison.left.name],
    ['Referência ID', comparison.left.id],
    ['Selecionada', comparison.right.name],
    ['Selecionada ID', comparison.right.id],
    [
      'Comparação compatível',
      comparison.compatible
        ? 'Sim'
        : 'Não: consulte diferenças e qualidade das execuções',
    ],
    [
      'Leitura',
      'Variações são diferenças observadas. Não representam classificação automática de regressão.',
    ],
  ])
  const metrics = add('Comparação', [
    ['Métrica', 25],
    ['Referência', 22],
    ['Selecionada', 22],
    ['Diferença absoluta', 25],
    ['Variação relativa', 25],
  ])
  for (const m of comparison.metrics)
    metrics.addRow([
      m.field,
      m.left,
      m.right,
      m.delta,
      m.percent === null ? null : m.percent / 100,
    ])
  metrics.getColumn(5).numFmt = '0.00%'
  const config = add('Diferenças', [
    ['Configuração', 35],
    ['Referência', 90],
    ['Selecionada', 90],
  ])
  for (const d of comparison.differences)
    config.addRow([
      d.field,
      typeof d.left === 'object' ? JSON.stringify(d.left) : d.left,
      typeof d.right === 'object' ? JSON.stringify(d.right) : d.right,
    ])
  for (const sheet of book.worksheets) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: Math.max(1, sheet.rowCount), column: sheet.columnCount },
    }
    sheet.eachRow((row, index) => {
      if (index > 1) {
        row.alignment = { vertical: 'top', wrapText: true }
        if (index % 2 === 0)
          row.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF3F6FA' },
          }
      }
    })
  }
  return book.xlsx.writeBuffer()
}
module.exports = { comparisonWorkbook }
