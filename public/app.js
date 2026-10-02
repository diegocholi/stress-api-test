const $ = (id) => document.getElementById(id)
const stages = $('stages')
let selected = sessionStorage.getItem('stress-selected') || undefined,
  runs = [],
  points = []
let selectedJob,
  historyPage = 1,
  historySignature = '',
  lastLibraryRefresh = 0,
  seriesKey,
  refreshSequence = 0
const comparisonOptions = new Map()
let workspaceBusy = false,
  submitPending = false,
  repeatPending = false
let mode = 'builder',
  editorSchema = 4,
  seriesInterval,
  seriesPhases = {}

let loadedTemplate = null,
  templates = [],
  dirty = false,
  librarySignature = '',
  editorBusy = false
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.classList.add('icon')
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', `#i-${name}`)
  svg.append(use)
  return svg
}
function updateLoadSummary() {
  const rows = [...stages.children]
  const duration = rows.reduce(
    (total, row) => total + (Number(row.children[0].value) || 0),
    0
  )
  const peak = Math.max(
    0,
    ...rows.map((row) =>
      Math.max(
        Number(row.children[1].value) || 0,
        row.querySelector('[data-stage-profile]')?.value === 'ramp'
          ? Number(row.querySelector('[data-stage-from]')?.value) || 0
          : 0
      )
    )
  )
  $('load-summary').textContent =
    `${duration}s · ATÉ ${peak} ${$('load-model').value === 'arrival' ? 'CENÁRIOS/S' : 'USUÁRIOS'}`
  rows.forEach((row) => (row.children[2].disabled = rows.length === 1))
  $('add-stage').disabled = rows.length >= 50
  const preview = $('load-preview'),
    svg = svgElement('svg', {
      viewBox: '0 0 640 175',
      role: 'img',
      'aria-label': `Perfil de carga: ${duration}s, até ${peak} ${$('load-model').value === 'arrival' ? 'cenários/s' : 'usuários'}`,
    })
  let elapsed = 0,
    path = 'M 45 145'
  for (const row of rows) {
    const ramp = row.querySelector('[data-stage-profile]')?.value === 'ramp',
      from = Number(row.querySelector('[data-stage-from]')?.value) || 0
    const target = Number(row.children[1].value) || 0,
      end = elapsed + (Number(row.children[0].value) || 0),
      y = 145 - (target / Math.max(1, peak)) * 120
    path += ` L ${45 + (elapsed / Math.max(1, duration)) * 570} ${ramp ? 145 - (from / Math.max(1, peak)) * 120 : y} L ${45 + (end / Math.max(1, duration)) * 570} ${y}`
    elapsed = end
  }
  svg.append(
    svgElement('path', {
      d: path + ' L 615 145 L 45 145 Z',
      fill: '#c0f78022',
    }),
    svgElement('path', {
      d: path,
      fill: 'none',
      stroke: '#c0f780',
      'stroke-width': 3,
    })
  )
  for (const [x, y, text] of [
    [45, 169, '0s'],
    [550, 169, `${duration}s`],
    [
      45,
      15,
      `${peak} ${$('load-model').value === 'arrival' ? 'cenários/s' : 'usuários'}`,
    ],
  ]) {
    const label = svgElement('text', { x, y, fill: '#c0cad7', 'font-size': 13 })
    label.textContent = text
    svg.append(label)
  }
  preview.replaceChildren(svg)
}
stages.addEventListener('input', updateLoadSummary)
const destinations = {
  '#configure': [
    'configure',
    'Configurar teste',
    'Defina o cenário, a carga e os critérios do seu teste.',
  ],
  '#monitor': [
    'monitor',
    'Acompanhamento',
    'Acompanhe a execução e a carga em tempo real.',
  ],
  '#results-panel': [
    'results',
    'Resultados',
    'Consulte os critérios, compare execuções e exporte as evidências.',
  ],
  '#saved-panel': [
    'library',
    'Testes salvos',
    'Carregue e organize os cenários da sua biblioteca.',
  ],
  '#history-panel': [
    'history',
    'Histórico e agenda',
    'Encontre execuções anteriores e acompanhe os agendamentos.',
  ],
}
function closeMenu(restoreFocus = true) {
  const wasOpen = document.body.classList.contains('menu-open')
  document.body.classList.remove('menu-open')
  $('menu-toggle').setAttribute('aria-expanded', 'false')
  $('menu-backdrop').hidden = true
  $('workspace-navigation').removeAttribute('role')
  $('workspace-navigation').removeAttribute('aria-modal')
  document.querySelector('main').inert = false
  document.querySelector('.topbar').inert = false
  $('workspace-navigation').inert =
    document.body.classList.contains('mobile-layout')
  if (wasOpen && restoreFocus) $('menu-toggle').focus({ preventScroll: true })
}
$('menu-toggle').onclick = () => {
  document.body.classList.add('menu-open')
  $('menu-toggle').setAttribute('aria-expanded', 'true')
  $('menu-backdrop').hidden = false
  $('workspace-navigation').inert = false
  $('workspace-navigation').setAttribute('role', 'dialog')
  $('workspace-navigation').setAttribute('aria-modal', 'true')
  document.querySelector('main').inert = true
  document.querySelector('.topbar').inert = true
  $('menu-close').focus()
}
$('menu-close').onclick = () => closeMenu()
$('menu-backdrop').onclick = () => closeMenu()
document.addEventListener('keydown', (event) => {
  if (!document.body.classList.contains('menu-open')) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeMenu()
  } else if (event.key === 'Tab') {
    const controls = [
      ...$('workspace-navigation').querySelectorAll('button, a[href]'),
    ]
    const first = controls[0],
      last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
})
new ResizeObserver(([entry]) => {
  const mobile = entry.contentRect.width <= 830
  if (mobile !== document.body.classList.contains('mobile-layout')) {
    document.body.classList.toggle('mobile-layout', mobile)
    closeMenu(false)
  }
}).observe(document.body)
function updateNavigation() {
  const hash = Object.hasOwn(destinations, location.hash)
    ? location.hash
    : '#configure'
  if (location.hash && location.hash !== hash)
    history.replaceState(null, '', hash)
  const [view, title, description] = destinations[hash]
  document.body.dataset.view = view
  $('view-title').textContent = title
  $('view-description').textContent = description
  document.title = `${title} · Stress Lab`
  document.querySelector('.breadcrumb strong').textContent = title
  document.querySelectorAll('.nav-link').forEach((link) => {
    const active = link.getAttribute('href') === hash
    link.classList.toggle('active', active)
    if (active) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  })
}
for (const link of document.querySelectorAll('.nav-link')) {
  link.addEventListener('click', () => {
    closeMenu(false)
    requestAnimationFrame(() => {
      $('view-title').focus({ preventScroll: true })
      $('view-title').scrollIntoView({ block: 'start' })
    })
  })
}
window.addEventListener('hashchange', updateNavigation)
updateNavigation()
const labels = {
  scheduled: 'Agendado',
  running: 'Executando',
  stopping: 'Encerrando',
  completed: 'Concluído',
  failed: 'Falhou',
  cancelled: 'Cancelado',
}
const verdictLabels = {
  approved: 'Aprovado',
  rejected: 'Reprovado',
  inconclusive: 'Inconclusivo',
  partial: 'Resultado parcial',
  pending: 'Provisório',
}
function addStage(duration = 30, target = 10, ramp = false, from = 0) {
  const row = document.createElement('div')
  row.className = 'stage'
  row.innerHTML =
    '<input type="number" min="1" max="86400" required aria-label="Duração do estágio em segundos"><input type="number" min="0" max="500" required aria-label="Usuários do estágio"><button type="button" aria-label="Remover estágio">×</button>'
  row.children[0].value = duration
  row.children[1].value = target
  row.children[2].onclick = () => {
    if (stages.children.length > 1) row.remove()
    updateLoadSummary()
    markDirty()
  }
  const profile = document.createElement('select')
  profile.dataset.stageProfile = ''
  profile.setAttribute('aria-label', 'Perfil do estágio')
  for (const [value, label] of [
    ['step', 'Degrau'],
    ['ramp', 'Rampa'],
  ]) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    profile.append(option)
  }
  profile.value = ramp ? 'ramp' : 'step'
  const initial = document.createElement('input')
  initial.type = 'number'
  initial.min = 0
  initial.max = 500
  initial.value = from
  initial.dataset.stageFrom = ''
  initial.setAttribute('aria-label', 'Alvo inicial da rampa')
  initial.hidden = !ramp
  profile.onchange = () => {
    initial.hidden = profile.value !== 'ramp'
    updateLoadSummary()
    markDirty()
  }
  row.append(profile, initial)
  stages.append(row)
  updateLoadSummary()
}
addStage()
addStage(60, 20)
function updateModel() {
  const arrival = $('load-model').value === 'arrival'
  $('model-help').textContent = arrival
    ? 'Taxa de cenários/s independente da duração da API. Um cenário de uma requisição corresponde ao RPS planejado. Chegadas atrasadas ou sem capacidade são descartadas e registradas.'
    : 'Usuários repetem o cenário. Se a API fica lenta, a taxa de novas operações diminui.'
  $('form').elements.thinkTime.disabled = arrival
  document.querySelector('.stage-heading').children[1].textContent = arrival
    ? 'Cenários por segundo'
    : 'Usuários alvo'
  for (const row of stages.children)
    row.children[1].setAttribute(
      'aria-label',
      arrival ? 'Cenários por segundo do estágio' : 'Usuários do estágio'
    )
  updateLoadSummary()
}
$('load-model').onchange = updateModel
updateModel()
$('load-preset').onchange = () => {
  const profiles = {
    constant: [[60, 10]],
    stress: [
      [30, 10, true, 1],
      [60, 30, true, 10],
      [30, 50, true, 30],
    ],
    spike: [
      [30, 5],
      [10, 50],
      [30, 5],
    ],
    soak: [[3600, 10]],
  }
  const profile = profiles[$('load-preset').value]
  if (profile) {
    stages.replaceChildren()
    profile.forEach((args) => addStage(...args))
    markDirty()
  }
}
$('add-stage').onclick = () => {
  if (stages.children.length < 50) {
    addStage()
    markDirty()
  }
}

