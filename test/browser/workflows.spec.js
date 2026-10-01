const {test,expect}=require('@playwright/test');
const http=require('node:http');
let target,url,received=0;
test.beforeAll(async()=>{target=http.createServer((req,res)=>{received++;res.setHeader('Content-Type','application/json');setTimeout(()=>res.end(JSON.stringify({ok:true})),20);});await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));url=`http://127.0.0.1:${target.address().port}/health`;});
test.afterAll(async()=>{target.closeAllConnections();await new Promise(resolve=>target.close(resolve));});
async function configure(page,name='Health navegador') {
  await page.goto('/#configure');await page.locator('[name=name]').fill(name);await page.locator('[data-field=url]').fill(url);
  await page.locator('#stages input').nth(0).fill('1');await page.locator('#stages input').nth(1).fill('1');
  await page.getByRole('button',{name:'Remover estágio'}).last().click();
  await page.getByText('Threads e timeouts avançados',{exact:true}).click();await page.locator('[name=maxWorkers]').fill('1');await page.locator('[name=minResponses]').fill('1');await page.locator('[name=minLoadPercent]').fill('0');await expect(page.locator('#submit')).toBeEnabled({timeout:20000});
}
test('validation sends no traffic, reports inline errors and supports duplicate collapsed steps',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await configure(page,'Pré-validação');
  const before=received;await page.getByRole('button',{name:'Validar configuração',exact:true}).click();await expect(page.locator('#message')).toContainText('Configuração válida');expect(received).toBe(before);
  await page.locator('[data-field=url]').fill('{{MISSING}}/x');await page.getByRole('button',{name:'Validar configuração',exact:true}).click();await expect(page.locator('.field-error')).toContainText('variável não definida');await expect(page.locator('[data-field=url]')).toBeFocused();
  await page.locator('[data-field=url]').fill(url);await page.getByRole('button',{name:'Duplicar requisição',exact:true}).click();await expect(page.locator('.request-card')).toHaveCount(2);
  await page.locator('.request-head').first().click();await expect(page.locator('.request-card').first()).not.toHaveAttribute('open','');expect(errors).toEqual([]);
});
test('saved configuration executes, exports XLSX and restores historical charts after reload',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await configure(page);
  await page.getByRole('button',{name:'Salvar teste',exact:true}).click();await expect(page.locator('#message')).toContainText('Teste salvo');
  await page.locator('#new-test').click();await page.getByRole('link',{name:/Testes salvos/}).click();await page.getByRole('button',{name:'Carregar Health navegador',exact:true}).click();await expect(page.locator('[data-field=url]')).toHaveValue(url);
  await page.getByRole('button',{name:'Iniciar teste de carga',exact:true}).click();await expect(page.locator('#status')).toHaveText('Aprovado',{timeout:20000});
  await expect(page.locator('#series-message')).toContainText('janelas persistidas');const readout=await page.locator('.chart-readout').first().textContent();
  await page.reload();await expect(page.locator('#status')).toHaveText('Aprovado');await expect(page.locator('.chart-readout').first()).toHaveText(readout);
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'test-results/desktop-monitor.png',fullPage:true});
  await page.getByRole('link',{name:'Resultados',exact:true}).first().click();await expect(page.locator('#result-verdict')).toContainText('Aprovado');await expect(page.locator('#criteria-table')).toContainText('Respostas com latência');
  const download=page.waitForEvent('download');await page.locator('#result-xlsx').click();expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'test-results/desktop-results.png',fullPage:true});
  await page.getByRole('link',{name:/Histórico e agenda/}).click();await page.locator('#history-search').fill('não existe');await expect(page.locator('#history')).toContainText('Nenhuma execução');await page.locator('#history-search').fill('Health');await expect(page.locator('.history-row')).toHaveCount(1);
  expect(errors).toEqual([]);
});
test('single execution is functional, repeat preserves it and comparison flags different definitions',async({page})=>{
  await configure(page,'Verificação navegador');await page.getByRole('button',{name:'Executar uma vez',exact:true}).click();await expect(page.locator('#status')).toHaveText('Fluxo aprovado',{timeout:20000});
  await expect(page.locator('#run-info')).toContainText('Verificação funcional');await expect(page.locator('#repeat')).toBeEnabled({timeout:20000});const repeated=page.waitForResponse(res=>res.url().endsWith('/repeat') && res.request().method()==='POST');await page.locator('#repeat').click();const repeatResponse=await repeated;expect(repeatResponse.status()).toBe(201);const next=await repeatResponse.json();await expect(page.locator('#monitor')).toHaveAttribute('data-run-id',next.id);await expect(page.locator('#status')).toHaveText('Fluxo aprovado',{timeout:20000});
  await page.getByRole('link',{name:'Resultados',exact:true}).first().click();await page.locator('#compare-baseline').selectOption({label:(await page.locator('#compare-baseline option').allTextContents()).find(t=>t.startsWith('Health navegador'))});
  await page.locator('#compare-runs').click();await expect(page.locator('#comparison-note')).toContainText('Comparação com ressalvas');await expect(page.locator('#comparison-output')).toContainText('p95');
});
test('cancelled run remains partial and can export its collected evidence',async({page})=>{
  await configure(page,'Cancelamento navegador');await page.locator('#stages input').nth(0).fill('10');await page.getByRole('button',{name:'Iniciar teste de carga',exact:true}).click();await expect(page.locator('#cancel')).toBeVisible();await page.waitForTimeout(1100);await page.locator('#cancel').click();await expect(page.locator('#status')).toHaveText('Resultado parcial',{timeout:20000});await expect(page.locator('#xlsx')).toBeVisible();
});
test('mobile and zoomed layouts keep navigation, fields and evidence accessible',async({page})=>{
  await configure(page,'Layout');await page.evaluate(()=>window.scrollTo(0,700));expect(await page.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().top)).toBe(76);
  await page.setViewportSize({width:390,height:844});await expect(page.getByRole('link',{name:'Configuração',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'test-results/mobile.png',fullPage:true});
  await page.setViewportSize({width:1280,height:900});await page.evaluate(()=>document.body.style.zoom='2');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.locator('[data-field=url]').focus();await expect(page.locator('[data-field=url]')).toBeFocused();await page.screenshot({path:'test-results/zoom.png',fullPage:true});
});
test('arrival ramps persist, show live throughput and distinguish actual starts from planned demand',async({page})=>{
  await configure(page,'Chegadas e throughput');
  await page.locator('[name=loadModel]').selectOption('arrival');await page.locator('[name=warmupSec]').fill('1');
  await page.locator('#stages input').nth(0).fill('4');await page.locator('#stages input').nth(1).fill('8');
  await page.locator('[data-stage-profile]').selectOption('ramp');await page.locator('[data-stage-from]').fill('4');
  await page.getByRole('button',{name:'Salvar teste',exact:true}).click();await expect(page.locator('#message')).toContainText('Teste salvo');
  await page.getByRole('button',{name:'Iniciar teste de carga',exact:true}).click();
  await expect(page.locator('#metrics')).toContainText('Tentativas/s');await expect(page.locator('#metrics')).toContainText('Sucessos HTTP/s');await expect(page.locator('#metrics')).toContainText('Cenários/s');
  await expect(page.locator('#throughput-status')).toContainText('Janela completa',{timeout:10000});
  await expect(page.locator('#metrics .metric').first().locator('strong')).not.toHaveText('Coletando',{timeout:10000});
  await expect(page.getByRole('heading',{name:'Cenários iniciados/s e taxa alvo',exact:true})).toBeVisible();
  await expect(page.locator('#status')).toHaveText('Aprovado',{timeout:20000});
  await page.getByRole('link',{name:'Resultados',exact:true}).first().click();await expect(page.locator('#criteria-table')).toContainText('Estágio 1: p95');
  await page.getByRole('link',{name:/Testes salvos/}).click();await page.getByRole('button',{name:'Carregar Chegadas e throughput',exact:true}).click();
  await expect(page.locator('[name=loadModel]')).toHaveValue('arrival');await expect(page.locator('[data-stage-profile]')).toHaveValue('ramp');await expect(page.locator('[data-stage-from]')).toHaveValue('4');
});
