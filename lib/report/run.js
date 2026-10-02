const { Worker } = require('node:worker_threads')
const path = require('node:path')
function generateReport(options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: options,
    })
    let answered = false
    worker.once('message', (message) => {
      answered = true
      if (message.error) reject(new Error(message.error))
      else resolve(message)
    })
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (!answered)
        reject(new Error(`Geração do XLSX encerrou com código ${code}`))
    })
  })
}
module.exports = { generateReport }