function setMode() {
  mode = 'builder'
}
const flowEditor = new FlowEditor($('requests'), () => {
  markDirty()
  updateRequests()
})
function updateRequests() {
  const flow = flowEditor.value()
  let count = 0
  flowEditor.walk(flow.steps, (n) => {
    if (n.type === 'request') count++
  })
  $('request-count').textContent = count + ' REQUISIÇÕES'
}
function addRequest(step) {
  if (step && Object.keys(step).length) {
    const flow = flowEditor.value()
    flow.steps.push(step)
    flowEditor.load(flow)
  } else flowEditor.add('request')
  updateRequests()
}
function pairs(value, separator, label) {
  return value
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const at = line.indexOf(separator)
      if (at < 1)
        throw new Error(`${label}: use Nome${separator} valor, um por linha.`)
      return { key: line.slice(0, at).trim(), value: line.slice(at + 1).trim() }
    })
}
function readScenario() {
  const flow = flowEditor.value()
  if (flow.dataset) {
    flow.dataset.select = $('dataset-select').value
    flow.dataset.exhaustion = $('dataset-exhaustion').value
  }
  flow.variables = pairs($('variables').value, '=', 'Variáveis')
  const normalize = (nodes) => {
    for (const n of nodes) {
      if (n.invalidHeaders)
        throw Object.assign(
          new Error('Headers: use Nome: valor, um por linha'),
          { nodeId: n.id, field: 'headers' }
        )
      if (
        n.invalidJsonCheck ||
        n.invalidCondition ||
        n.checks?.some((c) => c.invalid)
      )
        throw Object.assign(
          new Error('Valor esperado precisa ser JSON válido'),
          { nodeId: n.id, field: 'jsonValue' }
        )
      if (n.type === 'request') {
        n.checks = [
          ...(n.checks || []),
          ...(n.expectedStatus !== undefined && n.expectedStatus !== ''
            ? [
                {
                  source: 'status',
                  operator: 'equals',
                  value: Number(n.expectedStatus),
                },
              ]
            : []),
          ...(n.contains
            ? [{ source: 'text', operator: 'contains', value: n.contains }]
            : []),
          ...(n.jsonCheck
            ? [{ source: 'json', operator: 'equals', ...n.jsonCheck }]
            : []),
        ]
        n.extracts = [
          ...(n.extracts || []),
          ...(n.extract
            ? [{ source: 'json', scope: 'journey', ...n.extract }]
            : []),
        ]
        for (const field of [
          'timeout',
          'retries',
          'p95Limit',
          'endpointSamples',
        ])
          if (n[field] === '' || n[field] === undefined) delete n[field]
      }
      for (const key of ['children', 'then', 'else'])
        if (n[key]) normalize(n[key])
    }
  }
  for (const key of ['steps', 'setup', 'perUser', 'teardown'])
    normalize(flow[key])
  return flow
}
function clearErrors() {
  document.querySelectorAll('.field-error').forEach((el) => el.remove())
  document.querySelectorAll('[aria-invalid=true]').forEach((el) => {
    el.removeAttribute('aria-invalid')
    el.removeAttribute('aria-describedby')
  })
}
function showError(error) {
  $('message').textContent = error.message
  $('message').className = 'error'
  let input
  if (error.nodeId) {
    createPage(0)
    flowEditor.select(error.nodeId)
    input = document.querySelector(
      `[data-node-id="${error.nodeId}"] [data-field="${error.field}"]`
    )
  }
  if (!input && Number.isInteger(error.step))
    input = $('requests').children[error.step]?.querySelector(
      `[data-field="${error.field || 'url'}"]`
    )
  if (!input && error.field) {
    input = $('form').elements.namedItem(error.field)
    const section = input?.closest('[data-create-section]')
    if (section) createPage(Number(section.dataset.createSection))
  }
  if (input) {
    location.hash = '#configure'
    let parent = input.parentElement
    while (parent) {
      if (parent.tagName === 'DETAILS') parent.open = true
      parent = parent.parentElement
    }
    input.setAttribute('aria-invalid', 'true')
    clearErrors()
    const message = document.createElement('small')
    message.className = 'field-error'
    message.id = 'field-error'
    message.textContent = error.message
    input.setAttribute('aria-invalid', 'true')
    input.after(message)
    input.setAttribute('aria-describedby', message.id)
    // Busy operations make the form inert; focus after their finally block.
    requestAnimationFrame(() => input.focus())
  }
}
$('form').addEventListener('input', clearErrors)
$('add-request').onclick = () => {
  addRequest()
  markDirty()
}
addRequest()
setMode('builder')

async function api(url, data) {
  const res = await fetch(
    url,
    data === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        }
  )
  const result = await res.json()
  if (!res.ok)
    throw Object.assign(new Error(result.error || 'Falha na requisição'), {
      step: result.step,
      field: result.field,
      nodeId: result.nodeId,
      issues: result.issues,
    })
  return result
}
async function readFile(id, required = false) {
  const file = $(id).files[0]
  if (!file) {
    if (required) throw new Error('Selecione a collection')
    return undefined
  }
  if (file.size > 5 * 1024 * 1024) throw new Error('Arquivo excede 5 MB')
  try {
    return JSON.parse(await file.text())
  } catch {
    throw new Error(`${file.name}: JSON inválido`)
  }
}
$('form').addEventListener(
  'invalid',
  (event) => {
    event.preventDefault()
    if (document.querySelector('.field-error')) return
    const row = event.target.closest('.request-card'),
      step = row ? [...$('requests').children].indexOf(row) : undefined
    showError(
      Object.assign(
        new Error(event.target.validationMessage || 'Preencha este campo.'),
        {
          step,
          field:
            event.target.dataset.field || event.target.name || event.target.id,
        }
      )
    )
  },
  true
)
$('form').onsubmit = async (event) => {
  event.preventDefault()
  clearErrors()
  submitPending = true
  $('submit').disabled = true
  $('message').textContent = 'Preparando teste…'
  $('message').className = ''
  updateLoadSummary()
  try {
    const input = await collectInput(true)
    const job = await api('/api/runs', input)
    selectRun(job.id)
    location.hash = '#monitor'
    $('message').textContent = input.scheduledAt
      ? 'Teste agendado. Mantenha o servidor aberto para executar.'
      : 'Teste iniciado.'
    await refresh()
  } catch (e) {
    showError(e)
  } finally {
    submitPending = false
    executionAvailability()
  }
}

