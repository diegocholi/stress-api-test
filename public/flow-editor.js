/* A structured tree is shared by the accessible list, graph and inspector. */
window.FlowEditor = class FlowEditor {
  constructor(root, onChange) {
    this.root = root
    this.onChange = onChange
    this.flow = { steps: [], setup: [], perUser: [], teardown: [] }
    this.phase = 'steps'
    this.selected = null
    this.history = []
    this.future = []
    this.view = 'graph'
    this.inspectorOpen = false
    this.zoom = 1
    const bar = document.createElement('div')
    bar.className = 'flow-toolbar'
    bar.innerHTML =
      '<label>Fase<select id="flow-phase"><option value="steps">Jornada</option><option value="setup">Preparação global</option><option value="perUser">Preparação por usuário</option><option value="teardown">Limpeza global</option></select></label><div class="flow-view"><button type="button" id="flow-list">Lista</button><button type="button" id="flow-graph">Fluxograma</button></div><button type="button" id="flow-undo" aria-label="Desfazer">↶</button><button type="button" id="flow-redo" aria-label="Refazer">↷</button>'
    root.before(bar)
    this.bar = bar
    this.canvas = document.createElement('div')
    this.canvas.id = 'flow-canvas'
    this.canvas.className = 'flow-canvas'
    this.canvas.hidden = true
    root.after(this.canvas)
    const controls = document.createElement('div')
    controls.className = 'flow-add-controls'
    controls.innerHTML =
      '<label>Tipo de bloco<select id="flow-kind"><option value="request">Requisição HTTP</option><option value="condition">Condição</option><option value="loop">Repetição</option><option value="pause">Pausa</option><option value="group">Grupo / transação</option></select></label><button type="button" id="flow-add">Adicionar bloco</button><button type="button" id="flow-fit">Ajustar fluxograma</button><label>Zoom<input id="flow-zoom" type="range" min="50" max="150" value="100"></label>'
    this.canvas.after(controls)
    this.controls = controls
    this.layout = document.createElement('div')
    this.layout.className = 'flow-layout'
    this.bar.after(this.layout)
    this.graphPanel = document.createElement('section')
    this.graphPanel.className = 'flow-graph-panel'
    this.graphPanel.hidden = true
    this.graphPanel.innerHTML =
      '<div class="flow-canvas-tools"><strong>Construa sua jornada</strong><div><button type="button" data-graph-fit>Ajustar fluxograma</button><label>Zoom <input data-graph-zoom type="range" min="20" max="150" value="100"><output>100%</output></label></div></div><p class="flow-guide">Arraste pela alça para mover · Use + para adicionar · Clique no bloco para configurar</p>'
    this.graphPanel.append(this.canvas)
    this.layout.append(this.graphPanel, this.root)
    this.graphPanel.querySelector('[data-graph-fit]').onclick = () => this.fit()
    this.graphPanel.querySelector('[data-graph-zoom]').oninput = (event) => {
      this.zoom = Number(event.target.value) / 100
      this.draw()
    }
    this.status = document.createElement('p')
    this.status.className = 'flow-feedback'
    this.status.setAttribute('role', 'status')
    this.status.setAttribute('aria-live', 'polite')
    this.graphPanel.append(this.status)
    document.addEventListener('pointerdown', (event) => {
      if (
        this.menu &&
        !this.menu.contains(event.target) &&
        !this.menuAnchor?.contains(event.target)
      )
        this.closeMenu(false)
    })
    window.addEventListener('resize', () => this.positionMenu())
    window.addEventListener('scroll', () => this.positionMenu(), true)
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.closeMenu()
    })
    this.layout.after(controls)
    bar.querySelector('#flow-phase').onchange = (e) => {
      this.closeInspector(false, false)
      this.phase = e.target.value
      this.selected = null
      this.render()
    }
    bar.querySelector('#flow-list').onclick = () => this.setView('list')
    bar.querySelector('#flow-graph').onclick = () => this.setView('graph')
    bar.querySelector('#flow-undo').onclick = () => this.undo()
    bar.querySelector('#flow-redo').onclick = () => this.redo()
    controls.querySelector('#flow-add').onclick = () =>
      this.add(controls.querySelector('select').value)
    controls.querySelector('#flow-fit').onclick = () => {
      this.zoom = 1
      controls.querySelector('input').value = 100
      this.draw()
    }
    controls.querySelector('input').oninput = (e) => {
      this.zoom = e.target.value / 100
      this.draw()
    }
  }
  id() {
    return crypto.randomUUID()
  }
  walk(nodes, fn) {
    for (const n of nodes) {
      fn(n)
      for (const key of ['children', 'then', 'else'])
        if (n[key]) this.walk(n[key], fn)
    }
  }
  find(id) {
    let found
    for (const key of ['steps', 'setup', 'perUser', 'teardown'])
      this.walk(this.flow[key], (n) => {
        if (n.id === id) found = n
      })
    return found
  }
  locate(id, nodes = this.flow[this.phase]) {
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].id === id) return { nodes, index: i }
      for (const key of ['children', 'then', 'else'])
        if (nodes[i][key]) {
          const found = this.locate(id, nodes[i][key])
          if (found) return found
        }
    }
  }
  checkpoint() {
    this.history.push(JSON.stringify(this.flow))
    if (this.history.length > 60) this.history.shift()
    this.future = []
  }
  changed() {
    this.onChange()
    this.buttons()
    if (this.view === 'graph') {
      const node = this.find(this.selected)
      const heading = this.inspectorDialog?.querySelector(
        '.flow-inspector-card h3'
      )
      const path = this.inspectorDialog?.querySelector('.flow-location')
      if (node && heading) heading.textContent = node.name || 'Configurar bloco'
      if (node && path)
        path.textContent =
          this.destinations().find((entry) => entry.nodes.includes(node))
            ?.label || ''
    }
    this.draw()
  }
  buttons() {
    this.bar.querySelector('#flow-undo').disabled = !this.history.length
    this.bar.querySelector('#flow-redo').disabled = !this.future.length
  }
  undo() {
    if (!this.history.length) return
    this.future.push(JSON.stringify(this.flow))
    this.flow = JSON.parse(this.history.pop())
    this.render()
    this.changed()
  }
  redo() {
    if (!this.future.length) return
    this.history.push(JSON.stringify(this.flow))
    this.flow = JSON.parse(this.future.pop())
    this.render()
    this.changed()
  }
  load(scenario = {}) {
    this.closeInspector(false, false)
    this.flow = structuredClone({
      ...scenario,
      steps: scenario.steps || [],
      setup: scenario.setup || [],
      perUser: scenario.perUser || [],
      teardown: scenario.teardown || [],
    })
    for (const key of ['steps', 'setup', 'perUser', 'teardown'])
      this.walk(this.flow[key], (n) => {
        n.id ||= this.id()
        n.type ||= 'request'
        n.checks ||= []
        n.extracts ||= []
        if (n.type === 'request') this.restoreSimpleRules(n)
        if (n.type === 'condition') {
          n.then ||= []
          n.else ||= []
        }
        if (['loop', 'group'].includes(n.type)) n.children ||= []
      })
    this.history = []
    this.future = []
    this.selected = this.flow.steps[0]?.id
    this.phase = 'steps'
    this.bar.querySelector('select').value = 'steps'
    this.render()
  }
  restoreSimpleRules(node) {
    // Saved flows use canonical rules; restore the inspector's simple fields.
    const restore = (key, field, matches, value) => {
      const rule = node[key].find(matches)
      if (!rule) return
      node[field] ??= value(rule)
      const simple = value(rule)
      if (JSON.stringify(node[field]) !== JSON.stringify(simple)) return
      node[key] = node[key].filter(
        (candidate) =>
          !matches(candidate) ||
          JSON.stringify(value(candidate)) !== JSON.stringify(simple)
      )
    }
    restore(
      'checks',
      'expectedStatus',
      (r) => r.source === 'status' && r.operator === 'equals',
      (r) => r.value
    )
    restore(
      'checks',
      'contains',
      (r) => r.source === 'text' && r.operator === 'contains',
      (r) => r.value
    )
    restore(
      'checks',
      'jsonCheck',
      (r) => r.source === 'json' && r.operator === 'equals',
      (r) => ({ path: r.path, value: r.value })
    )
    // Additional extractions can match the simple fields; preserve their placement.
    restore(
      'extracts',
      'extract',
      (r) =>
        r.editorField === 'extract' &&
        r.source === 'json' &&
        (r.scope || 'journey') === 'journey' &&
        !r.secret,
      (r) => ({ source: 'json', path: r.path, variable: r.variable })
    )
  }
  value() {
    return structuredClone(this.flow)
  }
  add(
    type = 'request',
    target,
    index = target?.length,
    { configure = true } = {}
  ) {
    if (this.view === 'graph') {
      const destination = this.destinations().find(
        (entry) => entry.nodes === (target || this.flow[this.phase])
      )
      if (
        !destination ||
        destination.depth +
          (['loop', 'group', 'condition'].includes(type) ? 1 : 0) >
          10
      ) {
        this.announce(
          'Este ponto ultrapassa a profundidade máxima de 10 níveis.'
        )
        return
      }
    }
    this.checkpoint()
    const node = {
      id: this.id(),
      type,
      name:
        type === 'request'
          ? 'Requisição'
          : {
              condition: 'Condição',
              loop: 'Repetição',
              pause: 'Pausa',
              group: 'Transação',
            }[type],
      ...(type === 'request'
        ? {
            method: 'GET',
            url: '',
            headers: [],
            bodyType: 'none',
            body: '',
            expectedStatus: 200,
            checks: [],
            extracts: [],
          }
        : type === 'pause'
          ? { ms: 1000 }
          : type === 'condition'
            ? {
                condition: { variable: '', operator: 'exists' },
                then: [],
                else: [],
              }
            : type === 'loop'
              ? { mode: 'count', limit: 10, children: [] }
              : { children: [] }),
    }
    const nodes = target || this.flow[this.phase]
    nodes.splice(index ?? nodes.length, 0, node)
    this.selected = node.id
    this.render()
    this.changed()
    if (this.view === 'graph' && configure) this.openInspector()
    return node
  }
  select(id) {
    this.selected = id
    for (const phase of ['steps', 'setup', 'perUser', 'teardown']) {
      let has = false
      this.walk(this.flow[phase], (n) => {
        if (n.id === id) has = true
      })
      if (has) this.phase = phase
    }
    this.bar.querySelector('select').value = this.phase
    this.render()
    if (this.view === 'graph') this.openInspector()
  }
  setView(view) {
    this.closeInspector(false, false)
    this.view = view
    this.render()
    if (view === 'graph') this.fit()
  }
  render() {
    this.dragCleanup?.()
    this.closeMenu(false)
    this.root.replaceChildren()
    const draw = (nodes, parent, depth = 0) => {
      for (const node of nodes) {
        const card = document.createElement('details')
        card.className = 'request-card flow-card'
        card.dataset.nodeId = node.id
        card.dataset.depth = depth
        card.open = node.id === this.selected
        const summary = document.createElement('summary')
        summary.className = 'request-head'
        const title = document.createElement('span')
        title.className = 'request-label'
        title.textContent = `${node.type === 'request' ? node.method + ' ' : ''}${node.name || 'Passo'}`
        summary.append(title)
        const actions = document.createElement('span')
        actions.className = 'request-controls'
        for (const [label, action] of [
          ['↑', 'up'],
          ['↓', 'down'],
          ['⧉', 'duplicate'],
          ['×', 'remove'],
        ]) {
          const b = document.createElement('button')
          b.type = 'button'
          b.textContent = label
          b.dataset.action = action
          b.setAttribute(
            'aria-label',
            {
              up: 'Mover requisição para cima',
              down: 'Mover requisição para baixo',
              duplicate: 'Duplicar requisição',
              remove: 'Remover requisição',
            }[action]
          )
          b.onclick = (e) => {
            e.preventDefault()
            e.stopPropagation()
            this.checkpoint()
            const loc = this.locate(node.id)
            if (action === 'remove') {
              loc.nodes.splice(loc.index, 1)
              this.selected = null
            }
            if (action === 'up' && loc.index > 0)
              [loc.nodes[loc.index - 1], loc.nodes[loc.index]] = [
                loc.nodes[loc.index],
                loc.nodes[loc.index - 1],
              ]
            if (action === 'down' && loc.index < loc.nodes.length - 1)
              [loc.nodes[loc.index + 1], loc.nodes[loc.index]] = [
                loc.nodes[loc.index],
                loc.nodes[loc.index + 1],
              ]
            if (action === 'duplicate') {
              const copy = structuredClone(node)
              this.walk([copy], (n) => (n.id = this.id()))
              loc.nodes.splice(loc.index + 1, 0, copy)
              this.selected = copy.id
            }
            this.render()
            this.changed()
          }
          actions.append(b)
        }
        summary.append(actions)
        card.append(summary)
        summary.onclick = (e) => {
          if (e.target.closest('button')) return
          e.preventDefault()
          if (this.selected === node.id) {
            card.open = !card.open
            return
          }
          this.selected = node.id
          this.render()
        }
        const body = document.createElement('div')
        body.className = 'request-body'
        if (node.id === this.selected) this.inspect(node, body)
        card.append(body)
        parent.append(card)
        for (const key of ['children', 'then', 'else'])
          if (node[key]) {
            const nested = document.createElement('div')
            nested.className = 'flow-nested'
            const label = document.createElement('strong')
            label.textContent =
              key === 'then'
                ? 'Se verdadeiro'
                : key === 'else'
                  ? 'Se falso'
                  : 'Passos internos'
            const button = document.createElement('button')
            button.type = 'button'
            button.textContent =
              'Adicionar ao ' + label.textContent.toLowerCase()
            button.onclick = () =>
              this.add(this.controls.querySelector('select').value, node[key])
            nested.append(label, button)
            draw(node[key], nested, depth + 1)
            parent.append(nested)
          }
      }
    }
    if (this.view === 'graph') {
      if (this.inspectorOpen) this.renderInspector()
    } else draw(this.flow[this.phase], this.root)
    this.root.hidden = this.view === 'graph'
    this.controls.hidden = this.view === 'graph'
    this.graphPanel.hidden = this.view !== 'graph'
    this.root.classList.toggle('graph-inspector', this.view === 'graph')
    this.canvas.hidden = this.view !== 'graph'
    this.layout.dataset.view = this.view
    document.body.classList.toggle('editing-graph', this.view === 'graph')
    this.bar
      .querySelector('#flow-list')
      .setAttribute('aria-pressed', String(this.view === 'list'))
    this.bar
      .querySelector('#flow-graph')
      .setAttribute('aria-pressed', String(this.view === 'graph'))
    this.buttons()
    this.draw()
  }
  field(parent, node, key, label, type = 'text', choices) {
    const l = document.createElement('label')
    l.textContent = label
    const el = document.createElement(
      choices ? 'select' : type === 'textarea' ? 'textarea' : 'input'
    )
    el.dataset.field = key
    if (choices)
      for (const [value, text] of choices) {
        const o = document.createElement('option')
        o.value = value
        o.textContent = text
        el.append(o)
      }
    else if (type !== 'textarea') el.type = type
    el.value = node[key] ?? ''
    if (type === 'textarea') el.rows = 3
    if (type === 'number') el.min = '0'
    el.oninput = () => {
      this.checkpoint()
      node[key] =
        type === 'number'
          ? el.value === ''
            ? undefined
            : Number(el.value)
          : el.value
      this.changed()
    }
    l.append(el)
    parent.append(l)
    return el
  }
  inspect(n, parent) {
    this.field(
      parent,
      n,
      'name',
      n.type === 'request' ? 'Nome da requisição' : 'Nome do bloco'
    )
    if (n.type === 'request') {
      this.field(
        parent,
        n,
        'method',
        'Método',
        'text',
        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(
          (v) => [v, v]
        )
      )
      this.field(parent, n, 'url', 'URL')
      const header = {
        headers: (n.headers || [])
          .map((h) => `${h.key}: ${h.value}`)
          .join('\n'),
      }
      const h = this.field(parent, header, 'headers', 'Headers', 'textarea')
      h.oninput = () => {
        this.checkpoint()
        n.invalidHeaders = h.value
          .split(/\r?\n/)
          .filter(Boolean)
          .some((line) => line.indexOf(':') < 1)
        n.headers = h.value
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            const i = line.indexOf(':')
            return {
              key: line.slice(0, i).trim(),
              value: line.slice(i + 1).trim(),
            }
          })
        this.changed()
      }
      this.field(parent, n, 'bodyType', 'Tipo de corpo', 'text', [
        ['none', 'Sem corpo'],
        ['json', 'JSON'],
        ['text', 'Texto'],
        ['form', 'Formulário (a=b&c=d)'],
      ])
      this.field(parent, n, 'body', 'Corpo', 'textarea')
      this.field(parent, n, 'expectedStatus', 'Status esperado', 'number')
      this.field(parent, n, 'contains', 'Resposta contém')
      const simple = {
        jsonPath: n.jsonCheck?.path || '',
        jsonValue: n.jsonCheck ? JSON.stringify(n.jsonCheck.value) : '',
        extractPath: n.extract?.path || '',
        extractVariable: n.extract?.variable || '',
      }
      for (const [key, label] of [
        ['jsonPath', 'Campo JSON'],
        ['jsonValue', 'Valor esperado (JSON)'],
        ['extractPath', 'Extrair campo JSON'],
        ['extractVariable', 'Salvar na variável'],
      ]) {
        const input = this.field(parent, simple, key, label)
        input.oninput = () => {
          this.checkpoint()
          simple[key] = input.value
          if (simple.jsonPath && simple.jsonValue) {
            try {
              n.jsonCheck = {
                path: simple.jsonPath,
                value: JSON.parse(simple.jsonValue),
              }
              delete n.invalidJsonCheck
            } catch {
              n.invalidJsonCheck = true
            }
          } else delete n.jsonCheck
          if (simple.extractPath || simple.extractVariable)
            n.extract = {
              source: 'json',
              path: simple.extractPath,
              variable: simple.extractVariable,
            }
          else delete n.extract
          this.changed()
        }
      }
      this.ruleEditor(parent, n, 'checks', 'Validações adicionais')
      this.ruleEditor(parent, n, 'extracts', 'Extrações adicionais')
      this.field(
        parent,
        n,
        'timeout',
        'Timeout próprio (ms; vazio usa o teste)',
        'number'
      )
      this.field(parent, n, 'retries', 'Novas tentativas (0–5)', 'number')
      if (this.phase === 'steps') {
        this.field(
          parent,
          n,
          'p95Limit',
          'p95 máximo deste endpoint (ms)',
          'number'
        )
        this.field(
          parent,
          n,
          'endpointSamples',
          'Amostra mínima do endpoint',
          'number'
        )
      }
    } else if (n.type === 'pause') {
      this.field(parent, n, 'ms', 'Pausa mínima (ms)', 'number')
      this.field(parent, n, 'maxMs', 'Pausa máxima opcional (ms)', 'number')
    } else if (n.type === 'loop') {
      const mode = this.field(parent, n, 'mode', 'Repetir', 'text', [
        ['count', 'Quantidade fixa'],
        ['items', 'Itens de uma coleção'],
        ['while', 'Enquanto condição verdadeira'],
      ])
      const updateMode = mode.oninput
      mode.oninput = () => {
        updateMode()
        this.render()
      }
      this.field(parent, n, 'limit', 'Limite obrigatório (1–1000)', 'number')
      if (n.mode === 'items')
        this.field(parent, n, 'variable', 'Variável da coleção')
      if (n.mode === 'while') this.condition(parent, n)
    } else if (n.type === 'condition') this.condition(parent, n)
    const help = document.createElement('small')
    help.textContent =
      'Variáveis: {{TOKEN}}, {{ITEM.id}}, {{INDEX}}. O loop e cada usuário possuem seu próprio contexto.'
    parent.append(help)
  }
  condition(parent, n) {
    n.condition ||= { variable: '', operator: 'exists' }
    this.field(parent, n.condition, 'variable', 'Variável da condição')
    this.field(
      parent,
      n.condition,
      'operator',
      'Comparação',
      'text',
      [
        'exists',
        'equals',
        'notEquals',
        'contains',
        'gt',
        'gte',
        'lt',
        'lte',
      ].map((v) => [
        v,
        {
          exists: 'Existe',
          equals: 'Igual',
          notEquals: 'Diferente',
          contains: 'Contém',
          gt: 'Maior',
          gte: 'Maior ou igual',
          lt: 'Menor',
          lte: 'Menor ou igual',
        }[v],
      ])
    )
    const proxy = {
      value:
        n.condition.value === undefined
          ? ''
          : JSON.stringify(n.condition.value),
    }
    const input = this.field(
      parent,
      proxy,
      'conditionValue',
      'Valor da comparação (JSON)'
    )
    input.value = proxy.value
    input.oninput = () => {
      this.checkpoint()
      try {
        n.condition.value = input.value ? JSON.parse(input.value) : undefined
        delete n.invalidCondition
      } catch {
        n.invalidCondition = true
      }
      this.changed()
    }
  }
  ruleEditor(parent, node, key, label) {
    const box = document.createElement('fieldset')
    const legend = document.createElement('legend')
    legend.textContent = label
    box.dataset.field = key
    box.tabIndex = -1
    box.append(legend)
    node[key] ||= []
    const paint = () => {
      box.querySelectorAll('.flow-rule').forEach((el) => el.remove())
      for (const rule of node[key]) {
        const row = document.createElement('div')
        row.className = 'flow-rule'
        this.field(
          row,
          rule,
          'source',
          'Origem',
          'text',
          (key === 'checks'
            ? ['status', 'json', 'text', 'header', 'cookie']
            : ['json', 'header', 'cookie']
          ).map((v) => [v, v])
        )
        this.field(row, rule, 'path', 'Campo / header')
        if (key === 'checks') {
          this.field(
            row,
            rule,
            'operator',
            'Operador',
            'text',
            [
              'equals',
              'notEquals',
              'contains',
              'exists',
              'gt',
              'gte',
              'lt',
              'lte',
            ].map((v) => [v, v])
          )
          const proxy = { value: JSON.stringify(rule.value) }
          const input = this.field(row, proxy, 'value', 'Valor (JSON)')
          input.oninput = () => {
            this.checkpoint()
            try {
              rule.value = JSON.parse(input.value)
              delete rule.invalid
            } catch {
              rule.invalid = true
            }
            this.changed()
          }
        } else {
          this.field(row, rule, 'variable', 'Salvar na variável')
          this.field(
            row,
            rule,
            'scope',
            'Escopo',
            'text',
            ['setup', 'teardown'].includes(this.phase)
              ? [['global', 'Preparação global']]
              : [
                  ['journey', 'Jornada'],
                  ['session', 'Sessão do usuário'],
                ]
          )
          const l = document.createElement('label'),
            check = document.createElement('input')
          check.type = 'checkbox'
          check.checked = !!rule.secret
          check.onchange = () => {
            this.checkpoint()
            rule.secret = check.checked
            this.changed()
          }
          l.append(check, ' Ocultar valor')
          row.append(l)
        }
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.textContent = 'Remover regra'
        remove.onclick = () => {
          this.checkpoint()
          node[key].splice(node[key].indexOf(rule), 1)
          paint()
          this.changed()
        }
        row.append(remove)
        box.append(row)
      }
    }
    const add = document.createElement('button')
    add.type = 'button'
    add.textContent =
      'Adicionar ' + (key === 'checks' ? 'validação' : 'extração')
    add.onclick = () => {
      this.checkpoint()
      node[key].push(
        key === 'checks'
          ? { source: 'json', path: '', operator: 'exists' }
          : {
              source: 'json',
              path: '',
              variable: '',
              scope: ['setup', 'teardown'].includes(this.phase)
                ? 'global'
                : 'journey',
              secret: false,
            }
      )
      paint()
      this.changed()
    }
    box.append(add)
    parent.append(box)
    paint()
  }
  kinds() {
    return [
      ['request', 'Requisição HTTP', 'Chame um endpoint e valide a resposta.'],
      ['condition', 'Condição', 'Escolha um caminho conforme uma variável.'],
      ['loop', 'Repetição', 'Execute os passos internos várias vezes.'],
      ['pause', 'Pausa', 'Aguarde antes de continuar.'],
      ['group', 'Grupo / transação', 'Organize passos em uma mesma operação.'],
    ]
  }
  announce(message) {
    if (this.status.textContent !== message) this.status.textContent = message
  }
  destinations() {
    const entries = []
    const visit = (nodes, label, depth, ancestors = []) => {
      entries.push({ nodes, label, depth, ancestors })
      for (const node of nodes) {
        for (const key of ['children', 'then', 'else']) {
          if (!node[key]) continue
          const branch = {
            children: 'Passos internos',
            then: 'Se verdadeiro',
            else: 'Se falso',
          }[key]
          visit(
            node[key],
            `${label} › ${node.name || 'Passo'} › ${branch}`,
            depth + 1,
            [...ancestors, node.id]
          )
        }
      }
    }
    visit(
      this.flow[this.phase],
      this.bar.querySelector('#flow-phase').selectedOptions[0].textContent,
      0
    )
    return entries
  }
  canMove(id, destination, index) {
    const source = this.locate(id)
    if (
      !source ||
      !destination ||
      index < 0 ||
      index > destination.nodes.length ||
      destination.ancestors.includes(id)
    )
      return false
    const height = (node) =>
      Math.max(
        0,
        ...['children', 'then', 'else']
          .filter((key) => node[key])
          .map((key) => 1 + Math.max(0, ...node[key].map(height)))
      )
    if (destination.depth + height(source.nodes[source.index]) > 10)
      return false
    return (
      source.nodes !== destination.nodes ||
      (index !== source.index && index !== source.index + 1)
    )
  }
  move(id, destination, index) {
    // Re-resolve destinations so a stale pointer cannot edit an old tree after undo.
    const current = this.destinations().find(
      (entry) => entry.nodes === destination?.nodes
    )
    if (!this.canMove(id, current, index)) return false
    const source = this.locate(id)
    this.closeInspector(false, false)
    this.checkpoint()
    const [node] = source.nodes.splice(source.index, 1)
    if (source.nodes === current.nodes && source.index < index) index--
    current.nodes.splice(index, 0, node)
    this.selected = id
    this.render()
    this.changed()
    this.focusNode(id)
    this.announce(
      `${node.name || 'Bloco'} movido para ${current.label}, posição ${index + 1}.`
    )
    return true
  }
  focusNode(id, scroll = true) {
    const button = [...this.canvas.querySelectorAll('.flow-node')].find(
      (element) => element.dataset.nodeId === id
    )
    button?.focus({ preventScroll: true })
    if (scroll) button?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  describe(node) {
    if (node.type === 'request')
      return `${node.method || 'GET'} · ${node.url || 'Configure o endpoint'}`
    if (node.type === 'pause')
      return `Aguardar ${node.ms ?? 1000} ms${node.maxMs ? ` a ${node.maxMs} ms` : ''}`
    if (node.type === 'condition') {
      const rule = node.condition
      if (!rule?.variable) return 'Configure a variável e a comparação'
      const operator =
        {
          exists: 'existe',
          equals: 'é igual a',
          notEquals: 'é diferente de',
          contains: 'contém',
          gt: 'é maior que',
          gte: 'é maior ou igual a',
          lt: 'é menor que',
          lte: 'é menor ou igual a',
        }[rule.operator] || rule.operator
      return `${rule.variable} ${operator}${rule.operator === 'exists' ? '' : ` ${rule.value === undefined ? '…' : JSON.stringify(rule.value)}`}`
    }
    if (node.type === 'loop')
      return node.mode === 'items'
        ? `Para cada item de ${node.variable || 'uma coleção'} · limite ${node.limit}`
        : node.mode === 'while'
          ? `Enquanto a condição for verdadeira · limite ${node.limit}`
          : `Repetir ${node.limit ?? 10} vezes`
    return `${node.children?.length || 0} passos agrupados`
  }
  openInspector() {
    this.inspectorOpen = true
    this.renderInspector()
  }
  closeInspector(restoreFocus = true, animate = true) {
    const dialog = this.inspectorDialog
    if (!dialog) return
    this.inspectorOpen = false
    const id = this.selected
    const finish = () => {
      if (this.inspectorDialog !== dialog) return
      clearTimeout(this.inspectorCloseTimer)
      this.inspectorDialog = null
      dialog.close()
      dialog.remove()
      if (restoreFocus) {
        if (this.find(id)) this.focusNode(id, false)
        else
          this.canvas
            .querySelector('.flow-insert button')
            ?.focus({ preventScroll: true })
      }
    }
    if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      dialog.classList.add('closing')
      clearTimeout(this.inspectorCloseTimer)
      this.inspectorCloseTimer = setTimeout(finish, 180)
    } else finish()
  }
  renderInspector() {
    const node = this.find(this.selected)
    if (!node || !this.locate(node.id)) {
      this.closeInspector(false, false)
      return
    }
    let dialog = this.inspectorDialog
    if (!dialog) {
      dialog = document.createElement('dialog')
      dialog.className = 'flow-config-dialog'
      dialog.setAttribute('aria-labelledby', 'flow-config-title')
      dialog.setAttribute('aria-describedby', 'flow-config-save-hint')
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault()
        this.closeInspector()
      })
      let backdropPress = false
      const outside = (event) => {
        const rect = dialog.getBoundingClientRect()
        return (
          event.target === dialog &&
          (event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom)
        )
      }
      dialog.addEventListener('pointerdown', (event) => {
        backdropPress = outside(event)
      })
      dialog.addEventListener('click', (event) => {
        if (backdropPress && outside(event)) this.closeInspector()
        backdropPress = false
      })
      document.body.append(dialog)
      this.inspectorDialog = dialog
    }
    clearTimeout(this.inspectorCloseTimer)
    dialog.classList.remove('closing')
    dialog.replaceChildren()
    const location = this.destinations().find((entry) =>
      entry.nodes.includes(node)
    )
    const card = document.createElement('section')
    card.className = 'flow-card flow-inspector-card'
    card.dataset.nodeId = node.id
    card.setAttribute('open', '')
    const heading = document.createElement('h3')
    heading.id = 'flow-config-title'
    heading.textContent = node.name || 'Configurar bloco'
    const path = document.createElement('p')
    path.className = 'flow-location'
    path.textContent = location.label
    const actions = document.createElement('div')
    actions.className = 'flow-inspector-actions'
    for (const [label, action] of [
      ['Mover para…', 'move'],
      ['Duplicar', 'duplicate'],
      ['Remover', 'remove'],
    ]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.onclick = () => {
        if (action === 'move') return this.moveDialog(node, button)
        this.checkpoint()
        const loc = this.locate(node.id)
        if (action === 'remove') {
          loc.nodes.splice(loc.index, 1)
          this.closeInspector(false, false)
          this.selected =
            loc.nodes[Math.min(loc.index, loc.nodes.length - 1)]?.id || null
        } else {
          const copy = structuredClone(node)
          this.walk([copy], (child) => (child.id = this.id()))
          loc.nodes.splice(loc.index + 1, 0, copy)
          this.selected = copy.id
        }
        this.render()
        this.changed()
        if (this.selected && !this.inspectorOpen) this.focusNode(this.selected)
        else if (!this.selected)
          this.canvas
            .querySelector('.flow-insert button')
            ?.focus({ preventScroll: true })
        this.announce(
          action === 'remove'
            ? 'Bloco removido. Você pode desfazer esta ação.'
            : 'Bloco e seus passos duplicados.'
        )
      }
      actions.append(button)
    }
    const header = document.createElement('div')
    header.className = 'flow-config-header'
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'flow-config-close'
    close.setAttribute('aria-label', 'Fechar configurações')
    close.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18" /></svg>'
    close.onclick = () => this.closeInspector()
    const hint = document.createElement('p')
    hint.id = 'flow-config-save-hint'
    hint.className = 'flow-config-save-hint'
    hint.textContent = 'Alterações salvas automaticamente no cenário atual.'
    const title = document.createElement('div')
    title.className = 'flow-config-title'
    title.append(heading, hint)
    header.append(title, close)
    card.append(header, path, actions)
    if (['loop', 'condition', 'group'].includes(node.type)) {
      const help = document.createElement('p')
      help.className = 'flow-context-help'
      help.textContent =
        node.type === 'loop'
          ? 'Todos os passos dentro desta repetição são executados a cada volta. Use + ou arraste um bloco para dentro. Ao sair do loop, a jornada continua no próximo bloco.'
          : node.type === 'condition'
            ? 'A variável é comparada com a regra abaixo. Apenas o ramo correspondente ao resultado é executado; depois, a jornada continua.'
            : 'Os passos deste grupo são executados em sequência. Arraste o grupo pela alça para mover todos os seus passos juntos.'
      card.append(help)
    }
    const body = document.createElement('div')
    body.className = 'request-body'
    this.inspect(node, body)
    body.addEventListener('input', () =>
      this.root.dispatchEvent(new Event('input', { bubbles: true }))
    )
    card.append(body)
    dialog.append(card)
    if (!dialog.open) dialog.showModal()
    dialog.querySelector('[data-field=name]')?.focus({ preventScroll: true })
  }
  closeMenu(restoreFocus = true) {
    if (!this.menu) return
    this.menu.remove()
    this.menu = null
    this.menuAnchor?.setAttribute('aria-expanded', 'false')
    if (restoreFocus && this.menuAnchor?.isConnected)
      this.menuAnchor.focus({ preventScroll: true })
    this.menuAnchor = null
  }
  positionMenu() {
    if (!this.menu || !this.menuAnchor?.isConnected) return
    const rect = this.menuAnchor.getBoundingClientRect()
    const canvasRect = this.canvas.getBoundingClientRect()
    if (
      rect.bottom < Math.max(0, canvasRect.top) ||
      rect.top > Math.min(window.innerHeight, canvasRect.bottom) ||
      rect.right < canvasRect.left ||
      rect.left > canvasRect.right
    ) {
      this.closeMenu()
      return
    }
    const width = this.menu.offsetWidth
    const height = this.menu.offsetHeight
    this.menu.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8))}px`
    this.menu.style.top = `${Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - height - 8))}px`
  }
  creationMenu(anchor, destination, index) {
    if (this.menuAnchor === anchor) return this.closeMenu()
    this.closeMenu(false)
    const menu = document.createElement('div')
    menu.className = 'flow-create-menu'
    menu.setAttribute('role', 'dialog')
    menu.setAttribute('aria-label', 'Adicionar bloco neste ponto')
    const title = document.createElement('strong')
    title.textContent = 'Adicionar neste ponto'
    const context = document.createElement('small')
    context.textContent = destination.label
    menu.append(title, context)
    for (const [kind, name, description] of this.kinds()) {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.createKind = kind
      button.disabled =
        destination.depth +
          (['loop', 'group', 'condition'].includes(kind) ? 1 : 0) >
        10
      const label = document.createElement('strong')
      label.textContent = name
      const hint = document.createElement('small')
      hint.textContent = button.disabled
        ? 'Limite de profundidade atingido'
        : description
      button.append(label, hint)
      button.onclick = () => {
        this.closeMenu(false)
        const node = this.add(kind, destination.nodes, index)
        if (node)
          this.announce(
            `${name} adicionado em ${destination.label}. Selecione os campos ao lado para configurar.`
          )
      }
      menu.append(button)
    }
    menu.addEventListener('keydown', (event) => {
      const buttons = [...menu.querySelectorAll('button:not(:disabled)')]
      const at = buttons.indexOf(document.activeElement)
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(event.key)) {
        event.preventDefault()
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (at +
                  (event.key === 'ArrowUp' ||
                  (event.key === 'Tab' && event.shiftKey)
                    ? -1
                    : 1) +
                  buttons.length) %
                buttons.length
        buttons[next]?.focus()
      }
    })
    document.body.append(menu)
    this.menu = menu
    this.menuAnchor = anchor
    anchor.setAttribute('aria-expanded', 'true')
    this.positionMenu()
    menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true })
  }
  moveDialog(node, anchor) {
    const dialog = document.createElement('dialog')
    dialog.className = 'flow-move-dialog'
    const heading = document.createElement('h3')
    heading.id = 'flow-move-title'
    heading.textContent = `Mover ${node.name || 'bloco'}`
    dialog.setAttribute('aria-labelledby', heading.id)
    const label = document.createElement('label')
    label.textContent = 'Destino e posição'
    const select = document.createElement('select')
    const choices = []
    for (const destination of this.destinations()) {
      for (let index = 0; index <= destination.nodes.length; index++) {
        if (!this.canMove(node.id, destination, index)) continue
        const option = document.createElement('option')
        option.value = choices.length
        option.textContent = `${destination.label} · ${index < destination.nodes.length ? `antes de ${destination.nodes[index].name || 'Passo'}` : 'no final'}`
        choices.push({ destination, index })
        select.append(option)
      }
    }
    label.append(select)
    const hint = document.createElement('p')
    hint.textContent = choices.length
      ? 'O bloco será movido com todos os seus passos internos.'
      : 'Não há outro destino disponível. Adicione um bloco ou contêiner primeiro.'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = 'Cancelar'
    cancel.onclick = () => dialog.close()
    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.textContent = 'Mover bloco'
    confirm.disabled = !choices.length
    select.disabled = !choices.length
    let moved = false
    confirm.onclick = () => {
      const choice = choices[Number(select.value)]
      dialog.close()
      moved = this.move(node.id, choice.destination, choice.index)
    }
    dialog.append(heading, label, hint, cancel, confirm)
    dialog.addEventListener('close', () => {
      dialog.remove()
      if (!moved && anchor.isConnected) anchor.focus({ preventScroll: true })
    })
    document.body.append(dialog)
    dialog.showModal()
  }
  fit() {
    const tree = this.canvas.querySelector('.flow-graph-tree')
    if (!tree) return
    const rect = tree.getBoundingClientRect()
    this.zoom = Math.max(
      0.2,
      Math.min(
        1.5,
        (this.canvas.clientWidth - 40) / (rect.width / this.zoom),
        (this.canvas.clientHeight - 40) / (rect.height / this.zoom)
      )
    )
    this.zoom = Math.floor(this.zoom * 100) / 100
    this.draw()
  }
  startDrag(event, node, handle) {
    if (event.button !== 0 || this.dragCleanup) return
    delete handle.dataset.suppressClick
    const start = { x: event.clientX, y: event.clientY }
    let point = start,
      dragging = false,
      target = null,
      frame,
      ghost
    const controller = new AbortController()
    const options = { signal: controller.signal }
    handle.setPointerCapture(event.pointerId)
    const clearTarget = () => {
      target?.element.removeAttribute('data-drop-active')
      target = null
    }
    const update = () => {
      if (!dragging) return
      ghost.style.left = `${point.x + 16}px`
      ghost.style.top = `${point.y + 16}px`
      clearTarget()
      const elements = document.elementsFromPoint(point.x, point.y)
      const insertion = elements
        .map((element) => element.closest('.flow-insert'))
        .find(Boolean)
      const container = elements
        .map((element) => element.closest('[data-flow-container]'))
        .find(Boolean)
      const element = insertion || container
      const slot = element?._flowSlot
      if (slot && this.canMove(node.id, slot.destination, slot.index)) {
        target = { element, ...slot }
        element.dataset.dropActive = 'true'
        this.announce(
          `Solte para mover para ${slot.destination.label}, posição ${slot.index + 1}.`
        )
      } else
        this.announce(
          slot
            ? 'Este destino não altera a posição ou não permite este movimento.'
            : 'Arraste até um + ou para dentro de um contêiner. Escape cancela.'
        )
    }
    const tick = () => {
      if (dragging) {
        const rect = this.canvas.getBoundingClientRect()
        if (
          point.x >= rect.left &&
          point.x <= rect.right &&
          point.y >= rect.top &&
          point.y <= rect.bottom
        ) {
          const dy =
            point.y < rect.top + 48 ? -10 : point.y > rect.bottom - 48 ? 10 : 0
          const dx =
            point.x < rect.left + 48 ? -10 : point.x > rect.right - 48 ? 10 : 0
          if (dx || dy) {
            this.canvas.scrollBy(dx, dy)
            update()
          }
        }
      }
      frame = requestAnimationFrame(tick)
    }
    const cleanup = () => {
      controller.abort()
      cancelAnimationFrame(frame)
      clearTarget()
      ghost?.remove()
      this.canvas.classList.remove('flow-dragging')
      this.canvas
        .querySelector('[data-drag-source]')
        ?.removeAttribute('data-drag-source')
      if (handle.hasPointerCapture(event.pointerId))
        handle.releasePointerCapture(event.pointerId)
      this.dragCleanup = null
    }
    this.dragCleanup = cleanup
    window.addEventListener(
      'pointermove',
      (moveEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return
        point = { x: moveEvent.clientX, y: moveEvent.clientY }
        if (!dragging && Math.hypot(point.x - start.x, point.y - start.y) < 6)
          return
        moveEvent.preventDefault()
        if (!dragging) {
          dragging = true
          handle.dataset.suppressClick = 'true'
          this.closeMenu(false)
          this.canvas.classList.add('flow-dragging')
          handle.closest('.flow-block').dataset.dragSource = 'true'
          ghost = document.createElement('div')
          ghost.className = 'flow-drag-ghost'
          ghost.textContent = node.name || 'Bloco'
          document.body.append(ghost)
          tick()
        }
        update()
      },
      { ...options, passive: false }
    )
    window.addEventListener(
      'pointerup',
      (upEvent) => {
        if (upEvent.pointerId !== event.pointerId) return
        const destination = target
        cleanup()
        if (dragging && destination)
          this.move(node.id, destination.destination, destination.index)
        else if (dragging)
          this.announce('Movimento cancelado. O bloco continua no mesmo lugar.')
      },
      options
    )
    const cancel = () => {
      cleanup()
      this.announce('Movimento cancelado. O bloco continua no mesmo lugar.')
    }
    window.addEventListener('pointercancel', cancel, options)
    window.addEventListener('blur', cancel, options)
    window.addEventListener(
      'keydown',
      (keyEvent) => {
        if (keyEvent.key === 'Escape') {
          keyEvent.preventDefault()
          cancel()
        }
      },
      options
    )
  }
  draw() {
    if (this.canvas.hidden) return
    const scroll = { left: this.canvas.scrollLeft, top: this.canvas.scrollTop }
    const focusKey = this.canvas.contains(document.activeElement)
      ? document.activeElement.dataset.focusKey
      : null
    this.closeMenu(false)
    this.canvas.replaceChildren()
    const slider = this.graphPanel.querySelector('[data-graph-zoom]')
    slider.value = Math.round(this.zoom * 100)
    this.graphPanel.querySelector('output').textContent =
      `${Math.round(this.zoom * 100)}%`
    const tree = document.createElement('div')
    tree.className = 'flow-graph-tree'
    tree.style.setProperty('--flow-zoom', this.zoom)
    const destinations = this.destinations()
    const paint = (nodes, parent) => {
      const destination = destinations.find((entry) => entry.nodes === nodes)
      const insert = (index) => {
        const slot = document.createElement('div')
        slot.className = 'flow-insert'
        slot._flowSlot = { destination, index }
        slot.dataset.position = index
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = '+'
        button.dataset.focusKey = `insert:${this.phase}:${destination.ancestors.join('/')}:${index}`
        button.setAttribute(
          'aria-label',
          `Adicionar bloco em ${destination.label}, posição ${index + 1}`
        )
        button.setAttribute('aria-haspopup', 'dialog')
        button.setAttribute('aria-expanded', 'false')
        button.onclick = () => this.creationMenu(button, destination, index)
        const hint = document.createElement('span')
        hint.textContent = 'Inserir aqui'
        slot.append(button, hint)
        parent.append(slot)
      }
      insert(0)
      for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index]
        const block = document.createElement('article')
        block.className = 'flow-block'
        block.dataset.kind = node.type
        block.dataset.selected = String(node.id === this.selected)
        block.dataset.nodeId = node.id
        const header = document.createElement('div')
        header.className = 'flow-block-head'
        const handle = document.createElement('button')
        handle.type = 'button'
        handle.className = 'flow-drag-handle'
        handle.textContent = '⠿'
        handle.setAttribute('aria-label', `Arrastar ${node.name || 'bloco'}`)
        handle.title = 'Arraste para mover; clique para escolher um destino'
        handle.dataset.focusKey = `handle:${node.id}`
        handle.onpointerdown = (event) => this.startDrag(event, node, handle)
        handle.onclick = (event) => {
          if (event.detail !== 0 && handle.dataset.suppressClick) {
            delete handle.dataset.suppressClick
            return
          }
          delete handle.dataset.suppressClick
          this.moveDialog(node, handle)
        }
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'flow-node'
        button.setAttribute('aria-haspopup', 'dialog')
        button.dataset.nodeId = node.id
        button.dataset.selected = String(node.id === this.selected)
        button.dataset.focusKey = `node:${node.id}`
        button.setAttribute('aria-pressed', String(node.id === this.selected))
        const badge = document.createElement('span')
        badge.className = 'flow-node-type'
        badge.textContent = {
          request: 'HTTP',
          condition: 'CONDIÇÃO',
          loop: 'REPETIÇÃO',
          pause: 'PAUSA',
          group: 'GRUPO',
        }[node.type]
        const name = document.createElement('strong')
        name.textContent = node.name || 'Passo'
        const summary = document.createElement('small')
        summary.textContent = this.describe(node)
        button.append(badge, name, summary)
        button.onclick = () => {
          this.select(node.id)
        }
        header.append(handle, button)
        block.append(header)
        if (node.type === 'condition') {
          const branches = document.createElement('div')
          branches.className = 'flow-branches'
          for (const [key, label] of [
            ['then', 'Se verdadeiro'],
            ['else', 'Se falso'],
          ]) {
            const branch = document.createElement('section')
            branch.className = 'flow-branch'
            branch.dataset.flowContainer = key
            const childDestination = destinations.find(
              (entry) => entry.nodes === node[key]
            )
            branch._flowSlot = {
              destination: childDestination,
              index: node[key].length,
            }
            const title = document.createElement('strong')
            title.textContent = label
            const hint = document.createElement('p')
            hint.className = 'flow-branch-hint'
            hint.textContent = node[key].length
              ? 'Executar quando a condição for ' +
                (key === 'then' ? 'verdadeira.' : 'falsa.')
              : 'Use + ou arraste um bloco aqui. Este caminho só executa quando a condição for ' +
                (key === 'then' ? 'verdadeira.' : 'falsa.')
            branch.append(title, hint)
            paint(node[key], branch)
            branches.append(branch)
          }
          const merge = document.createElement('p')
          merge.className = 'flow-return'
          merge.textContent = '↓ Os caminhos voltam à sequência'
          block.append(branches, merge)
        } else if (node.children) {
          const nested = document.createElement('section')
          nested.className = 'flow-branch'
          nested.dataset.flowContainer = 'children'
          const childDestination = destinations.find(
            (entry) => entry.nodes === node.children
          )
          const slot = {
            destination: childDestination,
            index: node.children.length,
          }
          nested._flowSlot = slot
          header.dataset.flowContainer = 'children'
          header._flowSlot = slot
          const title = document.createElement('strong')
          title.textContent =
            node.type === 'loop' ? 'Dentro da repetição' : 'Dentro do grupo'
          const hint = document.createElement('p')
          hint.className = 'flow-branch-hint'
          hint.textContent =
            node.type === 'loop'
              ? 'Estes passos executam a cada volta. Use + ou arraste um bloco para dentro.'
              : 'Estes passos executam em sequência. Use + ou arraste um bloco para dentro.'
          nested.append(title, hint)
          paint(node.children, nested)
          block.append(nested)
          const exit = document.createElement('p')
          exit.className = 'flow-return'
          exit.textContent =
            node.type === 'loop'
              ? '↓ Ao terminar as repetições, continuar'
              : '↓ Ao terminar o grupo, continuar'
          block.append(exit)
        }
        parent.append(block)
        insert(index + 1)
      }
    }
    if (!this.flow[this.phase].length) {
      const empty = document.createElement('p')
      empty.className = 'flow-empty'
      empty.textContent =
        'Comece pelo + abaixo. Adicione uma requisição ou um bloco para organizar sua jornada.'
      tree.append(empty)
    }
    paint(this.flow[this.phase], tree)
    this.canvas.append(tree)
    this.canvas.scrollLeft = scroll.left
    this.canvas.scrollTop = scroll.top
    if (focusKey)
      [...this.canvas.querySelectorAll('[data-focus-key]')]
        .find((element) => element.dataset.focusKey === focusKey)
        ?.focus({ preventScroll: true })
  }
}
