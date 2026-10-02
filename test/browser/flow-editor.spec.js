const { test, expect } = require('@playwright/test')

const request = (id, name = id) => ({
  id,
  name,
  type: 'request',
  method: 'GET',
  url: 'http://127.0.0.1/health',
  expectedStatus: 200,
  headers: [{ key: 'X-Test', value: '{{TOKEN}}' }],
  checks: [{ source: 'text', operator: 'contains', value: 'ok' }],
  extracts: [],
})
async function openGraph(page, steps) {
  await page.goto('/#configure')
  // Seed real editor state, then exercise the visible controls and pointer events.
  await page.evaluate((steps) => flowEditor.load({ steps }), steps)
  await page.locator('#flow-graph').click()
  await page.locator('[data-graph-zoom]').fill('70')
}
const block = (page, id) => page.locator(`.flow-block[data-node-id="${id}"]`)
const rootSlot = (page, index) =>
  page.locator(`.flow-graph-tree > .flow-insert[data-position="${index}"]`)
async function closeConfig(page) {
  if (await page.locator('.flow-config-dialog').count()) {
    await page
      .getByRole('button', { name: 'Fechar configurações', exact: true })
      .click()
    await expect(page.locator('.flow-config-dialog')).toHaveCount(0)
  }
}
async function drag(page, source, destination, cancel = false) {
  await closeConfig(page)
  await page.locator('#flow-canvas').scrollIntoViewIfNeeded()
  const start = await source.boundingBox()
  const end = await destination.boundingBox()
  expect(start).not.toBeNull()
  expect(end).not.toBeNull()
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, {
    steps: 8,
  })
  if (cancel) await page.keyboard.press('Escape')
  await page.mouse.up()
}
const value = (page) => page.evaluate(() => flowEditor.value())

test('graph creates at the chosen point and moves a configured request into and out of a loop', async ({
  page,
}) => {
  const original = request('http', 'Buscar dados')
  await openGraph(page, [original])
  const configured = (await value(page)).steps[0]
  await rootSlot(page, 1).getByRole('button').click()
  await expect(
    page.getByRole('dialog', { name: 'Adicionar bloco neste ponto' })
  ).toBeVisible()
  await page.locator('[data-create-kind=loop]').click()
  const loopId = (await value(page)).steps[1].id
  await page.locator('[data-field=limit]').fill('2')
  await drag(
    page,
    block(page, 'http').locator('.flow-drag-handle'),
    block(page, loopId).locator('.flow-branch > .flow-insert')
  )
  let flow = await value(page)
  expect(flow.steps).toHaveLength(1)
  expect(flow.steps[0].children[0]).toEqual(configured)
  await expect(page.locator('.flow-feedback')).toContainText('movido')
  await block(page, 'http')
    .locator(':scope > .flow-block-head > .flow-node')
    .click()
  await expect(page.locator('[data-field=url]')).toHaveValue(original.url)
  await closeConfig(page)
  await closeConfig(page)
  await page.locator('#flow-undo').click()
  expect((await value(page)).steps.map((node) => node.id)).toEqual([
    'http',
    loopId,
  ])
  await page.locator('#flow-redo').click()
  expect((await value(page)).steps[0].children[0].id).toBe('http')
  await drag(
    page,
    block(page, 'http').locator('.flow-drag-handle'),
    rootSlot(page, 1)
  )
  flow = await value(page)
  expect(flow.steps.map((node) => node.id)).toEqual([loopId, 'http'])
  expect(flow.steps[0].children).toEqual([])
  await rootSlot(page, 1).getByRole('button').click()
  await page.locator('[data-create-kind=pause]').click()
  expect((await value(page)).steps.map((node) => node.type)).toEqual([
    'loop',
    'pause',
    'request',
  ])
  await closeConfig(page)
  await page.locator('#flow-list').click()
  await expect(page.locator('#flow-kind')).toBeVisible()
  await expect(page.locator('#add-request')).toBeVisible()
  await expect(page.locator('.request-card')).toHaveCount(3)
})