function unusedEndpointRules() {
  return $('endpoint-rules')
    .value.split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const parts = line.split('|'),
        minResponses = Number(parts.pop()),
        p95 = Number(parts.pop()),
        name = parts.join('|').trim()
      if (
        !name ||
        !Number.isInteger(p95) ||
        p95 < 1 ||
        !Number.isInteger(minResponses) ||
        minResponses < 1
      )
        throw Object.assign(
          new Error(
            'Critério por endpoint: use Nome | p95 em ms | amostra mínima.'
          ),
          { field: 'endpointRules' }
        )
      return { name, p95, minResponses }
    })
}
async function collectInput(includeSchedule = false) {
  const form = $('form').elements
  const source = { scenario: readScenario() }
  const input = {
    schemaVersion: 4,
    engine: 'k6',
    journeyThresholds: $('journey-p95').value
      ? { p95: Number($('journey-p95').value) }
      : null,
    name: form.name.value,
    mode,
    ...source,
    stages: [...stages.children].map((row) => ({
      durationSec: Number(row.children[0].value),
      target: Number(row.children[1].value),
      ...(row.querySelector('[data-stage-profile]').value === 'ramp'
        ? {
            ramp: true,
            fromTarget: Number(row.querySelector('[data-stage-from]').value),
          }
        : {}),
    })),
    loadModel: form.loadModel.value,
    warmupSec: Number(form.warmupSec.value),
    maxConcurrent: Number(form.maxConcurrent.value),
    generatorLagLimitMs: Number(form.generatorLagLimitMs.value),
    endpointThresholds: (() => {
      const rules = []
      flowEditor.walk(readScenario().steps, (n) => {
        if (n.type === 'request' && n.p95Limit)
          rules.push({
            nodeId: n.id,
            name: n.name,
            p95: Number(n.p95Limit),
            minResponses: Number(n.endpointSamples || 100),
          })
      })
      return rules
    })(),
    timeout: Number(form.timeout.value),
    scenarioTimeout: Number(form.scenarioTimeout.value),
    drainTimeout: Number(form.drainTimeout.value),
    evidence: {
      minResponses: Number(form.minResponses.value),
      minLoadPercent: Number(form.minLoadPercent.value),
    },
    thinkTime: Number(form.thinkTime.value),
    keepAlive: form.keepAlive.checked,
    bail: form.bail.checked,
    insecure: form.insecure.checked,
    thresholds: {
      p95: Number(form.p95.value),
      errorRate: Number(form.errorRate.value),
    },
  }
  if (
    includeSchedule &&
    $('execution-time').value === 'schedule' &&
    form.scheduledAt.value
  )
    input.scheduledAt = new Date(form.scheduledAt.value).toISOString()
  return input
}
function editorState() {
  $('methodology-note').textContent =
    'k6 · Metodologia 4.0 · Avaliação por estágio, passo e jornada.'
  $('upgrade-methodology').hidden = editorSchema >= 3
  $('editor-status').textContent = dirty
    ? 'NÃO SALVO'
    : loadedTemplate
      ? 'SALVO'
      : 'NOVO'
  $('editor-status').className =
    `badge ${dirty ? 'scheduled' : loadedTemplate ? 'completed' : 'neutral'}`
  $('editing-note').hidden = !loadedTemplate
  $('editing-label').textContent = loadedTemplate
    ? `Editando: ${loadedTemplate.name} · versão ${loadedTemplate.revision}`
    : ''
  $('save-label').textContent = loadedTemplate
    ? 'Salvar alterações'
    : 'Salvar teste'
  $('save-copy').hidden = !loadedTemplate
}
function markDirty(event) {
  if (
    event?.target?.name === 'scheduledAt' ||
    event?.target?.id === 'execution-time'
  )
    return
  dirty = true
  editorState()
}
$('form').addEventListener('input', markDirty)
$('form').addEventListener('change', markDirty)
function executionAvailability() {
  const immediate = $('execution-time').value === 'now'
  $('submit').disabled =
    submitPending || editorBusy || (immediate && workspaceBusy)
  $('check-once').disabled = editorBusy || workspaceBusy
  $('execution-availability').textContent = workspaceBusy
    ? 'Há uma execução ou relatório em andamento. Você pode editar, salvar ou agendar outro teste.'
    : ''
}
function setEditorBusy(value) {
  editorBusy = value
  executionAvailability()
  $('form').inert = value
  $('new-test').disabled = value
  $('save-test').disabled = value
  $('save-copy').disabled = value
  renderLibrary()
}
function canReplace() {
  if (editorBusy) {
    libraryMessage('Aguarde a operação atual terminar.')
    return false
  }
  return (
    !dirty || window.confirm('Há alterações não salvas. Deseja substituí-las?')
  )
}
function resetEditor() {
  $('form').reset()
  scheduleMode()
  clearErrors()
  loadedTemplate = null

  flowEditor.load()
  addRequest()
  if ($('form').dataset.createPage !== undefined) createPage(0)
  stages.replaceChildren()
  addStage()
  addStage(60, 20)
  setMode('builder')
  editorSchema = 4
  dirty = false
  editorState()
  $('message').textContent = ''
  renderLibrary()
  updateModel()
}
function newTest() {
  if (!canReplace()) return
  resetEditor()
  location.hash = '#configure'
  $('form').elements.name.focus()
}
$('upgrade-methodology').onclick = () => {
  editorSchema = 4
  markDirty()
}
$('new-test').onclick = newTest
$('detach-template').onclick = newTest
async function loadTemplate(id) {
  if (!canReplace()) return false
  setEditorBusy(true)
  try {
    const item = await api(`/api/templates/${id}`)
    if (item.migration?.compatible === false)
      throw new Error(item.migration.issues.map((i) => i.message).join('; '))
    const d = item.definition
    resetEditor()
    const form = $('form').elements
    editorSchema = d.schemaVersion || 2
    for (const name of [
      'name',
      'timeout',
      'scenarioTimeout',
      'drainTimeout',
      'thinkTime',
    ])
      form[name].value = d[name]
    for (const name of ['keepAlive', 'bail', 'insecure'])
      form[name].checked = d[name]
    form.p95.value = d.thresholds.p95
    form.errorRate.value = d.thresholds.errorRate
    form.minResponses.value = d.evidence?.minResponses ?? 1
    form.minLoadPercent.value = d.evidence?.minLoadPercent ?? 0
    stages.replaceChildren()
    d.stages.forEach((stage) =>
      addStage(stage.durationSec, stage.target, stage.ramp, stage.fromTarget)
    )
    form.generatorLagLimitMs.value = d.generatorLagLimitMs ?? 100
    form.loadModel.value = d.loadModel || 'users'
    form.warmupSec.value = d.warmupSec || 0
    form.maxConcurrent.value = d.maxConcurrent || 500
    updateModel()
    if (d.mode === 'builder') {
      flowEditor.load(d.scenario)
      $('dataset-select').value = d.scenario.dataset?.select || 'iteration'
      $('dataset-exhaustion').value = d.scenario.dataset?.exhaustion || 'error'
      $('dataset-note').textContent = d.scenario.dataset
        ? d.scenario.dataset.rows.length + ' linhas carregadas.'
        : ''
      $('journey-p95').value = d.journeyThresholds?.p95 || ''
      $('variables').value = (d.scenario.variables || [])
        .map((v) => `${v.key}=${v.value}`)
        .join('\n')
    }
    setMode(d.mode)
    loadedTemplate = { id: item.id, name: d.name, revision: item.revision }
    dirty = false
    editorState()
    renderLibrary()
    $('message').textContent =
      'Teste carregado. Você pode editar, executar ou agendar.'
    location.hash = '#configure'
    return true
  } catch (e) {
    libraryMessage(e.message, true)
    return false
  } finally {
    setEditorBusy(false)
  }
}
async function saveTemplate(asNew = false) {
  if (editorBusy || !$('form').reportValidity()) return
  setEditorBusy(true)
  try {
    const input = await collectInput()
    const editing = loadedTemplate && !asNew
    if (editing) input.revision = loadedTemplate.revision
    const item = await api(
      editing ? `/api/templates/${loadedTemplate.id}` : '/api/templates',
      input
    )
    loadedTemplate = { id: item.id, name: item.name, revision: item.revision }
    $('form').elements.name.value = item.name
    dirty = false
    editorState()
    $('message').className = ''
    $('message').textContent = editing
      ? 'Alterações salvas.'
      : 'Teste salvo na sua biblioteca.'
    await refreshLibrary()
  } catch (e) {
    showError(e)
  } finally {
    setEditorBusy(false)
  }
}
$('save-test').onclick = () => saveTemplate()
$('save-copy').onclick = () => saveTemplate(true)
function libraryMessage(message, error = false) {
  $('library-message').textContent = message
  $('library-message').classList.toggle('error', error)
}
async function duplicateTemplate(id) {
  if (editorBusy) return
  try {
    await api(`/api/templates/${id}/duplicate`, {})
    await refreshLibrary()
    libraryMessage('Cópia criada na biblioteca.')
  } catch (e) {
    libraryMessage(e.message, true)
  }
}
async function deleteTemplate(item) {
  if (editorBusy) return
  if (
    !window.confirm(
      `Excluir o teste salvo "${item.name}"? O histórico de execuções será mantido.`
    )
  )
    return
  try {
    await api(`/api/templates/${item.id}/delete`, {})
    if (loadedTemplate?.id === item.id) {
      loadedTemplate = null
      dirty = true
      editorState()
    }
    await refreshLibrary()
    libraryMessage('Teste excluído. O histórico foi mantido.')
  } catch (e) {
    libraryMessage(e.message, true)
  }
}
function renderLibrary() {
  const search = $('saved-search').value.trim().toLocaleLowerCase('pt-BR')
  const signature = JSON.stringify([
    templates,
    loadedTemplate?.id,
    search,
    editorBusy,
  ])
  if (signature === librarySignature) return
  librarySignature = signature
  $('saved-count').textContent =
    `${templates.length} ${templates.length === 1 ? 'TESTE' : 'TESTES'}`
  $('saved-nav-count').textContent = templates.length
  const filtered = templates.filter((item) =>
    item.name.toLocaleLowerCase('pt-BR').includes(search)
  )
  $('saved-list').replaceChildren(
    ...filtered.map((item) => {
      const card = document.createElement('div')
      card.className = 'saved-item'
      card.dataset.selected = String(item.id === loadedTemplate?.id)
      const title = document.createElement('div')
      title.className = 'saved-title'
      const name = document.createElement('strong')
      name.textContent = item.name
      const badge = document.createElement('span')
      badge.className = 'badge neutral'
      badge.textContent = item.canRun === false ? 'ADAPTAÇÃO NECESSÁRIA' : 'K6'
      title.append(name, badge)
      const meta = document.createElement('span')
      meta.className = 'saved-meta'
      meta.textContent = `${item.steps} requisições · ${item.durationSec}s · até ${item.peakUsers} ${item.loadModel === 'arrival' ? 'cenários/s' : 'usuários'} · atualizado em ${new Date(item.updatedAt).toLocaleString('pt-BR')}`
      const actions = document.createElement('div')
      actions.className = 'saved-actions'
      for (const [label, cls, action] of [
        ['Carregar', 'load-template', () => loadTemplate(item.id)],
        ['Duplicar', 'duplicate-template', () => duplicateTemplate(item.id)],
        ['Excluir', 'delete-template', () => deleteTemplate(item)],
      ]) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = cls
        button.textContent = label
        button.disabled = editorBusy
        button.setAttribute('aria-label', `${label} ${item.name}`)
        button.onclick = action
        actions.append(button)
      }
      if (item.migration?.issues?.length) {
        const note = document.createElement('p')
        note.className = 'help error'
        note.textContent = item.migration.issues
          .map((i) => i.message)
          .join('; ')
        card.append(note)
      }
      card.append(title, meta, actions)
      return card
    })
  )
  if (!filtered.length) {
    const empty = document.createElement('div')
    empty.className = 'empty-history'
    const title = document.createElement('strong')
    title.textContent = search
      ? 'Nenhum teste encontrado.'
      : 'Salve seu primeiro cenário.'
    const help = document.createElement('p')
    help.textContent = search
      ? 'Tente buscar por outro nome.'
      : 'Configure um teste e clique em Salvar teste para reutilizá-lo depois.'
    empty.append(icon('save'), title, help)
    $('saved-list').append(empty)
  }
}
async function refreshLibrary() {
  templates = await api('/api/templates')
  renderLibrary()
}
$('saved-search').oninput = renderLibrary
editorState()

