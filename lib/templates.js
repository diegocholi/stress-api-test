const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { validate, legacyInput } = require('./config')
function definition(input) {
  const converted = require('./migration').requireMigration(input)
  const config = validate(converted)
  const name = String(
    input.name || config.collection.info.name || 'Teste salvo'
  )
    .trim()
    .slice(0, 120)
  const { collection, environment, ...base } = config
  return {
    ...base,
    name: name || 'Teste salvo',
    mode: 'builder',
    scenario: structuredClone(config.scenario),
  }
}
function countRequests(items) {
  return items.reduce(
    (n, item) =>
      n +
      (item.request ? 1 : 0) +
      (Array.isArray(item.item) ? countRequests(item.item) : 0),
    0
  )
}
function summary(template) {
  const d = template.definition
  const stages =
    typeof d.stages === 'string'
      ? d.stages.split(',').map((s) => {
          const [durationSec, target] = s.split(':').map(Number)
          return { durationSec, target }
        })
      : Array.isArray(d.stages)
        ? d.stages
        : []
  return {
    id: template.id,
    name: d.name || d.collection?.info?.name || 'Teste antigo',
    mode: d.mode,
    revision: template.revision,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    migration: template.migration,
    canRun: template.migration?.compatible !== false,
    steps:
      d.mode === 'builder' && Array.isArray(d.scenario?.steps)
        ? (() => {
            let count = 0
            require('./flow').walk(d.scenario.steps, (n) => {
              if (n.type === 'request') count++
            })
            return count
          })()
        : countRequests(d.collection?.item || []),
    durationSec: stages.reduce((sum, s) => sum + s.durationSec, 0),
    loadModel: d.loadModel || 'users',
    peakUsers: Math.max(0, ...stages.map((s) => s.target)),
  }
}
class TemplateStore {
  constructor(root) {
    this.root = path.join(root, 'templates')
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
    this.items = new Map()
    for (const file of fs
      .readdirSync(this.root)
      .filter((n) => /^[a-f0-9-]+\.json$/.test(n))) {
      try {
        const item = JSON.parse(
          fs.readFileSync(path.join(this.root, file), 'utf8')
        )
        if (!/^[a-f0-9-]+$/.test(item.id) || file !== `${item.id}.json`)
          throw new Error('Identificador inválido')
        const wasLegacy = item.definition.schemaVersion !== 4
        const migration = require('./migration').migrate(
          legacyInput(item.definition)
        )
        if (wasLegacy)
          item.originalDefinition ||= structuredClone(item.definition)
        item.migration = {
          compatible: migration.compatible,
          issues: migration.issues,
          warnings: migration.warnings,
        }
        if (migration.compatible) {
          try {
            item.definition = definition(migration.definition)
          } catch (error) {
            item.migration = {
              compatible: false,
              issues: [
                {
                  field: error.field,
                  nodeId: error.nodeId,
                  message: error.message,
                },
              ],
              warnings: migration.warnings,
            }
          }
        }
        this.items.set(item.id, item)
        if (wasLegacy && item.migration.compatible) {
          item.revision++
          this.write(item)
        }
      } catch (error) {
        console.error(`Teste salvo inválido: ${file}: ${error.message}`)
      }
    }
  }
  list() {
    return [...this.items.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(summary)
  }
  get(id) {
    const item = this.items.get(id)
    if (!item)
      throw Object.assign(new Error('Teste salvo não encontrado'), {
        statusCode: 404,
      })
    return structuredClone(item)
  }
  write(item) {
    const filename = path.join(this.root, `${item.id}.json`),
      temporary = `${filename}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(item), { mode: 0o600 })
    fs.renameSync(temporary, filename)
    this.items.set(item.id, item)
    return summary(item)
  }
  create(input) {
    const now = new Date().toISOString()
    return this.write({
      id: randomUUID(),
      revision: 1,
      createdAt: now,
      updatedAt: now,
      ...(input.schemaVersion !== 4
        ? { originalDefinition: structuredClone(input) }
        : {}),
      definition: definition(input),
    })
  }
  update(id, input) {
    const current = this.get(id)
    if (input.revision !== current.revision)
      throw Object.assign(
        new Error(
          'Este teste foi atualizado em outra aba. Carregue a versão atual ou salve uma cópia.'
        ),
        { statusCode: 409 }
      )
    return this.write({
      ...current,
      definition: definition(input),
      migration: undefined,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    })
  }
  duplicate(id) {
    const current = this.get(id)
    return this.create({
      ...current.definition,
      name: `${current.definition.name.slice(0, 110)} (cópia)`,
    })
  }
  delete(id) {
    this.get(id)
    fs.unlinkSync(path.join(this.root, `${id}.json`))
    this.items.delete(id)
  }
}
module.exports = { TemplateStore, definition, countRequests }