test('graph moves an entire group between condition branches, reorders and blocks cycles', async ({
  page,
}) => {
  await openGraph(page, [
    {
      id: 'condition',
      type: 'condition',
      name: 'Escolher caminho',
      condition: { variable: 'FLAG', operator: 'exists' },
      then: [
        {
          id: 'group',
          type: 'group',
          name: 'Operação',
          children: [request('child')],
        },
        { id: 'pause', type: 'pause', name: 'Espera', ms: 100 },
      ],
      else: [],
    },
  ])
  await page.locator('[data-graph-zoom]').fill('55')
  const group = block(page, 'group')
  const before = await value(page)
  await drag(
    page,
    group.locator(':scope > .flow-block-head > .flow-drag-handle'),
    group.locator(':scope > .flow-branch > .flow-insert').first()
  )
  expect(await value(page)).toEqual(before)
  expect(await page.evaluate(() => flowEditor.history.length)).toBe(0)
  await drag(
    page,
    group.locator(':scope > .flow-block-head > .flow-drag-handle'),
    page.locator('[data-flow-container=else] > .flow-insert')
  )
  const moved = await value(page)
  expect(moved.steps[0].then.map((node) => node.id)).toEqual(['pause'])
  expect(moved.steps[0].else[0]).toEqual(before.steps[0].then[0])
  await block(page, 'group')
    .locator(':scope > .flow-block-head > .flow-node')
    .click()
  await page.getByRole('button', { name: 'Mover para…', exact: true }).click()
  const dialog = page.getByRole('dialog', {
    name: 'Mover Operação',
    exact: true,
  })
  await expect(dialog).toBeVisible()
  const options = await dialog.locator('option').allTextContents()
  expect(options.some((label) => label.includes('Operação ›'))).toBe(false)
  const index = options.findIndex(
    (label) =>
      label.includes('Se verdadeiro') && label.includes('antes de Espera')
  )
  await dialog.locator('select').selectOption(String(index))
  await dialog.getByRole('button', { name: 'Mover bloco', exact: true }).click()
  expect((await value(page)).steps[0].then.map((node) => node.id)).toEqual([
    'group',
    'pause',
  ])
  await closeConfig(page)
  await page.locator('#flow-undo').click()
  expect((await value(page)).steps[0].else[0].children[0].id).toBe('child')
  await page.locator('#flow-redo').click()
  expect((await value(page)).steps[0].then[0].children[0].id).toBe('child')
})

test('graph cancels drag and menus, preserves focus and supports keyboard creation in empty phases', async ({
  page,
}) => {
  await openGraph(page, [request('a'), request('b')])
  const before = await value(page)
  await drag(
    page,
    block(page, 'a').locator('.flow-drag-handle'),
    rootSlot(page, 2),
    true
  )
  expect(await value(page)).toEqual(before)
  await expect(page.locator('.flow-drag-ghost')).toHaveCount(0)
  expect(await page.evaluate(() => flowEditor.history.length)).toBe(0)
  await drag(
    page,
    block(page, 'a').locator('.flow-drag-handle'),
    rootSlot(page, 0)
  )
  expect(await value(page)).toEqual(before)
  await drag(
    page,
    block(page, 'a').locator('.flow-drag-handle'),
    page.locator('#flow-phase')
  )
  expect(await value(page)).toEqual(before)
  expect(await page.evaluate(() => flowEditor.history.length)).toBe(0)
  await drag(
    page,
    block(page, 'a').locator('.flow-drag-handle'),
    rootSlot(page, 2)
  )
  expect((await value(page)).steps.map((node) => node.id)).toEqual(['b', 'a'])
  await expect(block(page, 'a').locator('.flow-node')).toBeFocused()
  await page.locator('#flow-phase').selectOption('setup')
  await expect(page.locator('.flow-empty')).toContainText('Comece pelo +')
  const plus = rootSlot(page, 0).getByRole('button')
  await plus.focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await expect(plus).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  expect((await value(page)).setup[0].type).toBe('condition')
  await expect(page.locator('.flow-context-help')).toContainText(
    'Apenas o ramo'
  )
  const falsePlus = page.locator(
    '[data-flow-container=else] > .flow-insert button'
  )
  await closeConfig(page)
  await falsePlus.click()
  await page.locator('[data-create-kind=request]').click()
  expect((await value(page)).setup[0].else[0].type).toBe('request')
  await page.locator('[data-field=name]').fill('Nome longo '.repeat(12))
  await closeConfig(page)
  await page.locator('[data-graph-fit]').click()
  expect(await page.evaluate(() => flowEditor.zoom)).toBeGreaterThanOrEqual(0.2)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({
    path: 'test-results/flow-graph-guided.png',
    fullPage: true,
  })
})