function renderMetrics(s = {}) {
  const recent = s.throughput?.recent,
    average = s.throughput?.average5,
    elapsed = s.elapsed || 0
  const rate = (key, total) =>
    recent
      ? number(recent[key], 1)
      : s.throughput
        ? ['completed', 'failed', 'cancelled'].includes(s.status)
          ? 'Sem janela'
          : 'Coletando'
        : '—'
  const note = (key, total) =>
    `Últimos 5s: ${average ? number(average[key], 1) : '—'} · média global: ${number(elapsed ? total / elapsed : 0, 1)}/s`
  const metrics = [
    [
      'Tentativas/s',
      rate('requests', s.requests),
      note('requests', s.requests || 0),
    ],
    [
      'Sucessos HTTP/s',
      rate('successes'),
      note('successes', (s.requests || 0) - (s.failedRequests || 0)),
    ],
    ['Cenários/s', rate('scenarios'), note('scenarios', s.runs || 0)],
    [
      'Usuários',
      s.loadModel === 'arrival'
        ? `${s.active || 0}`
        : `${s.active || 0} / ${number(s.target || 0, 1)}`,
      s.loadModel === 'arrival'
        ? `Alocados · taxa alvo ${number(s.target, 1)} cenários/s`
        : 'Alocados / alvo',
    ],
    [
      'p95',
      (s.performance || s).p95 == null ? '—' : `${(s.performance || s).p95} ms`,
      `${number(s.performance?.samples ?? s.samples, 0)} respostas avaliadas`,
    ],
    [
      'Falhas',
      `${number(s.performance?.errorRate ?? s.errorRate ?? 0)}%`,
      'HTTP ≥400 ou conexão; validações separadas',
    ],
  ]
  $('metrics').replaceChildren(
    ...metrics.map(([label, value, help]) => {
      const el = document.createElement('div')
      el.className = 'metric'
      for (const [tag, text] of [
        ['span', label],
        ['strong', value],
        ['small', help],
      ]) {
        const child = document.createElement(tag)
        child.textContent = text
        el.append(child)
      }
      return el
    })
  )
  const running = ['running', 'stopping'].includes(s.status),
    stale = running && s.updatedAt && Date.now() - s.updatedAt > 3000
  $('throughput-status').textContent =
    `${stale ? 'Dados desatualizados · ' : ''}${s.throughput ? (running ? 'Janela completa de 1s, aguardando lotes dos workers.' : 'Última janela completa de 1s; medição encerrada.') : 'Throughput recente não registrado nesta versão.'} ${s.updatedAt ? `Atualizado às ${new Date(s.updatedAt).toLocaleTimeString('pt-BR')}.` : ''}`
  const current = s.stages?.find((stage) => stage.stage === s.stage),
    coverage = current?.loadPercent
  $('generator-status').textContent =
    `${s.generatorHealth?.overloaded ? 'Gerador sobrecarregado · ' : ''}${['completed', 'failed', 'cancelled'].includes(s.status) ? 'Encerrado' : { warmup: 'Aquecimento', load: 'Carga', drain: 'Drenagem' }[s.phase] || 'Execução'} · ${number(s.busy || 0, 0)} cenários em execução · ${number(s.paused || 0, 0)} usuários em pausa · ${number(s.inFlight || 0, 0)} requisições em andamento · cumprimento ${number(coverage)}%${current?.droppedArrivals ? ` · ${current.droppedArrivals} chegadas descartadas` : ''}`
  $('generator-telemetry').textContent =
    `Coletor Node: CPU ${number(s.cpuPercent)}% (100% = 1 núcleo) · memória ${number(s.rssMB)} MB · event loop ${number(s.eventLoopLagMs)} ms · k6 CPU ${number(s.k6CpuPercent)}% · k6 memória ${number(s.k6RssMB)} MB. Carga insuficiente torna a avaliação inconclusiva; CPU isolada não reprova a API.`
  $('load-progress').value = coverage || 0
}
renderMetrics()
function repeatSources(job) {
  const signature = JSON.stringify(templates.map((t) => [t.id, t.name]))
  if ($('repeat-template').dataset.signature !== signature) {
    const previous = $('repeat-template').value
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = 'Selecione um teste salvo'
    $('repeat-template').replaceChildren(
      placeholder,
      ...templates.map((t) => {
        const option = document.createElement('option')
        option.value = t.id
        option.textContent = t.name
        return option
      })
    )
    $('repeat-template').value = previous
    $('repeat-template').dataset.signature = signature
  }
  if ($('repeat-template').dataset.run !== job.id) {
    $('repeat-template').value = ''
    $('repeat-template').dataset.run = job.id
  }
}
$('repeat').onclick = async () => {
  const job = selectedJob
  if (!job) return
  repeatPending = true
  $('repeat').disabled = true
  $('repeat-message').hidden = true
  try {
    let next
    if (job.canRepeat) next = await api(`/api/runs/${job.id}/repeat`, {})
    else {
      const id = $('repeat-template').value
      if (!id) {
        $('repeat-template').focus()
        throw new Error('Escolha um teste salvo acima para executar novamente.')
      }
      const template = await api(`/api/templates/${id}`)
      next = await api('/api/runs', template.definition)
    }
    selectRun(next.id)
    location.hash = '#monitor'
    $('message').className = ''
    $('message').textContent =
      'Nova execução iniciada. O relatório anterior continua no histórico.'
    await refresh()
  } catch (error) {
    $('message').className = 'error'
    $('message').textContent = error.message
    $('repeat-message').hidden = false
    $('repeat-message').textContent = error.message
    $('repeat-message').dataset.run = job.id
  } finally {
    repeatPending = false
    $('repeat').disabled = workspaceBusy
  }
}
function scheduleMode() {
  const scheduled = $('execution-time').value === 'schedule'
  executionAvailability()
  $('schedule-field').hidden = !scheduled
  $('form').elements.scheduledAt.disabled = !scheduled
  $('form').elements.scheduledAt.required = scheduled
  $('submit').querySelector('span').textContent = scheduled
    ? 'Agendar teste de carga'
    : 'Iniciar teste de carga'
  $('schedule-zone').textContent =
    `Fuso: ${Intl.DateTimeFormat().resolvedOptions().timeZone}. O servidor precisa estar ligado.`
}
$('execution-time').onchange = scheduleMode
scheduleMode()
async function preflight(once) {
  if (editorBusy || !$('form').reportValidity()) return
  clearErrors()
  setEditorBusy(true)
  try {
    const input = await collectInput()
    const result = await api(once ? '/api/runs/check' : '/api/validate', input)
    $('message').className = ''
    if (once) {
      selectRun(result.id)
      location.hash = '#monitor'
      $('message').textContent =
        'Verificação funcional iniciada: um cenário com um usuário.'
      await refresh()
    } else
      $('message').textContent =
        `Configuração válida: ${result.steps} requisições · ${result.durationSec}s. Nenhuma requisição foi enviada.`
  } catch (e) {
    showError(e)
  } finally {
    setEditorBusy(false)
  }
}
$('validate-config').onclick = () => preflight(false)
$('check-once').onclick = () => preflight(true)
function selectRun(id) {
  selected = id
  sessionStorage.setItem('stress-selected', id)
  selectedJob = undefined
  seriesKey = undefined
  points = []
  seriesPhases = {}
  seriesInterval = undefined
  $('comparison-note').textContent = ''
  $('comparison-output').replaceChildren()
  renderCharts([])
  historySignature = ''
  resultTab = 'summary'
  resultStage = ''
  resultTabs()
}
function number(value, precision = 2) {
  return Number.isFinite(value)
    ? value.toLocaleString('pt-BR', { maximumFractionDigits: precision })
    : value === true
      ? 'Sim'
      : value === false
        ? 'Não'
        : (value ?? '—')
}
function tableBody(id, rows) {
  const body = $(id).querySelector('tbody'),
    signature = JSON.stringify(rows)
  if (body.dataset.signature === signature) return
  body.dataset.signature = signature
  body.replaceChildren(
    ...rows.map((values) => {
      const row = document.createElement('tr')
      values.forEach((value) => {
        const cell = document.createElement('td')
        cell.textContent = number(value)
        row.append(cell)
      })
      return row
    })
  )
}
function verdict(job) {
  return (
    job.result?.evaluation?.verdict ||
    (job.status === 'completed'
      ? job.result?.passed
        ? 'approved'
        : 'rejected'
      : ['failed', 'cancelled'].includes(job.status)
        ? 'partial'
        : 'pending')
  )
}
function render(job) {
  selectedJob = job
  $('monitor').dataset.runId = job.id
  const s = job.result || {},
    finished = ['completed', 'cancelled', 'failed'].includes(job.status),
    outcome = verdict(job)
  if ($('repeat-message').dataset.run !== job.id)
    $('repeat-message').hidden = true
  $('repeat').hidden = !finished
  $('repeat').disabled =
    repeatPending || workspaceBusy || s.reportStatus === 'generating'
  $('repeat-source').hidden = !finished || job.canRepeat
  if (finished && !job.canRepeat) repeatSources(job)
  $('status').textContent = finished
    ? verdictLabels[outcome]
    : labels[job.status] || job.status
  if (finished && s.purpose === 'check' && s.schemaVersion >= 3)
    $('status').textContent =
      outcome === 'approved' ? 'Fluxo aprovado' : verdictLabels[outcome]
  const statusClass =
    outcome === 'approved'
      ? 'completed'
      : outcome === 'rejected'
        ? 'failed'
        : finished
          ? 'scheduled'
          : ['running', 'stopping'].includes(job.status)
            ? 'running'
            : 'neutral'
  $('status').className = `badge ${statusClass}`
  $('run-name').textContent = job.name
  $('run-info').textContent =
    `${new Date(job.scheduledAt).toLocaleString('pt-BR')} · ${s.purpose === 'check' ? 'Verificação funcional' : `Estágio ${s.stage || 0}`} · ${number(s.elapsed || 0)} segundos`
  renderMetrics(s)
  const reasons = s.evaluation?.reasons || []
  const text =
    s.failure ||
    (finished
      ? `${s.purpose === 'check' && s.schemaVersion >= 3 && outcome === 'approved' ? 'Fluxo aprovado' : verdictLabels[outcome]}. ${reasons.length ? reasons.join(' · ') : outcome === 'approved' ? 'Cumpriu os critérios configurados.' : 'Resultados parciais.'}`
      : job.status === 'scheduled'
        ? 'Aguardando horário. Agendamentos sobrepostos entram na fila.'
        : 'Coletando resultados. Critérios provisórios até o encerramento.')
  $('verdict').textContent = text
  $('verdict').className =
    `verdict ${outcome === 'approved' ? 'success' : outcome === 'rejected' ? 'error' : 'pending'}`
  $('cancel').hidden = !['scheduled', 'running', 'stopping'].includes(
    job.status
  )
  const ready =
    finished && (s.reportStatus === 'ready' || (!s.reportStatus && s.csvRows))
  $('xlsx').hidden = !ready
  $('xlsx').href = `/api/runs/${job.id}/xlsx`
  $('regenerate').hidden = !finished || s.reportStatus !== 'error'
  $('report-message').hidden = !s.reportStatus
  $('report-message').textContent =
    s.reportStatus === 'error'
      ? `Não foi possível gerar o XLSX: ${s.reportError}`
      : s.reportStatus === 'ready' && s.reportInfo
        ? `${s.reportInfo.sheets} abas · ${s.reportInfo.charts} gráficos · ${number(s.reportInfo.rows, 0)} tentativas detalhadas · ${number(s.reportInfo.bytes / 1024, 0)} KB`
        : 'Preparando relatório XLSX…'
  $('report-message').classList.toggle('error', s.reportStatus === 'error')
  $('diagnostics').hidden = !job.result
  $('details').textContent = `HTTP: ${Object.entries(s.codes || {})
    .map(([code, n]) => `${code}: ${n}`)
    .join(
      ' · '
    )}\nConexão: ${s.transportErrors || 0} · Validações: ${s.assertionFailures || 0} · Scripts: ${s.scriptFailures || 0} · Execuções: ${s.runFailures || 0}\nAlocados: ${s.active || 0} · Cenários em execução: ${s.busy || 0} · Em pausa: ${s.paused || 0}\nMemória do gerador: ${number(s.rssMB, 0)} MB · CPU do gerador: ${number(s.cpuPercent)}% (100% = 1 núcleo)\nEvent loop principal: ${number(s.eventLoopLagMs)} ms · Workers: ${number(s.workerEventLoopLagMs)} ms\nCarga: ${number(s.loadElapsed)}s · Drenagem: ${number(s.drainElapsed)}s · RPS da carga: ${number(s.loadRps)}\nTentativas interrompidas: ${s.interruptedRequests || 0}`
  $('result-title').textContent = job.name
  $('result-verdict').textContent = text
  $('result-verdict').className = $('verdict').className
  $('result-context').textContent =
    `${s.purpose === 'check' ? 'Verificação funcional de um cenário; não comprova capacidade de carga.' : s.loadModel === 'arrival' ? 'Modelo aberto de chegada de cenários.' : 'Modelo fechado de usuários simultâneos.'} ${s.samples === undefined ? 'Volume de respostas não registrado.' : `${number(s.samples, 0)} respostas com latência.`} Metodologia ${s.methodologyVersion || '1 (histórico)'} · carga ${number(s.loadElapsed)}s · drenagem ${number(s.drainElapsed)}s · RPS global ${number(s.rps)} · RPS da carga ${number(s.loadRps)}. ${$('report-message').textContent}`
  $('result-repeat').hidden = !finished
  $('result-repeat').disabled =
    repeatPending || workspaceBusy || s.reportStatus === 'generating'
  $('result-repeat').textContent = job.canRepeat
    ? 'Executar novamente'
    : 'Escolher teste para repetir'
  $('result-xlsx').hidden = !ready
  $('result-xlsx').href = $('xlsx').href
  $('result-regenerate').hidden = $('regenerate').hidden
  tableBody(
    'criteria-table',
    s.evaluation?.criteria.map((c) => [
      c.label,
      c.observed,
      c.limit,
      s.evaluation.provisional ? 'Provisório' : c.passed ? 'Passou' : 'Falhou',
    ]) || [['Metodologia original', 'Não registrado', '—', 'Consultar XLSX']]
  )
  const evidenceHeaders = $('evidence-table').querySelectorAll('th')
  evidenceHeaders[2].textContent =
    s.loadModel === 'arrival'
      ? 'Chegadas planejadas'
      : 'Usuários-segundo planejados'
  evidenceHeaders[3].textContent =
    s.loadModel === 'arrival'
      ? 'Inícios confirmados'
      : 'Usuários-segundo observados'
  tableBody(
    'evidence-table',
    s.stages?.map((stage) => [
      stage.stage,
      stage.target,
      stage.plannedArrivals !== undefined &&
      selectedJob?.result?.loadModel === 'arrival'
        ? stage.plannedArrivals
        : stage.plannedUserSeconds,
      stage.plannedArrivals !== undefined &&
      selectedJob?.result?.loadModel === 'arrival'
        ? stage.startedArrivals
        : stage.observedUserSeconds,
      stage.loadPercent === null
        ? 'Sem carga'
        : `${number(stage.loadPercent)}%`,
    ]) || [['Não registrado', '—', '—', '—', '—']]
  )
  tableBody(
    'integrity-table',
    s.reportInfo?.integrityDetails?.checks.map((c) => [
      {
        samples: 'Respostas com latência',
        failedRequests: 'Tentativas HTTP com falha',
        transportErrors: 'Falhas de transporte',
        p50: 'p50 (ms)',
        p95: 'p95 (ms)',
        p99: 'p99 (ms)',
        latencySum: 'Soma de latências (ms)',
        requests: 'Tentativas HTTP',
        assertions: 'Validações',
        assertionFailures: 'Validações reprovadas',
        scriptFailures: 'Falhas de scripts',
        runFailures: 'Falhas de execução',
        runs: 'Cenários concluídos',
        startedRequests: 'Tentativas iniciadas',
        startedRuns: 'Cenários iniciados',
        plannedArrivals: 'Chegadas planejadas registradas',
        arrivalDispositions: 'Chegadas confirmadas/descartadas',
        telemetrySamples: 'Amostras de telemetria',
        eventIdentity: 'Identidade e encerramento dos eventos',
        workerBuffers: 'Buffers dos workers',
      }[c.counter] || c.counter,
      c.expected,
      c.recorded,
      c.matches ? 'Confere' : 'Diverge',
    ]) || [['Conferência disponível após a coleta', '—', '—', '—']]
  )
  tableBody(
    'endpoints-table',
    s.reportInfo?.endpoints?.map((e) => [
      e.name,
      e.method,
      e.requests,
      e.failed,
      e.p95,
    ]) || [['Disponível após gerar o relatório', '—', '—', '—', '—']]
  )
  const f = s.reportInfo?.failureCounts || {
    http: Object.entries(s.codes || {}).reduce(
      (n, [code, count]) => n + (Number(code) >= 400 ? count : 0),
      0
    ),
    transport: s.transportErrors || 0,
    validation: s.assertionFailures || 0,
    script: s.scriptFailures || 0,
    run: s.runFailures || 0,
  }
  $('failure-summary').textContent =
    `HTTP: ${f.http} · Transporte: ${f.transport} · Validações: ${f.validation} · Scripts: ${f.script} · Execuções: ${f.run}. A taxa HTTP não soma falhas de validação.`
  if (
    resultTab === 'flow' &&
    !$('flow-results').contains(document.activeElement)
  )
    renderSteps(job)
  $('executive-summary').textContent =
    `${number(s.requests, 0)} tentativas · throughput da carga ${number(s.loadRps)} req/s · ${number(s.scenarios?.p95)} ms de p95 por cenário · ${s.evaluation?.reasons.length || 0} motivos de atenção. Aprovação vale para o cenário, os limites e o ambiente desta execução.`
  comparisonOptions.set(job.id, job.name)
  renderComparisonOptions()
}
$('cancel').onclick = async () => {
  try {
    await api(`/api/runs/${selected}/cancel`, {})
    await refresh()
  } catch (e) {
    showError(e)
  }
}
$('regenerate').onclick = async () => {
  if (!selected) return
  const id = selected
  $('regenerate').disabled = $('result-regenerate').disabled = true
  try {
    await api(`/api/runs/${id}/regenerate`, {})
    await refresh()
  } catch (e) {
    $('report-message').hidden = false
    $('report-message').textContent = e.message
    $('result-context').textContent = e.message
  } finally {
    $('regenerate').disabled = $('result-regenerate').disabled = false
  }
}
$('result-regenerate').onclick = () => $('regenerate').click()
$('result-repeat').onclick = () => {
  if (selectedJob?.canRepeat) $('repeat').click()
  else {
    location.hash = '#monitor'
    $('repeat-template').focus()
  }
}
function renderComparisonOptions() {
  const signature = JSON.stringify([...comparisonOptions])
  const select = $('compare-baseline')
  if (select.dataset.signature === signature) return
  select.dataset.signature = signature
  const previous = select.value
  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = 'Selecione uma execução do histórico'
  select.replaceChildren(
    placeholder,
    ...[...comparisonOptions].map(([id, name]) => {
      const o = document.createElement('option')
      o.value = id
      o.textContent = `${name} · ${id.slice(0, 8)}`
      return o
    })
  )
  select.value = previous
}
function simpleTable(headers, rows) {
  const table = document.createElement('table'),
    head = document.createElement('thead'),
    tr = document.createElement('tr')
  headers.forEach((label) => {
    const th = document.createElement('th')
    th.textContent = label
    tr.append(th)
  })
  head.append(tr)
  table.append(head)
  const body = document.createElement('tbody')
  rows.forEach((values) => {
    const r = document.createElement('tr')
    values.forEach((value) => {
      const td = document.createElement('td')
      td.textContent =
        typeof value === 'object' && value !== null
          ? JSON.stringify(value)
          : number(value)
      r.append(td)
    })
    body.append(r)
  })
  table.append(body)
  return table
}
$('compare-runs').onclick = async () => {
  const baseline = $('compare-baseline').value,
    id = selected
  if (!baseline || !id || baseline === id) {
    $('comparison-note').textContent =
      'Selecione uma referência diferente da execução atual.'
    return
  }
  try {
    const data = await api(
      `/api/runs/compare?left=${encodeURIComponent(baseline)}&right=${encodeURIComponent(id)}`
    )
    if (id !== selected) return
    $('comparison-note').textContent = !data.compatible
      ? `Comparação com ressalvas. Configurações diferentes: ${data.differences.map((d) => d.field).join(', ')}. Considere essas diferenças ao interpretar as métricas.`
      : 'As configurações registradas são iguais. Variações não comprovam causalidade.'
    $('comparison-output').replaceChildren(
      simpleTable(
        ['Métrica', 'Referência', 'Selecionada', 'Diferença', 'Variação (%)'],
        data.metrics.map((m) => [
          {
            requests: 'Tentativas HTTP',
            samples: 'Respostas com latência',
            rps: 'Média global (req/s)',
            loadRps: 'Carga (req/s)',
            p95: 'p95 (ms)',
            p99: 'p99 (ms)',
            errorRate: 'Falhas (%)',
          }[m.field] || m.field,
          m.left,
          m.right,
          m.delta,
          m.percent,
        ])
      ),
      simpleTable(
        ['Configuração diferente', 'Referência', 'Selecionada'],
        data.differences.map((d) => [d.field, d.left, d.right])
      )
    )
  } catch (e) {
    $('comparison-note').textContent = e.message
  }
}
const baseGraphSpecs = [
  {
    key: 'active',
    label: 'Usuários observados / último alvo',
    unit: 'usuários',
    target: true,
  },
  { key: 'rps', label: 'RPS por janela', unit: 'req/s' },
  { key: 'p95', label: 'p95 por janela', unit: 'ms' },
  {
    key: 'errorRate',
    label: 'Falhas HTTP / conexão',
    unit: '%',
    percent: true,
  },
  { key: 'successRps', label: 'Sucessos HTTP por janela', unit: 'req/s' },
  {
    key: 'scenarioRps',
    label: 'Cenários concluídos por janela',
    unit: 'cenários/s',
  },
]
function svgElement(name, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', name)
  Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value))
  return el
}
function renderCharts(data) {
  const arrival = selectedJob?.result?.loadModel === 'arrival'
  const graphSpecs = baseGraphSpecs.map((spec) =>
    spec.key === 'active'
      ? {
          ...spec,
          target: !arrival,
          label: arrival ? 'Usuários alocados (modelo de chegada)' : spec.label,
        }
      : spec
  )
  if (arrival)
    graphSpecs.push({
      key: 'startedScenarioRps',
      label: 'Cenários iniciados/s e taxa alvo',
      unit: 'cenários/s',
      target: true,
    })
  const container = $('metric-charts')
  if (container.dataset.model !== String(arrival)) {
    container.replaceChildren()
    container.dataset.model = String(arrival)
  }
  if (!container.children.length)
    for (const spec of graphSpecs) {
      const card = document.createElement('section')
      card.className = 'metric-chart'
      card.dataset.metric = spec.key
      const title = document.createElement('h3')
      title.textContent = spec.label
      const svg = svgElement('svg', {
        viewBox: '0 0 640 190',
        role: 'img',
        'aria-label': spec.label,
      })
      const readout = document.createElement('p')
      readout.className = 'chart-readout'
      readout.setAttribute('aria-live', 'polite')
      const slider = document.createElement('input')
      slider.type = 'range'
      slider.min = 0
      slider.setAttribute('aria-label', `Consultar janela: ${spec.label}`)
      card.append(title, svg, readout, slider)
      container.append(card)
    }
  for (const spec of graphSpecs) {
    const card = container.querySelector(`[data-metric="${spec.key}"]`),
      svg = card.querySelector('svg'),
      slider = card.querySelector('input')
    const val = (p) => (spec.percent ? p[spec.key] * 100 : p[spec.key])
    const maximum = Math.max(
      1,
      ...data.map((p) => val(p) || 0),
      ...(spec.target ? data.map((p) => p.target || 0) : [])
    )
    const end = data.length
      ? data[data.length - 1].second + data[data.length - 1].duration
      : 1
    const x = (second) => 45 + (second / end) * 580,
      y = (value) => 155 - (value / maximum) * 130
    const children = []
    if (data.length) {
      for (const [from, to, label, color] of [
        [
          0,
          (seriesPhases.loadStartedAt - data[0].ts) / 1000,
          'Aquecimento',
          '#75693c',
        ],
        [
          (seriesPhases.loadEndedAt - data[0].ts) / 1000,
          end,
          'Drenagem',
          '#455e83',
        ],
      ]) {
        if (
          Number.isFinite(from) &&
          Number.isFinite(to) &&
          to > from &&
          from < end
        ) {
          const a = Math.max(0, from),
            b = Math.min(end, to)
          children.push(
            svgElement('rect', {
              x: x(a),
              y: 22,
              width: Math.max(0, x(b) - x(a)),
              height: 133,
              fill: color,
              opacity: 0.15,
            })
          )
          const text = svgElement('text', {
            x: x(a) + 3,
            y: 34,
            fill: '#c0cad7',
            'font-size': 11,
          })
          text.textContent = label
          children.push(text)
        }
      }
    }
    for (const stage of selectedJob?.result?.stages || [])
      if (stage.startedAt && data.length) {
        const offset = (stage.startedAt - data[0].ts) / 1000
        if (offset >= 0 && offset <= end) {
          children.push(
            svgElement('line', {
              x1: x(offset),
              x2: x(offset),
              y1: 20,
              y2: 155,
              stroke: '#6a8098',
              'stroke-dasharray': '3 4',
            })
          )
          const label = svgElement('text', {
            x: x(offset) + 3,
            y: 16,
            fill: '#b2c2d3',
            'font-size': 11,
          })
          label.textContent = `E${stage.stage}`
          children.push(label)
        }
      }
    for (let i = 0; i < 3; i++) {
      const value = (maximum * i) / 2
      children.push(
        svgElement('line', {
          x1: 45,
          x2: 625,
          y1: y(value),
          y2: y(value),
          stroke: '#3d4651',
        })
      )
      const label = svgElement('text', {
        x: 40,
        y: y(value) + 4,
        'text-anchor': 'end',
        fill: '#c0cad7',
        'font-size': 12,
      })
      label.textContent = number(value, 1)
      children.push(label)
    }
    const path = (key) => {
      let segment = false
      return data
        .map((p) => {
          const value = key === 'target' ? p.target : val(p)
          if (value === null || value === undefined) {
            segment = false
            return ''
          }
          const command = segment ? (key === 'target' ? 'H' : 'L') : 'M'
          const part =
            command === 'H'
              ? `H ${x(p.second)} V ${y(value)}`
              : `${command} ${x(p.second)} ${y(value)}`
          segment = true
          return part
        })
        .join(' ')
    }
    children.push(
      svgElement('path', {
        d: path(spec.key),
        fill: 'none',
        stroke: '#c0f780',
        'stroke-width': 2.5,
      })
    )
    if (spec.target)
      children.push(
        svgElement('path', {
          d: path('target'),
          fill: 'none',
          stroke: '#8fb9ef',
          'stroke-width': 2,
          'stroke-dasharray': '5 4',
        })
      )
    // A singleton M path has no visible line. Preserve isolated observations.
    for (const key of [spec.key, ...(spec.target ? ['target'] : [])]) {
      const valid = data.filter((p) =>
        Number.isFinite(key === 'target' ? p.target : val(p))
      )
      if (valid.length === 1) {
        const p = valid[0]
        children.push(
          svgElement('circle', {
            cx: x(p.second),
            cy: y(key === 'target' ? p.target : val(p)),
            r: 4,
            fill: key === 'target' ? '#8fb9ef' : '#c0f780',
          })
        )
      }
    }
    for (const [second, anchor] of [
      [0, 'start'],
      [end, 'end'],
    ]) {
      const label = svgElement('text', {
        x: x(second),
        y: 181,
        'text-anchor': anchor,
        fill: '#c0cad7',
        'font-size': 12,
      })
      label.textContent = `${number(second, 1)}s`
      children.push(label)
    }
    svg.replaceChildren(...children)
    slider.disabled = !data.length
    slider.max = Math.max(0, data.length - 1)
    if (slider.dataset.run !== selected) {
      slider.value = slider.max
      slider.dataset.run = selected
    } else if (document.activeElement !== slider) slider.value = slider.max
    const display = (index) => {
      const p = data[index]
      card.querySelector('.chart-readout').textContent = p
        ? `${new Date(p.ts).toLocaleTimeString('pt-BR')} · ${number(p.second, 1)}–${number(p.second + p.duration, 1)}s: ${number(val(p))} ${spec.unit}${spec.target ? ` · alvo ${number(p.target)}` : ''}${p.partial ? ' · janela parcial' : ''}${spec.key === 'p95' ? ` · ${number(p.samples, 0)} respostas` : ''}`
        : 'Aguardando dados registrados.'
    }
    slider.oninput = () => display(Number(slider.value))
    display(Number(slider.value))
    svg.onpointermove = (event) => {
      if (!data.length) return
      const rect = svg.getBoundingClientRect(),
        second = Math.max(
          0,
          Math.min(
            end,
            ((((event.clientX - rect.left) / rect.width) * 640 - 45) / 580) *
              end
          )
        )
      const index = Math.min(
        data.length - 1,
        data.findIndex((p) => p.second + p.duration > second)
      )
      display(index < 0 ? data.length - 1 : index)
    }
  }
}
renderCharts([])
function renderHistory(data) {
  workspaceBusy = data.overview.busy === true
  executionAvailability()
  runs = data.items
  const signature = JSON.stringify([runs, selected, historyPage, data.total])
  $('count').textContent = `${data.total} execuções`
  $('nav-count').textContent = data.overview.total
  $('overview-total').textContent = data.overview.total
  $('overview-completed').textContent = data.overview.completed
  $('overview-scheduled').textContent = data.overview.scheduled
  $('history-page').textContent =
    `Página ${historyPage} de ${Math.max(1, Math.ceil(data.total / data.pageSize))}`
  $('history-prev').disabled = historyPage === 1
  $('history-next').disabled = historyPage * data.pageSize >= data.total
  for (const job of runs) comparisonOptions.set(job.id, job.name)
  renderComparisonOptions()
  if (signature === historySignature) return
  historySignature = signature
  const focused = document.activeElement?.closest('.history-row')?.dataset.id
  $('history').replaceChildren(
    ...runs.map((job) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'history-row'
      button.dataset.id = job.id
      button.dataset.status = job.status
      button.setAttribute('aria-current', String(selected === job.id))
      const title = document.createElement('strong')
      title.textContent = job.name
      const info = document.createElement('span')
      info.textContent = `${new Date(job.scheduledAt).toLocaleString('pt-BR')}${job.result?.purpose === 'check' ? ' · Verificação' : ''}`
      const symbol = document.createElement('span')
      symbol.className = 'history-symbol'
      symbol.append(
        icon(
          job.status === 'scheduled'
            ? 'clock'
            : job.status === 'completed'
              ? 'shield'
              : 'pulse'
        )
      )
      const content = document.createElement('div')
      content.className = 'history-text'
      content.append(title, info)
      const badge = document.createElement('span'),
        outcome = verdict(job)
      badge.className = `badge ${outcome === 'approved' ? 'completed' : outcome === 'rejected' ? 'failed' : 'scheduled'}`
      badge.textContent = ['completed', 'failed', 'cancelled'].includes(
        job.status
      )
        ? verdictLabels[outcome]
        : labels[job.status] || job.status
      button.append(symbol, content, badge)
      button.onclick = () => {
        selectRun(job.id)
        location.hash = ['running', 'stopping', 'scheduled'].includes(
          job.status
        )
          ? '#monitor'
          : '#results-panel'
        refresh().catch(showError)
      }
      return button
    })
  )
  if (!runs.length) {
    const empty = document.createElement('p')
    empty.className = 'empty-history'
    empty.textContent = data.overview.total
      ? 'Nenhuma execução corresponde aos filtros.'
      : 'Seu histórico começa com a primeira execução.'
    $('history').append(empty)
  }
  if (focused)
    $('history')
      .querySelector(`[data-id="${focused}"]`)
      ?.focus({ preventScroll: true })
}
async function refresh() {
  const sequence = ++refreshSequence
  const query = new URLSearchParams({
    page: String(historyPage),
    pageSize: '20',
    q: $('history-search').value,
    status: $('history-status').value,
  })
  const data = await api(`/api/runs?${query}`)
  if (sequence !== refreshSequence) return
  renderHistory(data)
  if (Date.now() - lastLibraryRefresh > 10000) {
    await refreshLibrary()
    lastLibraryRefresh = Date.now()
  }
  if (!selected && data.items.length) selectRun(data.items[0].id)
  if (!selected) return
  const id = selected
  let job
  try {
    job = await api(`/api/runs/${encodeURIComponent(id)}`)
  } catch (e) {
    if (id === selected) {
      selected = undefined
      sessionStorage.removeItem('stress-selected')
    }
    throw e
  }
  if (id !== selected || sequence !== refreshSequence) return
  render(job)
  const key = `${job.id}:${job.status}:${job.result?.reportStatus}`
  if (seriesKey !== key || ['running', 'stopping'].includes(job.status)) {
    const from = points.length
      ? points[Math.max(0, points.length - 2)].ts
      : undefined
    const data = await api(
      `/api/runs/${id}/series${from !== undefined ? `?from=${from}&interval=${seriesInterval || 1}` : ''}`
    )
    if (id !== selected) return
    points =
      from !== undefined && !data.reset
        ? [...points.filter((p) => p.ts < from), ...(data.points || [])]
        : data.points || []
    seriesInterval = data.interval
    seriesPhases = data.phases || {}
    seriesKey = key
    renderCharts(points)
    $('series-message').textContent =
      data.available === false
        ? data.reason
        : `${points.length} janelas persistidas · consultas por horário real. Verde: observado; azul tracejado: alvo.`
  }
}
let searchTimer
$('history-search').oninput = () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    historyPage = 1
    refresh().catch(showError)
  }, 250)
}
$('history-status').onchange = () => {
  historyPage = 1
  refresh().catch(showError)
}
$('history-prev').onclick = () => {
  historyPage = Math.max(1, historyPage - 1)
  refresh().catch(showError)
}
$('history-next').onclick = () => {
  historyPage++
  refresh().catch(showError)
}
async function poll() {
  try {
    await refresh()
    $('connection').classList.remove('offline')
    $('connection-label').textContent = 'Servidor conectado'
  } catch (e) {
    $('connection').classList.add('offline')
    $('connection-label').textContent = 'Servidor desconectado'
    if (selectedJob?.result) renderMetrics(selectedJob.result)
  } finally {
    setTimeout(poll, 1000)
  }
}
poll()

