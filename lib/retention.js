const fs = require('node:fs')
const { pipeline } = require('node:stream/promises')
const { createGzip, createGunzip } = require('node:zlib')
const { createHash } = require('node:crypto')
const { Writable } = require('node:stream')
async function digest(stream) {
  const hash = createHash('sha256')
  await pipeline(
    stream,
    new Writable({
      write(chunk, encoding, done) {
        hash.update(chunk)
        done()
      },
    })
  )
  return hash.digest('hex')
}
async function archiveEvents(filename) {
  const temporary = `${filename}.gz.tmp`,
    output = `${filename}.gz`
  try {
    const expected = await digest(fs.createReadStream(filename))
    await pipeline(
      fs.createReadStream(filename),
      createGzip(),
      fs.createWriteStream(temporary, { mode: 0o600 })
    )
    const actual = await digest(
      fs.createReadStream(temporary).pipe(createGunzip())
    )
    if (actual !== expected)
      throw new Error(
        'Arquivo de auditoria comprimido diverge do registro original'
      )
    fs.renameSync(temporary, output)
    fs.unlinkSync(filename)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}
function cleanupArchives(root, now = Date.now()) {
  for (const name of fs.readdirSync(root))
    if (/\.events\.ndjson\.gz$/.test(name)) {
      const filename = require('node:path').join(root, name)
      if (now - fs.statSync(filename).mtimeMs > 7 * 86400000)
        fs.unlinkSync(filename)
    }
}
module.exports = { archiveEvents, cleanupArchives }