test('graph enforces depth and rejects invalid drops without history or data loss', async ({
  page,
}) => {
  let nested = { id: 'deep-10', type: 'group', name: 'Nível 10', children: [] }
  for (let index = 9; index >= 1; index--)
    nested = {
      id: `deep-${index}`,
      type: 'group',
      name: `Nível ${index}`,
      children: [nested],
    }
  await openGraph(page, [
    request('outside'),
    {
      id: 'moving',
      type: 'loop',
      name: 'Repetir',
      mode: 'count',
      limit: 2,
      children: [request('inside')],
    },
    nested,
  ])
  const before = await value(page)
  const rejected = await page.evaluate(() => {
    const destination = flowEditor
      .destinations()
      .find((entry) => entry.depth === 10)
    return flowEditor.move('moving', destination, 0)
  })
  expect(rejected).toBe(false)
  expect(await value(page)).toEqual(before)
  expect(await page.evaluate(() => flowEditor.history.length)).toBe(0)
  // At depth 10 a leaf is still allowed; another container would exceed the limit.
  const deepPlus = block(page, 'deep-10').locator(
    ':scope > .flow-branch > .flow-insert button'
  )
  await deepPlus.click()
  await expect(page.locator('[data-create-kind=loop]')).toBeDisabled()
  await expect(page.locator('[data-create-kind=request]')).toBeEnabled()
  await page.keyboard.press('Escape')
  const result = await page.evaluate(() => {
    const destination = flowEditor
      .destinations()
      .find((entry) => entry.depth === 10)
    return flowEditor.move('outside', destination, 0)
  })
  expect(result).toBe(true)
  expect((await value(page)).steps).toHaveLength(2)
  await closeConfig(page)
  await page.locator('#flow-undo').click()
  expect(await value(page)).toEqual(before)
})

test('graph stays inside a mobile viewport and provides touch drag and destination selection', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openGraph(page, [
    request('a'),
    {
      id: 'loop',
      type: 'loop',
      name: 'Repetir',
      mode: 'count',
      limit: 2,
      children: [],
    },
  ])
  await page.locator('#flow-canvas').scrollIntoViewIfNeeded()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  // Send real touch input so pointer capture and browser gesture handling are exercised.
  const handle = block(page, 'a').locator('.flow-drag-handle')
  const destination = block(page, 'loop').locator('.flow-branch > .flow-insert')
  const start = await handle.boundingBox()
  const end = await destination.boundingBox()
  const client = await page.context().newCDPSession(page)
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: start.x + start.width / 2, y: start.y + start.height / 2 },
    ],
  })
  for (let index = 1; index <= 8; index++) {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x:
            start.x +
            start.width / 2 +
            ((end.x + end.width / 2 - start.x - start.width / 2) * index) / 8,
          y:
            start.y +
            start.height / 2 +
            ((end.y + end.height / 2 - start.y - start.height / 2) * index) / 8,
        },
      ],
    })
  }
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  })
  await client.detach()
  expect((await value(page)).steps[0].children[0].id).toBe('a')
  await block(page, 'a').locator('.flow-node').click()
  await page.getByRole('button', { name: 'Mover para…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Mover a', exact: true })
  await dialog.locator('select').selectOption('0')
  await dialog.getByRole('button', { name: 'Mover bloco', exact: true }).click()
  expect((await value(page)).steps.map((node) => node.id)).toEqual([
    'a',
    'loop',
  ])
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({
    path: 'test-results/flow-graph-mobile.png',
    fullPage: true,
  })
})