function parseCSV(text) {
  const rows = []
  let row = [],
    cell = '',
    quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"'
        i++
      } else quoted = !quoted
    } else if (c === ',' && !quoted) {
      row.push(cell)
      cell = ''
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      if (row.some((v) => v !== '')) rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (quoted) throw new Error('CSV com aspas não encerradas')
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  const headers = rows.shift()?.map((v) => v.trim().replace(/^\uFEFF/, ''))
  if (!headers?.length || new Set(headers).size !== headers.length)
    throw new Error('CSV exige cabeçalhos únicos')
  return rows.map((values) => {
    if (values.length !== headers.length)
      throw new Error('CSV com quantidade de colunas inconsistente')
    return Object.fromEntries(headers.map((key, i) => [key.trim(), values[i]]))
  })
}
$('dataset-file').onchange = async () => {
  try {
    const file = $('dataset-file').files[0]
    if (!file) return
    if (file.size > 5 * 1024 * 1024) throw new Error('Dados excedem 5 MB')
    const text = await file.text(),
      rows = file.name.endsWith('.csv') ? parseCSV(text) : JSON.parse(text)
    if (!Array.isArray(rows) || !rows.length)
      throw new Error('Informe um array JSON ou CSV com linhas')
    flowEditor.checkpoint()
    flowEditor.flow.dataset = {
      rows,
      select: $('dataset-select').value,
      exhaustion: $('dataset-exhaustion').value,
    }
    $('dataset-note').textContent =
      rows.length + ' linhas. Use {{NOME_DA_COLUNA}} nos blocos.'
    flowEditor.changed()
  } catch (error) {
    $('dataset-note').textContent = error.message
  }
}
$('dataset-clear').onclick = () => {
  flowEditor.checkpoint()
  delete flowEditor.flow.dataset
  $('dataset-file').value = ''
  $('dataset-note').textContent = 'Dados removidos'
  flowEditor.changed()
}
document
  .querySelectorAll('.form-section')
  .forEach(
    (section, index) => (section.dataset.createSection = String(index + 1))
  )
