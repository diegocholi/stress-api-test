const { test, expect } = require('@playwright/test')
const fs = require('node:fs/promises')
const base = require('../../examples/native-flow.json')

async function importFile(page, content) {
  await page.locator('#import-test-file').setInputFiles({
    name: 'teste.json',
    mimeType: 'application/json',
    buffer: Buffer.from(content),
  })
}

test('individual export and import preserve the saved configuration and current editor', async ({
  page,
  request,
}) => {
  const configuration = structuredClone(base)
  configuration.name = 'Transferência / completa'
  configuration.scenario.variables.push({ key: 'TOKEN', value: 'secret-token' })
  configuration.scenario.steps[0].headers = [
    { key: 'Authorization', value: 'Bearer {{TOKEN}}' },
  ]
  configuration.scenario.steps = [
    {
      id: 'condition',
      type: 'condition',
      name: 'Condição',
      condition: { variable: 'TOKEN', operator: 'exists' },
      then: [
        {
          id: 'loop',
          type: 'loop',
          name: 'Repetição',
          mode: 'count',
          limit: 2,
          children: configuration.scenario.steps,
        },
      ],
      else: [],
    },
  ]
  configuration.scenario.dataset = {
    rows: [{ email: 'example@example.com' }],
    select: 'iteration',
    exhaustion: 'cycle',
  }
  configuration.scheduledAt = '2099-01-01T00:00:00Z'
  const response = await request.post('/api/templates', { data: configuration })
  expect(response.status()).toBe(201)
  const original = await response.json()
  const saved = await (
    await request.get(`/api/templates/${original.id}`)
  ).json()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#configure')
  await page.locator('[name=name]').fill('Rascunho preservado')
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('link', { name: /Testes salvos/ }).click()
  await page.locator('#saved-search').fill(configuration.name)
  await expect(page.locator('#import-test')).toBeVisible()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth)
  ).toBeLessThanOrEqual(390)
  const downloadEvent = page.waitForEvent('download')
  await page
    .getByRole('button', {
      name: `Exportar ${configuration.name}`,
      exact: true,
    })
    .click()
  const download = await downloadEvent
  expect(download.suggestedFilename()).toBe('Transferência - completa.json')
  const content = await fs.readFile(await download.path(), 'utf8')
  const exported = JSON.parse(content)
  expect(exported).toEqual(saved.definition)
  for (const key of ['id', 'revision', 'scheduledAt', 'result'])
    expect(exported).not.toHaveProperty(key)
  const importResponse = page.waitForResponse(
    (res) =>
      res.url().endsWith('/api/templates') && res.request().method() === 'POST'
  )
  await page.locator('#import-test').focus()
  const fileChooserEvent = page.waitForEvent('filechooser')
  await page.keyboard.press('Enter')
  await (
    await fileChooserEvent
  ).setFiles({
    name: 'teste.json',
    mimeType: 'application/json',
    buffer: Buffer.from(content),
  })
  const imported = await (await importResponse).json()
  await expect(page.locator('#library-message')).toContainText(
    'importado para a biblioteca'
  )
  expect(imported.id).not.toBe(original.id)
  expect(imported.revision).toBe(1)
  expect(imported.name).toBe(original.name)
  expect(
    (await (await request.get(`/api/templates/${imported.id}`)).json())
      .definition
  ).toEqual(exported)
  await expect(page.locator('.saved-item')).toHaveCount(2)
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('link', { name: /Configurar teste/ }).click()
  await expect(page.locator('[name=name]')).toHaveValue('Rascunho preservado')
  await expect(page.locator('#editor-status')).toHaveText('NÃO SALVO')
  await page.reload()
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('link', { name: /Testes salvos/ }).click()
  await page.locator('#saved-search').fill(configuration.name)
  await expect(page.locator('.saved-item')).toHaveCount(2)
})

test('invalid imports do not create tests and the file selector can be reused', async ({
  page,
  request,
}) => {
  await page.goto('/#saved')
  await page.getByRole('link', { name: /Testes salvos/ }).click()
  const before = await (await request.get('/api/templates')).json()
  for (const content of [
    '{broken',
    'null',
    '[]',
    JSON.stringify({ ...base, scenario: { steps: [] } }),
    ' '.repeat(5 * 1024 * 1024 + 1),
  ]) {
    await importFile(page, content)
    await expect(page.locator('#library-message')).toHaveClass(/error/)
    await expect(page.locator('#import-test')).toBeEnabled()
    expect(await page.locator('#import-test-file').inputValue()).toBe('')
    expect(await (await request.get('/api/templates')).json()).toEqual(before)
  }
  await expect(page.locator('#library-message')).toContainText('5 MB')
})

test('export failure is reported without leaving its button disabled', async ({
  page,
  request,
}) => {
  const response = await request.post('/api/templates', {
    data: { ...base, name: 'Falha de exportação' },
  })
  const saved = await response.json()
  await page.goto('/')
  await page.getByRole('link', { name: /Testes salvos/ }).click()
  await page.route(`**/api/templates/${saved.id}`, (route) =>
    route.fulfill({
      status: 404,
      json: { error: 'Teste salvo não encontrado' },
    })
  )
  const button = page.getByRole('button', {
    name: 'Exportar Falha de exportação',
    exact: true,
  })
  await button.click()
  await expect(page.locator('#library-message')).toHaveText(
    'Teste salvo não encontrado'
  )
  await expect(button).toBeEnabled()
})

test('incompatible saved tests cannot be exported', async ({ page }) => {
  await page.route('**/api/templates', (route) =>
    route.fulfill({
      json: [
        {
          id: 'blocked',
          name: 'Teste incompatível',
          revision: 1,
          canRun: false,
          steps: 1,
          durationSec: 30,
          peakUsers: 5,
          updatedAt: new Date().toISOString(),
          migration: {
            compatible: false,
            issues: [{ message: 'Script exige adaptação' }],
          },
        },
      ],
    })
  )
  await page.goto('/')
  await page.getByRole('link', { name: /Testes salvos/ }).click()
  await expect(
    page.getByRole('button', {
      name: 'Exportar Teste incompatível',
      exact: true,
    })
  ).toBeDisabled()
})