test('graph scrolls during a long drag and drops into the revealed loop', async ({
  page,
}) => {
  await openGraph(page, [
    request('source'),
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `pause-${index}`,
      type: 'pause',
      name: `Pausa ${index}`,
      ms: 1,
    })),
    {
      id: 'destination',
      type: 'loop',
      name: 'Destino',
      mode: 'count',
      limit: 2,
      children: [],
    },
  ])
  await page.locator('[data-graph-zoom]').fill('100')
  const canvas = page.locator('#flow-canvas')
  await canvas.evaluate((element) => {
    element.scrollTop = 0
  })
  await canvas.scrollIntoViewIfNeeded()
  const start = await block(page, 'source')
    .locator('.flow-drag-handle')
    .boundingBox()
  const rect = await canvas.boundingBox()
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height - 12, {
    steps: 5,
  })
  await expect
    .poll(
      async () => {
        const slot = await block(page, 'destination')
          .locator('.flow-branch > .flow-insert')
          .boundingBox()
        return slot.y + slot.height / 2 < rect.y + rect.height - 40
      },
      { timeout: 10000 }
    )
    .toBe(true)
  expect(await canvas.evaluate((element) => element.scrollTop)).toBeGreaterThan(
    200
  )
  const slot = await block(page, 'destination')
    .locator('.flow-branch > .flow-insert')
    .boundingBox()
  await page.mouse.move(slot.x + slot.width / 2, slot.y + slot.height / 2)
  await page.mouse.up()
  expect((await value(page)).steps.at(-1).children[0].id).toBe('source')
  await expect(page.locator('.flow-drag-ghost')).toHaveCount(0)
})

test('graph duplicates a subtree with new identities and removes it with undo', async ({
  page,
}) => {
  await openGraph(page, [
    { id: 'group', type: 'group', name: 'Grupo', children: [request('child')] },
  ])
  await block(page, 'group')
    .locator(':scope > .flow-block-head > .flow-node')
    .click()
  const original = (await value(page)).steps[0]
  await page.getByRole('button', { name: 'Duplicar', exact: true }).click()
  const copy = (await value(page)).steps[1]
  expect(copy.id).not.toBe(original.id)
  expect(copy.children[0].id).not.toBe(original.children[0].id)
  expect(copy.children[0]).toEqual({
    ...original.children[0],
    id: copy.children[0].id,
  })
  await expect(
    block(page, copy.id).locator(':scope > .flow-block-head > .flow-node')
  ).toHaveAttribute('data-selected', 'true')
  await expect(
    page.locator('.flow-config-dialog [data-field=name]')
  ).toBeFocused()
  await page.getByRole('button', { name: 'Remover', exact: true }).click()
  expect((await value(page)).steps).toEqual([original])
  await closeConfig(page)
  await page.locator('#flow-undo').click()
  expect((await value(page)).steps).toEqual([original, copy])
  await page.locator('#flow-redo').click()
  expect((await value(page)).steps).toEqual([original])
})