function createPage(index) {
  $('form').dataset.createPage = String(index)
  for (const button of document.querySelectorAll('[data-create-step]'))
    button.setAttribute(
      'aria-current',
      Number(button.dataset.createStep) === index ? 'step' : 'false'
    )
  $('creation-review').hidden = index !== 3
  $('creation-progress').textContent = `Etapa ${index + 1} de 4`
  $('creation-prev').disabled = index === 0
  $('creation-next').hidden = index === 3
  $('creation-next').textContent =
    index === 2 ? 'Revisar configuração' : 'Próxima'
}
createPage(0)
async function navigateCreation(index) {
  if (index === 3) {
    try {
      const input = await collectInput()
      await api('/api/validate', input)
      const target = $('creation-review')
      target.replaceChildren()
      const title = document.createElement('h3')
      title.textContent = 'Revisão do cenário'
      let requests = 0
      flowEditor.walk(input.scenario.steps, (n) => {
        if (n.type === 'request') requests++
      })
      const details = document.createElement('p')
      details.textContent = `${requests} blocos HTTP · ${input.scenario.setup.length} de preparação global · ${input.scenario.perUser.length} de preparação por usuário · ${input.scenario.teardown.length} de limpeza.`
      const load = document.createElement('p')
      load.textContent = `${input.stages.reduce((sum, s) => sum + s.durationSec, 0)} segundos de carga · ${input.loadModel === 'arrival' ? 'Taxa de chegada (jornadas/s)' : 'Usuários concorrentes'} · p95 HTTP ${input.thresholds.p95} ms · falhas máximas ${input.thresholds.errorRate}% · amostra ${input.evidence.minResponses} por estágio.`
      const note = document.createElement('p')
      note.textContent =
        'Configuração validada sem tráfego. Confira a jornada com Executar uma vez antes de aplicar carga.'
      target.append(title, details, load, note)
    } catch (error) {
      showError(error)
      return
    }
  }
  createPage(index)
  const active = document.querySelector(`[data-create-step="${index}"]`)
  active.focus({ preventScroll: true })
  active.scrollIntoView({ block: 'nearest' })
}
for (const button of document.querySelectorAll('[data-create-step]'))
  button.onclick = () => navigateCreation(Number(button.dataset.createStep))
$('creation-prev').onclick = () =>
  navigateCreation(Number($('form').dataset.createPage) - 1)
$('creation-next').onclick = () =>
  navigateCreation(Number($('form').dataset.createPage) + 1)
let resultTab = 'summary'
function resultTabs() {
  const flow = resultTab === 'flow',
    failures = resultTab === 'failures',
    generator = resultTab === 'generator'
  $('flow-results').hidden = !flow
  $('event-results').hidden = !failures
  for (const el of document.querySelectorAll('#results-panel .result-section'))
    el.hidden =
      flow || failures || (generator && el.querySelector('#criteria-table'))
  $('executive-summary').hidden = flow || failures
  for (const b of document.querySelectorAll('[data-result-tab]'))
    b.setAttribute('aria-pressed', String(b.dataset.resultTab === resultTab))
}
let resultStage = ''
function renderSteps(job) {
  const root = $('flow-results')
  root.replaceChildren()
  const title = document.createElement('h3')
  title.textContent = 'Jornada e passos percorridos'
  root.append(title)
  const filter = document.createElement('select')
  filter.setAttribute('aria-label', 'Estágio dos passos')
  for (const stage of [
    { stage: '', label: 'Todos os estágios' },
    ...(job.result?.stages || []).map((s) => ({
      stage: s.stage,
      label: 'Estágio ' + s.stage,
    })),
  ]) {
    const option = document.createElement('option')
    option.value = stage.stage
    option.textContent = stage.label
    filter.append(option)
  }
  filter.value = resultStage
  filter.onchange = () => {
    resultStage = filter.value
    renderSteps(job)
  }
  root.append(filter)
  const stats = resultStage
      ? job.result?.stepStages || []
      : job.result?.steps || [],
    steps = new Map(
      stats
        .filter((s) => !resultStage || s.stage === Number(resultStage))
        .map((s) => [s.nodeId, s])
    )
  const graph = document.createElement('div')
  graph.className = 'result-flow-graph'
  const blocks = new Map()
  for (const node of job.result?.flow || []) {
    const step = steps.get(node.id),
      row = document.createElement('div')
    row.className =
      'step-outcome' +
      (step?.failed
        ? ' failed'
        : !step?.recordedExecutions && !step?.requests
          ? ' skipped'
          : '')
    row.dataset.nodeId = node.id
    const name = document.createElement('strong')
    name.textContent = `${{ request: 'HTTP', condition: 'SE', loop: 'LOOP', pause: 'PAUSA', group: 'GRUPO' }[node.type] || node.type} · ${node.name}`
    const info = document.createElement('p')
    info.textContent = step
      ? `${step.recordedExecutions ?? step.requests} execuções · ${step.requests} avaliadas · ${step.failed} falhas funcionais · ${step.skipped} ignorados · p95 ${number(step.p95)} ms`
      : 'Sem execução registrada para este passo.'
    const context = document.createElement('small')
    context.textContent = `${node.phase === 'steps' ? 'Jornada' : node.phase === 'perUser' ? 'Preparação por usuário' : node.phase === 'setup' ? 'Preparação global' : 'Limpeza global'}${node.branch === 'then' ? ' · se verdadeiro' : node.branch === 'else' ? ' · se falso' : ''}${node.dependsOn?.length ? ' · usa ' + node.dependsOn.join(', ') : ''}`
    const view = document.createElement('button')
    view.type = 'button'
    view.textContent = 'Ver eventos deste passo'
    view.onclick = () => loadEvents(job.id, node.id)
    row.append(name, context, info, view)
    blocks.set(node.id, row)
    ;(blocks.get(node.parent) || graph).append(row)
  }
  if (!blocks.size) {
    const p = document.createElement('p')
    p.textContent = 'Esta execução não possui registros de fluxo.'
    graph.append(p)
  }
  root.append(graph)
  if (job.result?.scenarios) {
    const p = document.createElement('p')
    p.textContent = `Jornadas concluídas: ${job.result.runs || 0} · reprovadas: ${job.result.failedRuns || 0} · p95 ${number(job.result.scenarios.p95)} ms`
    root.prepend(p)
  }
}
let eventsRequest = 0
async function loadEvents(id, nodeId, page = 1) {
  const request = ++eventsRequest
  const root = $('event-results')
  root.replaceChildren()
  try {
    const data = await api(
      `/api/runs/${id}/events?page=${page}&pageSize=50${nodeId ? '&nodeId=' + encodeURIComponent(nodeId) : '&category=failures'}`
    )
    if (request !== eventsRequest || selectedJob?.id !== id) return
    const heading = document.createElement('h3')
    heading.textContent = nodeId
      ? 'Eventos do passo'
      : 'Falhas e eventos da jornada'
    root.append(heading)
    const items = data.items
    for (const event of items) {
      const p = document.createElement('p')
      p.className = 'step-outcome'
      p.textContent = `${event.type} · ${event.name || event.runId || ''} · ${event.message || event.reason || (event.variable ? event.variable + ' = ' + event.value : '')} · ${new Date(event.ts).toLocaleTimeString('pt-BR')}`
      root.append(p)
    }
    const prev = document.createElement('button'),
      next = document.createElement('button')
    prev.type = next.type = 'button'
    prev.textContent = 'Anterior'
    next.textContent = 'Próxima'
    prev.disabled = page === 1
    next.disabled = page * 50 >= data.total
    prev.onclick = () => loadEvents(id, nodeId, page - 1)
    next.onclick = () => loadEvents(id, nodeId, page + 1)
    root.append(prev, next)
    if (!data.available) {
      const p = document.createElement('p')
      p.textContent =
        'Eventos indisponíveis ou retenção expirada. Consulte o XLSX.'
      root.append(p)
    }
    resultTab = 'failures'
    resultTabs()
  } catch (error) {
    root.textContent = error.message
  }
}
for (const button of document.querySelectorAll('[data-result-tab]'))
  button.onclick = () => {
    resultTab = button.dataset.resultTab
    resultTabs()
    if (selectedJob) {
      if (resultTab === 'flow') renderSteps(selectedJob)
      if (resultTab === 'failures') loadEvents(selectedJob.id)
    }
  }
api('/api/engine')
  .then((engine) => {
    $('methodology-note').textContent = engine.available
      ? `${engine.version} · Metodologia 4.0`
      : engine.message
  })
  .catch(() => {})

const comparisonDownload = document.createElement('a')
comparisonDownload.textContent = 'Baixar comparação XLSX'
comparisonDownload.id = 'comparison-xlsx'
comparisonDownload.hidden = true
document.querySelector('.comparison-controls').append(comparisonDownload)
$('compare-baseline').addEventListener('change', () => {
  comparisonDownload.hidden = true
})
$('compare-runs').addEventListener('click', () => {
  if (selected && $('compare-baseline').value) {
    comparisonDownload.href =
      '/api/runs/compare/xlsx?left=' +
      encodeURIComponent($('compare-baseline').value) +
      '&right=' +
      encodeURIComponent(selected)
    comparisonDownload.hidden = false
  }
})