test('graph is the default and modal edits survive every close action without saving to the library', async ({
  page,
}) => {
  await page.goto('/#configure')
  await expect(page.locator('#flow-graph')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.locator('#requests')).toBeHidden()
  await expect(page.locator('.flow-config-dialog')).toHaveCount(0)
  await page.evaluate(
    (http) =>
      flowEditor.load({
        steps: [
          {
            id: 'group',
            type: 'group',
            name: 'Grupo',
            children: [http],
          },
          { id: 'pause', type: 'pause', name: 'Pausa', ms: 100 },
          {
            id: 'loop',
            type: 'loop',
            name: 'Loop',
            mode: 'count',
            limit: 2,
            children: [],
          },
          {
            id: 'condition',
            type: 'condition',
            name: 'Condição',
            condition: { variable: 'FLAG', operator: 'exists' },
            then: [],
            else: [],
          },
        ],
      }),
    request('http')
  )
  await expect(page.locator('.flow-config-dialog')).toHaveCount(0)
  await page.locator('[data-graph-zoom]').fill('70')
  const saves = []
  page.on('request', (req) => {
    if (req.method() !== 'GET' && req.url().includes('/api/templates'))
      saves.push(req.url())
  })
  for (const [index, id] of [
    'http',
    'pause',
    'loop',
    'condition',
    'group',
  ].entries()) {
    await block(page, id)
      .locator(':scope > .flow-block-head > .flow-node')
      .click()
    const dialog = page.locator('.flow-config-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-field=name]')).toBeFocused()
    await dialog.locator('[data-field=name]').fill(`Editado ${id}`)
    if (index === 0) {
      await dialog.evaluate(async (el) => {
        await Promise.all(
          el.getAnimations().map((animation) => animation.finished)
        )
      })
      await page.screenshot({ path: 'test-results/flow-config-desktop.png' })
    }
    const history = await page.evaluate(() => flowEditor.history.length)
    if (index % 3 === 0) await closeConfig(page)
    else if (index % 3 === 1) await page.keyboard.press('Escape')
    else await page.mouse.click(2, 2)
    await expect(dialog).toHaveCount(0)
    await expect(
      block(page, id).locator(':scope > .flow-block-head > .flow-node')
    ).toBeFocused()
    expect(await page.evaluate(() => flowEditor.history.length)).toBe(history)
    await block(page, id)
      .locator(':scope > .flow-block-head > .flow-node')
      .click()
    await expect(dialog.locator('[data-field=name]')).toHaveValue(
      `Editado ${id}`
    )
    await closeConfig(page)
  }
  expect(saves).toEqual([])
  expect(await page.evaluate(() => flowEditor.zoom)).toBe(0.7)
  await page.locator('#flow-undo').click()
  expect((await value(page)).steps[0].name).toBe('Grupo')
  await page.locator('#flow-redo').click()
  expect((await value(page)).steps[0].name).toBe('Editado group')
  await page.reload()
  await expect(page.locator('#flow-graph')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.locator('.flow-config-dialog')).toHaveCount(0)
})

test('configuration modal supports keyboard, small screens, reduced motion and validation focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 740 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openGraph(page, [request('http')])
  const node = block(page, 'http').locator('.flow-node')
  await node.focus()
  await page.keyboard.press('Enter')
  const dialog = page.locator('.flow-config-dialog')
  await expect(dialog.locator('[data-field=name]')).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  expect(
    await page.evaluate(() =>
      document
        .querySelector('.flow-config-dialog')
        .contains(document.activeElement)
    )
  ).toBe(true)
  const bounds = await dialog.boundingBox()
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390)
  expect(bounds.height).toBeLessThanOrEqual(740)
  expect(
    await dialog.evaluate((el) => getComputedStyle(el).animationName)
  ).toBe('none')
  await dialog.locator('[data-field=url]').fill('{{MISSING}}/x')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await page.evaluate(() =>
    showError({ message: 'URL inválida', nodeId: 'http', field: 'url' })
  )
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-field=url]')).toBeFocused()
  await expect(dialog.locator('[data-field=url]')).toHaveValue('{{MISSING}}/x')
  await page.screenshot({ path: 'test-results/flow-config-mobile.png' })
  await closeConfig(page)
})
