const $ = id => document.getElementById(id);
const stages = $('stages'); let selected=sessionStorage.getItem('stress-selected') || undefined, runs = [], points = [];
let selectedJob,historyPage=1,historySignature='',lastLibraryRefresh=0,seriesKey,refreshSequence=0;
const comparisonOptions=new Map();
let mode = 'builder';
let loadedTemplate=null,templates=[],dirty=false,cachedCollection,cachedEnvironment,librarySignature='',editorBusy=false;
function icon(name) {
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('icon');svg.setAttribute('aria-hidden','true');
  const use=document.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href',`#i-${name}`);svg.append(use);return svg;
}
function updateLoadSummary() {
  const rows=[...stages.children];
  const duration=rows.reduce((total,row)=>total+(Number(row.children[0].value)||0),0);
  const peak=Math.max(0,...rows.map(row=>Number(row.children[1].value)||0));
  $('load-summary').textContent=`${duration}s · ATÉ ${peak} USUÁRIOS`;
  rows.forEach(row=>row.children[2].disabled=rows.length===1);
  $('add-stage').disabled=rows.length>=50;
  const preview=$('load-preview'),svg=svgElement('svg',{viewBox:'0 0 640 175',role:'img','aria-label':`Carga em degraus: ${duration}s, até ${peak} usuários`});
  let elapsed=0,path='M 45 145';
  for(const row of rows){const target=Number(row.children[1].value)||0,end=elapsed+(Number(row.children[0].value)||0),y=145-target/Math.max(1,peak)*120;
    path+=` L ${45+elapsed/Math.max(1,duration)*570} ${y} L ${45+end/Math.max(1,duration)*570} ${y}`;elapsed=end;}
  svg.append(svgElement('path',{d:path+' L 615 145 L 45 145 Z',fill:'#c0f78022'}),svgElement('path',{d:path,fill:'none',stroke:'#c0f780','stroke-width':3}));
  for(const [x,y,text]of [[45,169,'0s'],[550,169,`${duration}s`],[45,15,`${peak} usuários`]]){const label=svgElement('text',{x,y,fill:'#c0cad7','font-size':13});label.textContent=text;svg.append(label);}preview.replaceChildren(svg);
}
stages.addEventListener('input',updateLoadSummary);
function updateNavigation() {
  const hash=location.hash || '#configure';
  document.body.dataset.view=hash==='#configure'?'configure':hash==='#monitor'?'monitor':'results';
  document.querySelectorAll('.view-tabs a').forEach(link=>{const active=link.hash===(document.body.dataset.view==='results'?'#results-panel':hash);if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');});
  document.querySelectorAll('.nav-link').forEach(link=>{const active=link.getAttribute('href')===hash;link.classList.toggle('active',active);if(active)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current');});
}
window.addEventListener('hashchange',updateNavigation);updateNavigation();
const labels = {scheduled:'Agendado',running:'Executando',stopping:'Encerrando',completed:'Concluído',failed:'Falhou',cancelled:'Cancelado'};
const verdictLabels={approved:'Aprovado',rejected:'Reprovado',inconclusive:'Inconclusivo',partial:'Resultado parcial',pending:'Provisório'};
function addStage(duration=30,target=10) {
  const row = document.createElement('div'); row.className='stage';
  row.innerHTML='<input type="number" min="1" max="86400" required aria-label="Duração do estágio em segundos"><input type="number" min="0" max="500" required aria-label="Usuários do estágio"><button type="button" aria-label="Remover estágio">×</button>';
  row.children[0].value=duration; row.children[1].value=target;
  row.children[2].onclick=()=>{if(stages.children.length>1) row.remove();updateLoadSummary();markDirty();}; stages.append(row);updateLoadSummary();
}
addStage(); addStage(60,20);
$('add-stage').onclick=()=>{if(stages.children.length<50){addStage();markDirty();}};

function setMode(next) {
  mode=next;
  for (const tab of ['builder','postman']) {
    const active=tab===next;
    $(tab+'-tab').setAttribute('aria-selected',String(active));
    $(tab+'-tab').tabIndex=active ? 0 : -1;
    $(tab+'-panel').hidden=!active;
    $(tab+'-panel').disabled=!active;
  }
}
for (const tab of ['builder','postman']) {
  $(tab+'-tab').onclick=()=>{setMode(tab);markDirty();};
  $(tab+'-tab').onkeydown=event=>{
    if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
      event.preventDefault(); const next=event.key==='Home'?'builder':event.key==='End'?'postman':mode==='builder'?'postman':'builder';
      setMode(next);markDirty(); $(next+'-tab').focus();
    }
  };
}
function updateRequests() {
  const rows=[...$('requests').children];
  rows.forEach((row,index)=>{
    row.querySelector('strong').textContent=String(index+1).padStart(2,'0');
    row.querySelector('[data-action="up"]').disabled=index===0;
    row.querySelector('[data-action="down"]').disabled=index===rows.length-1;
    row.querySelector('[data-action="remove"]').disabled=rows.length===1;row.querySelector('[data-action="duplicate"]').disabled=rows.length>=50;
    row.querySelector('.request-label').textContent=row.querySelector('[data-field="name"]').value || 'Requisição';
    row.querySelector('.request-url').textContent=row.querySelector('[data-field="url"]').value || 'URL não definida';
    const validationCount=['expectedStatus','contains','jsonPath','extractPath'].filter(field=>row.querySelector(`[data-field="${field}"]`).value).length;
    row.querySelector('.request-checks').textContent=`${validationCount} validações`;
  });
  $('add-request').disabled=rows.length>=50;
  $('request-count').textContent=`${rows.length} ${rows.length===1?'REQUISIÇÃO':'REQUISIÇÕES'}`;
}
function addRequest(step={}) {
  if ($('requests').children.length>=50) return;
  const row=document.createElement('details');row.className='request-card';row.open=true;
  row.innerHTML=`<summary class="request-head"><div class="request-identity"><strong></strong><span class="request-label">Requisição</span><span class="method-badge">GET</span><span class="request-url"></span><span class="request-checks"></span></div><div class="request-controls"><button type="button" data-action="up" aria-label="Mover requisição para cima">↑</button><button type="button" data-action="down" aria-label="Mover requisição para baixo">↓</button><button type="button" data-action="duplicate" aria-label="Duplicar requisição">⧉</button><button type="button" data-action="remove" aria-label="Remover requisição">×</button></div></summary>
    <div class="request-body"><label>Nome da requisição<input data-field="name" placeholder="Ex.: criar cliente" maxlength="120"></label>
    <div class="endpoint"><label>Método<select data-field="method"><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option><option>HEAD</option><option>OPTIONS</option></select></label><label>URL<input data-field="url" placeholder="https://sua-api.com/endpoint" required></label></div>
    <details><summary>Headers e corpo da requisição</summary>
      <label>Headers<textarea data-field="headers" rows="3" placeholder="Authorization: Bearer {{TOKEN}}&#10;Accept: application/json"></textarea><small>Um por linha: Nome: valor.</small></label>
      <label>Tipo de corpo<select data-field="bodyType"><option value="none">Sem corpo</option><option value="json">JSON</option><option value="text">Texto</option></select></label>
      <label data-body-label hidden>Corpo<textarea data-field="body" rows="5" placeholder='{"email":"{{UNIQUE_EMAIL}}"}' disabled></textarea><small>Use variáveis para dados dinâmicos. JSON recebe Content-Type automaticamente.</small></label>
    </details>
    <details><summary>Validações e extração de variáveis</summary>
      <div class="pair"><label>Status esperado<input data-field="expectedStatus" type="number" min="100" max="599" value="200" placeholder="Opcional"></label><label>Resposta contém<input data-field="contains" placeholder="Texto opcional"></label></div>
      <div class="pair"><label>Campo JSON<input data-field="jsonPath" placeholder="data.id"></label><label>Valor esperado (JSON)<input data-field="jsonValue" placeholder='123 ou "texto" ou true'></label></div>
      <small>O caminho usa pontos, como items.0.id. O valor precisa ser JSON válido.</small>
      <div class="pair"><label>Extrair campo JSON<input data-field="extractPath" placeholder="data.token"></label><label>Salvar na variável<input data-field="extractVariable" placeholder="TOKEN"></label></div>
      <small>Nas próximas requisições, use {{TOKEN}} para o valor extraído.</small>
    </details></div>`;
  row.dataset.method='GET';
  row.querySelector('[data-field="method"]').onchange=event=>{row.dataset.method=event.target.value;row.querySelector('.method-badge').textContent=event.target.value;};
  row.querySelector('[data-field="bodyType"]').onchange=event=>{
    const visible=event.target.value!=='none';row.querySelector('[data-body-label]').hidden=!visible;row.querySelector('[data-field="body"]').disabled=!visible;
  };
  row.addEventListener('input',updateRequests);
  row.querySelectorAll('[data-action]').forEach(button=>button.onclick=event=>{
    event.preventDefault();event.stopPropagation();
    const action=button.dataset.action;
    if(action==='up'&&row.previousElementSibling)row.parentNode.insertBefore(row,row.previousElementSibling);
    if(action==='down'&&row.nextElementSibling)row.parentNode.insertBefore(row.nextElementSibling,row);
    if(action==='duplicate'){try{addRequest(readStep(row,[...$('requests').children].indexOf(row)));}catch(e){showError(e);}}
    if(action==='remove'&&$('requests').children.length>1)row.remove();
    updateRequests();markDirty();
  });
  const field=(name,value)=>{row.querySelector(`[data-field="${name}"]`).value=value ?? '';};
  for(const name of ['name','url','body','contains'])if(step[name]!==undefined)field(name,step[name]);
  if(step.method)field('method',step.method);if(step.bodyType)field('bodyType',step.bodyType);
  if(step.expectedStatus!==undefined)field('expectedStatus',step.expectedStatus);
  if(step.headers)field('headers',step.headers.map(h=>`${h.key}: ${h.value}`).join('\n'));
  if(step.jsonCheck){field('jsonPath',step.jsonCheck.path);field('jsonValue',JSON.stringify(step.jsonCheck.value));}
  if(step.extract){field('extractPath',step.extract.path);field('extractVariable',step.extract.variable);}
  row.querySelector('[data-field="method"]').dispatchEvent(new Event('change'));
  row.querySelector('[data-field="bodyType"]').dispatchEvent(new Event('change'));
  $('requests').append(row);updateRequests();
}
function pairs(value, separator, label) {
  return value.split(/\r?\n/).filter(line=>line.trim()).map(line=>{
    const at=line.indexOf(separator);
    if(at<1)throw new Error(`${label}: use Nome${separator} valor, um por linha.`);
    return {key:line.slice(0,at).trim(),value:line.slice(at+1).trim()};
  });
}
function readStep(row,index) {
  const value=field=>row.querySelector(`[data-field="${field}"]`).value;
  const problem=(message,field)=>{throw Object.assign(new Error(`Requisição ${index+1}: ${message}`),{step:index,field});};
  let headers;try{headers=pairs(value('headers'),':','Headers');}catch(e){problem(e.message,'headers');}
  const step={name:value('name'),method:value('method'),url:value('url').trim(),headers,bodyType:value('bodyType'),body:value('body'),expectedStatus:value('expectedStatus'),contains:value('contains')};
  if(value('jsonPath')||value('jsonValue')) {
    if(!value('jsonPath')||!value('jsonValue'))problem('informe o campo e o valor JSON esperado.','jsonValue');
    try {step.jsonCheck={path:value('jsonPath').trim(),value:JSON.parse(value('jsonValue'))};}
    catch {problem('valor esperado precisa ser JSON válido.','jsonValue');}
  }
  if(value('extractPath')||value('extractVariable')) {
    if(!value('extractPath')||!value('extractVariable'))problem('informe o campo e o nome da variável extraída.','extractVariable');
    step.extract={path:value('extractPath').trim(),variable:value('extractVariable').trim()};
  }
  return step;
}
function readScenario() {
  return {variables:pairs($('variables').value,'=','Variáveis'),steps:[...$('requests').children].map(readStep)};
}
function clearErrors() {
  document.querySelectorAll('.field-error').forEach(el=>el.remove());
  document.querySelectorAll('[aria-invalid=true]').forEach(el=>{el.removeAttribute('aria-invalid');el.removeAttribute('aria-describedby');});
}
function showError(error) {
  $('message').textContent=error.message;$('message').className='error';
  let input;
  if(Number.isInteger(error.step))input=$('requests').children[error.step]?.querySelector(`[data-field="${error.field || 'url'}"]`);
  if(!input && error.field)input=$('form').elements.namedItem(error.field);
  if(input) {
    location.hash='#configure';
    let parent=input.parentElement;while(parent){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement;}
    input.setAttribute('aria-invalid','true');
    clearErrors();const message=document.createElement('small');message.className='field-error';message.id='field-error';message.textContent=error.message;
    input.setAttribute('aria-invalid','true');
    input.after(message);input.setAttribute('aria-describedby',message.id);
    // Busy operations make the form inert; focus after their finally block.
    requestAnimationFrame(()=>input.focus());
  }
}
$('form').addEventListener('input',clearErrors);
$('add-request').onclick=()=>{addRequest();markDirty();};
addRequest();setMode('builder');

async function api(url, data) {
  const res = await fetch(url,data === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result = await res.json(); if(!res.ok)throw Object.assign(new Error(result.error || 'Falha na requisição'),{step:result.step,field:result.field}); return result;
}
async function readFile(id, required=false) {
  const file=$(id).files[0]; if(!file){if(required)throw new Error('Selecione a collection');return undefined;}
  if(file.size>5*1024*1024)throw new Error('Arquivo excede 5 MB');
  try{return JSON.parse(await file.text());}catch{throw new Error(`${file.name}: JSON inválido`);}
}
$('collection').onchange=async()=>{try{const c=await readFile('collection');$('collection-name').textContent=c?.info?.name || cachedCollection?.info?.name || 'Selecione uma collection com requisições.';}catch(e){$('collection-name').textContent=e.message;}};
$('form').addEventListener('invalid',event=>{
  event.preventDefault();if(document.querySelector('.field-error'))return;
  const row=event.target.closest('.request-card'),step=row?[...$('requests').children].indexOf(row):undefined;
  showError(Object.assign(new Error(event.target.validationMessage || 'Preencha este campo.'),{step,field:event.target.dataset.field || event.target.name || event.target.id}));
},true);
$('form').onsubmit=async event=>{
  event.preventDefault();clearErrors(); $('submit').disabled=true; $('message').textContent='Preparando teste…'; $('message').className='';
  updateLoadSummary();
  try {
    const input=await collectInput(true);
    const job=await api('/api/runs',input); selectRun(job.id);location.hash='#monitor';
    $('message').textContent=input.scheduledAt?'Teste agendado. Mantenha o servidor aberto para executar.':'Teste iniciado.'; await refresh();
  }catch(e){showError(e);}
  finally{$('submit').disabled=false;}
};

async function collectInput(includeSchedule=false) {
  const form=$('form').elements;
  const source=mode==='builder'?{scenario:readScenario()}:{collection:$('collection').files.length?await readFile('collection',true):cachedCollection,environment:$('environment').files.length?await readFile('environment'):cachedEnvironment};
  if(mode==='postman' && !source.collection)throw new Error('Selecione uma collection');
  const input={schemaVersion:2,name:form.name.value,mode,...source,
    stages:[...stages.children].map(row=>({durationSec:Number(row.children[0].value),target:Number(row.children[1].value)})),
    maxWorkers:Number(form.maxWorkers.value),timeout:Number(form.timeout.value),scriptTimeout:Number(form.scriptTimeout.value),scenarioTimeout:Number(form.scenarioTimeout.value),drainTimeout:Number(form.drainTimeout.value),evidence:{minResponses:Number(form.minResponses.value),minLoadPercent:Number(form.minLoadPercent.value)},thinkTime:Number(form.thinkTime.value),
    keepAlive:form.keepAlive.checked,bail:form.bail.checked,insecure:form.insecure.checked,
    thresholds:{p95:Number(form.p95.value),errorRate:Number(form.errorRate.value)}};
  if(includeSchedule && $('execution-time').value==='schedule' && form.scheduledAt.value)input.scheduledAt=new Date(form.scheduledAt.value).toISOString();
  return input;
}
function editorState() {
  $('editor-status').textContent=dirty?'NÃO SALVO':loadedTemplate?'SALVO':'NOVO';
  $('editor-status').className=`badge ${dirty?'scheduled':loadedTemplate?'completed':'neutral'}`;
  $('editing-note').hidden=!loadedTemplate;
  $('editing-label').textContent=loadedTemplate?`Editando: ${loadedTemplate.name} · versão ${loadedTemplate.revision}`:'';
  $('save-label').textContent=loadedTemplate?'Salvar alterações':'Salvar teste';
  $('save-copy').hidden=!loadedTemplate;
}
function markDirty(event) {if(event?.target?.name==='scheduledAt' || event?.target?.id==='execution-time')return;dirty=true;editorState();}
$('form').addEventListener('input',markDirty);$('form').addEventListener('change',markDirty);
function setEditorBusy(value) {
  editorBusy=value;$('form').inert=value;$('new-test').disabled=value;$('save-test').disabled=value;$('save-copy').disabled=value;renderLibrary();
}
function canReplace() {if(editorBusy){libraryMessage('Aguarde a operação atual terminar.');return false;}return !dirty || window.confirm('Há alterações não salvas. Deseja substituí-las?');}
function resetEditor() {
  $('form').reset();scheduleMode();clearErrors();loadedTemplate=null;cachedCollection=cachedEnvironment=undefined;
  $('collection').required=true;$('collection-name').textContent='Selecione uma collection com requisições.';
  $('environment-name').textContent='';$('clear-environment').hidden=true;
  $('requests').replaceChildren();addRequest();stages.replaceChildren();addStage();addStage(60,20);setMode('builder');
  dirty=false;editorState();$('message').textContent='';renderLibrary();
}
function newTest() {if(!canReplace())return;resetEditor();location.hash='#configure';$('form').elements.name.focus();}
$('new-test').onclick=newTest;$('detach-template').onclick=newTest;
$('clear-environment').onclick=()=>{cachedEnvironment=undefined;$('environment').value='';$('environment-name').textContent='';$('clear-environment').hidden=true;markDirty();};
async function loadTemplate(id) {
  if(!canReplace())return false;
  setEditorBusy(true);
  try {
    const item=await api(`/api/templates/${id}`),d=item.definition;
    resetEditor();const form=$('form').elements;
    for(const name of ['name','maxWorkers','timeout','scriptTimeout','scenarioTimeout','drainTimeout','thinkTime'])form[name].value=d[name];
    for(const name of ['keepAlive','bail','insecure'])form[name].checked=d[name];
    form.p95.value=d.thresholds.p95;form.errorRate.value=d.thresholds.errorRate;form.minResponses.value=d.evidence?.minResponses ?? 1;form.minLoadPercent.value=d.evidence?.minLoadPercent ?? 0;
    stages.replaceChildren();d.stages.forEach(stage=>addStage(stage.durationSec,stage.target));
    if(d.mode==='builder') {
      $('requests').replaceChildren();d.scenario.steps.forEach(addRequest);
      $('variables').value=(d.scenario.variables || []).map(v=>`${v.key}=${v.value}`).join('\n');
    } else {
      cachedCollection=d.collection;cachedEnvironment=d.environment;
      $('collection').required=false;$('collection-name').textContent=`Carregada: ${d.collection.info.name || d.name}. Selecione um arquivo para substituir.`;
      $('environment-name').textContent=d.environment?`Carregado: ${d.environment.name || 'Environment salvo'}`:'';
      $('clear-environment').hidden=!d.environment;
    }
    setMode(d.mode);loadedTemplate={id:item.id,name:d.name,revision:item.revision};dirty=false;editorState();renderLibrary();
    $('message').textContent='Teste carregado. Você pode editar, executar ou agendar.';
    location.hash='#configure';return true;
  } catch(e) {libraryMessage(e.message,true);return false;}
  finally{setEditorBusy(false);}
}
async function saveTemplate(asNew=false) {
  if(editorBusy || !$('form').reportValidity())return;
  setEditorBusy(true);
  try {
    const input=await collectInput();const editing=loadedTemplate && !asNew;
    if(editing)input.revision=loadedTemplate.revision;
    const item=await api(editing?`/api/templates/${loadedTemplate.id}`:'/api/templates',input);
    loadedTemplate={id:item.id,name:item.name,revision:item.revision};$('form').elements.name.value=item.name;dirty=false;editorState();
    $('message').className='';$('message').textContent=editing?'Alterações salvas.':'Teste salvo na sua biblioteca.';
    await refreshLibrary();
  }catch(e){showError(e);}
  finally{setEditorBusy(false);}
}
$('save-test').onclick=()=>saveTemplate();$('save-copy').onclick=()=>saveTemplate(true);
function libraryMessage(message,error=false) {$('library-message').textContent=message;$('library-message').classList.toggle('error',error);}
async function duplicateTemplate(id) {
  if(editorBusy)return;
  try {await api(`/api/templates/${id}/duplicate`,{});await refreshLibrary();libraryMessage('Cópia criada na biblioteca.');}catch(e){libraryMessage(e.message,true);}
}
async function deleteTemplate(item) {
  if(editorBusy)return;
  if(!window.confirm(`Excluir o teste salvo "${item.name}"? O histórico de execuções será mantido.`))return;
  try {
    await api(`/api/templates/${item.id}/delete`,{});
    if(loadedTemplate?.id===item.id){loadedTemplate=null;dirty=true;editorState();}
    await refreshLibrary();libraryMessage('Teste excluído. O histórico foi mantido.');
  }catch(e){libraryMessage(e.message,true);}
}
function renderLibrary() {
  const search=$('saved-search').value.trim().toLocaleLowerCase('pt-BR');
  const signature=JSON.stringify([templates,loadedTemplate?.id,search,editorBusy]);if(signature===librarySignature)return;librarySignature=signature;
  $('saved-count').textContent=`${templates.length} ${templates.length===1?'TESTE':'TESTES'}`;$('saved-nav-count').textContent=templates.length;
  const filtered=templates.filter(item=>item.name.toLocaleLowerCase('pt-BR').includes(search));
  $('saved-list').replaceChildren(...filtered.map(item=>{
    const card=document.createElement('div');card.className='saved-item';card.dataset.selected=String(item.id===loadedTemplate?.id);
    const title=document.createElement('div');title.className='saved-title';const name=document.createElement('strong');name.textContent=item.name;
    const badge=document.createElement('span');badge.className='badge neutral';badge.textContent=item.mode==='builder'?'INTERFACE':'POSTMAN';title.append(name,badge);
    const meta=document.createElement('span');meta.className='saved-meta';meta.textContent=`${item.steps} requisições · ${item.durationSec}s · até ${item.peakUsers} usuários · atualizado em ${new Date(item.updatedAt).toLocaleString('pt-BR')}`;
    const actions=document.createElement('div');actions.className='saved-actions';
    for(const [label,cls,action]of [['Carregar','load-template',()=>loadTemplate(item.id)],['Duplicar','duplicate-template',()=>duplicateTemplate(item.id)],['Excluir','delete-template',()=>deleteTemplate(item)]]){
      const button=document.createElement('button');button.type='button';button.className=cls;button.textContent=label;button.disabled=editorBusy;button.setAttribute('aria-label',`${label} ${item.name}`);button.onclick=action;actions.append(button);
    }
    card.append(title,meta,actions);return card;
  }));
  if(!filtered.length){const empty=document.createElement('div');empty.className='empty-history';const title=document.createElement('strong');title.textContent=search?'Nenhum teste encontrado.':'Salve seu primeiro cenário.';const help=document.createElement('p');help.textContent=search?'Tente buscar por outro nome.':'Configure um teste e clique em Salvar teste para reutilizá-lo depois.';empty.append(icon('save'),title,help);$('saved-list').append(empty);}
}
async function refreshLibrary() {templates=await api('/api/templates');renderLibrary();}
$('saved-search').oninput=renderLibrary;
editorState();

function renderMetrics(s={}) {
  const metrics=[['Requisições',s.requests ?? 0,'Tentativas HTTP'],['RPS',Number(s.rps || 0).toFixed(1),'Média da execução'],['Usuários',`${s.active || 0} / ${s.target || 0}`,'Alocados / alvo'],['p95',s.p95 == null?'—':`${s.p95} ms`,`${number(s.samples,0)} respostas com latência`],['p99',s.p99 == null?'—':`${s.p99} ms`,'99% das respostas'],['Falhas',`${Number(s.errorRate || 0).toFixed(2)}%`,'HTTP ≥400 ou conexão']];
  $('metrics').replaceChildren(...metrics.map(([label,value,help])=>{const el=document.createElement('div');el.className='metric';for(const [tag,text]of [['span',label],['strong',value],['small',help]]){const child=document.createElement(tag);child.textContent=text;if(tag==='span')child.append(icon(label==='Usuários'?'users':label==='Falhas'?'shield':label==='Requisições'?'code':label==='RPS'?'pulse':'clock'));el.append(child);}return el;}));
}
renderMetrics();
function repeatSources(job) {
  const signature=JSON.stringify(templates.map(t=>[t.id,t.name]));
  if($('repeat-template').dataset.signature!==signature) {
    const previous=$('repeat-template').value;const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Selecione um teste salvo';
    $('repeat-template').replaceChildren(placeholder,...templates.map(t=>{const option=document.createElement('option');option.value=t.id;option.textContent=t.name;return option;}));
    $('repeat-template').value=previous;$('repeat-template').dataset.signature=signature;
  }
  if($('repeat-template').dataset.run!==job.id) {$('repeat-template').value='';$('repeat-template').dataset.run=job.id;}
}
$('repeat').onclick=async()=>{
  const job=selectedJob;if(!job)return;
  $('repeat').disabled=true;$('repeat-message').hidden=true;
  try {
    let next;
    if(job.canRepeat)next=await api(`/api/runs/${job.id}/repeat`,{});
    else {
      const id=$('repeat-template').value;
      if(!id){$('repeat-template').focus();throw new Error('Escolha um teste salvo acima para executar novamente.');}
      const template=await api(`/api/templates/${id}`);
      next=await api('/api/runs',template.definition);
    }
    selectRun(next.id);location.hash='#monitor';$('message').className='';$('message').textContent='Nova execução iniciada. O relatório anterior continua no histórico.';
    await refresh();
  }catch(error){$('message').className='error';$('message').textContent=error.message;$('repeat-message').hidden=false;$('repeat-message').textContent=error.message;$('repeat-message').dataset.run=job.id;}
  finally{$('repeat').disabled=false;}
};
function scheduleMode() {
  const scheduled=$('execution-time').value==='schedule';
  $('schedule-field').hidden=!scheduled;
  $('form').elements.scheduledAt.disabled=!scheduled;
  $('form').elements.scheduledAt.required=scheduled;
  $('submit').querySelector('span').textContent=scheduled?'Agendar teste de carga':'Iniciar teste de carga';
  $('schedule-zone').textContent=`Fuso: ${Intl.DateTimeFormat().resolvedOptions().timeZone}. O servidor precisa estar ligado.`;
}
$('execution-time').onchange=scheduleMode;scheduleMode();
async function preflight(once) {
  if(editorBusy || !$('form').reportValidity())return;
  clearErrors();setEditorBusy(true);
  try {
    const input=await collectInput();
    const result=await api(once?'/api/runs/check':'/api/validate',input);
    $('message').className='';
    if(once){selectRun(result.id);location.hash='#monitor';$('message').textContent='Verificação funcional iniciada: um cenário com um usuário.';await refresh();}
    else $('message').textContent=`Configuração válida: ${result.steps} requisições · ${result.durationSec}s. Nenhuma requisição foi enviada.`;
  }catch(e){showError(e);}finally{setEditorBusy(false);}
}
$('validate-config').onclick=()=>preflight(false);$('check-once').onclick=()=>preflight(true);
function selectRun(id) {
  selected=id;sessionStorage.setItem('stress-selected',id);selectedJob=undefined;seriesKey=undefined;points=[];
  $('comparison-note').textContent='';$('comparison-output').replaceChildren();
  renderCharts([]);historySignature='';
}
function number(value,precision=2) {return Number.isFinite(value)?value.toLocaleString('pt-BR',{maximumFractionDigits:precision}):value===true?'Sim':value===false?'Não':value ?? '—';}
function tableBody(id,rows) {
  const body=$(id).querySelector('tbody'),signature=JSON.stringify(rows);
  if(body.dataset.signature===signature)return;body.dataset.signature=signature;
  body.replaceChildren(...rows.map(values=>{const row=document.createElement('tr');values.forEach(value=>{const cell=document.createElement('td');cell.textContent=number(value);row.append(cell);});return row;}));
}
function verdict(job) {
  return job.result?.evaluation?.verdict || (job.status==='completed'?(job.result?.passed?'approved':'rejected'):['failed','cancelled'].includes(job.status)?'partial':'pending');
}
function render(job) {
  selectedJob=job;
  const s=job.result || {},finished=['completed','cancelled','failed'].includes(job.status),outcome=verdict(job);
  if($('repeat-message').dataset.run!==job.id)$('repeat-message').hidden=true;
  $('repeat').hidden=!finished;$('repeat-source').hidden=!finished || job.canRepeat;
  if(finished&&!job.canRepeat)repeatSources(job);
  $('status').textContent=finished?verdictLabels[outcome]:labels[job.status] || job.status;
  const statusClass=outcome==='approved'?'completed':outcome==='rejected'?'failed':finished?'scheduled':['running','stopping'].includes(job.status)?'running':'neutral';
  $('status').className=`badge ${statusClass}`;
  $('run-name').textContent=job.name;
  $('run-info').textContent=`${new Date(job.scheduledAt).toLocaleString('pt-BR')} · ${s.purpose==='check'?'Verificação funcional':`Estágio ${s.stage || 0}`} · ${number(s.elapsed || 0)} segundos`;
  renderMetrics(s);
  const reasons=s.evaluation?.reasons || [];
  const text=s.failure || (finished?`${verdictLabels[outcome]}. ${reasons.length?reasons.join(' · '):outcome==='approved'?'Cumpriu os critérios configurados.':'Resultados parciais.'}`:job.status==='scheduled'?'Aguardando horário. Agendamentos sobrepostos entram na fila.':'Coletando resultados. Critérios provisórios até o encerramento.');
  $('verdict').textContent=text;$('verdict').className=`verdict ${outcome==='approved'?'success':outcome==='rejected'?'error':'pending'}`;
  $('cancel').hidden=!['scheduled','running','stopping'].includes(job.status);
  const ready=finished && (s.reportStatus==='ready' || (!s.reportStatus && s.csvRows));
  $('xlsx').hidden=!ready;$('xlsx').href=`/api/runs/${job.id}/xlsx`;
  $('regenerate').hidden=!finished || s.reportStatus!=='error';
  $('report-message').hidden=!s.reportStatus;
  $('report-message').textContent=s.reportStatus==='error'?`Não foi possível gerar o XLSX: ${s.reportError}`:s.reportStatus==='ready'&&s.reportInfo?`${s.reportInfo.sheets} abas · ${s.reportInfo.charts} gráficos · ${number(s.reportInfo.rows,0)} tentativas detalhadas · ${number(s.reportInfo.bytes/1024,0)} KB`:'Preparando relatório XLSX…';
  $('report-message').classList.toggle('error',s.reportStatus==='error');
  $('diagnostics').hidden=!job.result;
  $('details').textContent=`HTTP: ${Object.entries(s.codes||{}).map(([code,n])=>`${code}: ${n}`).join(' · ')}\nConexão: ${s.transportErrors||0} · Validações: ${s.assertionFailures||0} · Scripts: ${s.scriptFailures||0} · Execuções: ${s.runFailures||0}\nAlocados: ${s.active||0} · Cenários em execução: ${s.busy||0} · Em pausa: ${s.paused||0}\nMemória do gerador: ${number(s.rssMB,0)} MB · CPU do gerador: ${number(s.cpuPercent)}% (100% = 1 núcleo)\nEvent loop principal: ${number(s.eventLoopLagMs)} ms · Workers: ${number(s.workerEventLoopLagMs)} ms\nCarga: ${number(s.loadElapsed)}s · Drenagem: ${number(s.drainElapsed)}s · RPS da carga: ${number(s.loadRps)}\nTentativas interrompidas: ${s.interruptedRequests || 0}`;
  $('result-title').textContent=job.name;$('result-verdict').textContent=text;$('result-verdict').className=$('verdict').className;
  $('result-context').textContent=`${s.purpose==='check'?'Verificação funcional de um cenário; não comprova capacidade de carga.':'Modelo fechado de usuários simultâneos.'} ${s.samples===undefined?'Volume de respostas não registrado.':`${number(s.samples,0)} respostas com latência.`} Metodologia ${s.methodologyVersion || '1 (histórico)'} · carga ${number(s.loadElapsed)}s · drenagem ${number(s.drainElapsed)}s · RPS global ${number(s.rps)} · RPS da carga ${number(s.loadRps)}. ${$('report-message').textContent}`;
  $('result-repeat').hidden=!finished;$('result-repeat').textContent=job.canRepeat?'Executar novamente':'Escolher teste para repetir';
  $('result-xlsx').hidden=!ready;$('result-xlsx').href=$('xlsx').href;$('result-regenerate').hidden=$('regenerate').hidden;
  tableBody('criteria-table',s.evaluation?.criteria.map(c=>[c.label,c.observed,c.limit,s.evaluation.provisional?'Provisório':c.passed?'Passou':'Falhou']) || [['Metodologia original','Não registrado','—','Consultar XLSX']]);
  tableBody('evidence-table',s.stages?.map(stage=>[stage.stage,stage.target,stage.plannedUserSeconds,stage.observedUserSeconds,stage.loadPercent===null?'Sem carga':`${number(stage.loadPercent)}%`]) || [['Não registrado','—','—','—','—']]);
  tableBody('integrity-table',s.reportInfo?.integrityDetails?.checks.map(c=>[c.counter,c.expected,c.recorded,c.matches?'Confere':'Diverge']) || [['Conferência disponível após a coleta','—','—','—']]);
  tableBody('endpoints-table',s.reportInfo?.endpoints?.map(e=>[e.name,e.method,e.requests,e.failed,e.p95]) || [['Disponível após gerar o relatório','—','—','—','—']]);
  const f=s.reportInfo?.failureCounts || {http:Object.entries(s.codes || {}).reduce((n,[code,count])=>n+(Number(code)>=400?count:0),0),transport:s.transportErrors || 0,validation:s.assertionFailures || 0,script:s.scriptFailures || 0,run:s.runFailures || 0};
  $('failure-summary').textContent=`HTTP: ${f.http} · Transporte: ${f.transport} · Validações: ${f.validation} · Scripts: ${f.script} · Execuções: ${f.run}. A taxa HTTP não soma falhas de validação.`;
  comparisonOptions.set(job.id,job.name);renderComparisonOptions();
}
$('cancel').onclick=async()=>{try{await api(`/api/runs/${selected}/cancel`,{});await refresh();}catch(e){showError(e);}};
$('regenerate').onclick=async()=>{
  if(!selected)return;const id=selected;$('regenerate').disabled=$('result-regenerate').disabled=true;
  try{await api(`/api/runs/${id}/regenerate`,{});await refresh();}catch(e){$('report-message').hidden=false;$('report-message').textContent=e.message;$('result-context').textContent=e.message;}
  finally{$('regenerate').disabled=$('result-regenerate').disabled=false;}
};
$('result-regenerate').onclick=()=>$('regenerate').click();
$('result-repeat').onclick=()=>{if(selectedJob?.canRepeat)$('repeat').click();else{location.hash='#monitor';$('repeat-template').focus();}};
function renderComparisonOptions() {
  const signature=JSON.stringify([...comparisonOptions]);const select=$('compare-baseline');if(select.dataset.signature===signature)return;
  select.dataset.signature=signature;const previous=select.value;
  const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Selecione uma execução do histórico';
  select.replaceChildren(placeholder,...[...comparisonOptions].map(([id,name])=>{const o=document.createElement('option');o.value=id;o.textContent=`${name} · ${id.slice(0,8)}`;return o;}));select.value=previous;
}
function simpleTable(headers,rows) {
  const table=document.createElement('table'),head=document.createElement('thead'),tr=document.createElement('tr');
  headers.forEach(label=>{const th=document.createElement('th');th.textContent=label;tr.append(th);});head.append(tr);table.append(head);
  const body=document.createElement('tbody');rows.forEach(values=>{const r=document.createElement('tr');values.forEach(value=>{const td=document.createElement('td');td.textContent=typeof value==='object'&&value!==null?JSON.stringify(value):number(value);r.append(td);});body.append(r);});table.append(body);return table;
}
$('compare-runs').onclick=async()=>{
  const baseline=$('compare-baseline').value,id=selected;
  if(!baseline || !id || baseline===id){$('comparison-note').textContent='Selecione uma referência diferente da execução atual.';return;}
  try {
    const data=await api(`/api/runs/compare?left=${encodeURIComponent(baseline)}&right=${encodeURIComponent(id)}`);if(id!==selected)return;
    $('comparison-note').textContent=data.differences.length?`Configurações diferentes: ${data.differences.map(d=>d.field).join(', ')}. Considere essas diferenças ao interpretar as métricas.`:'As configurações registradas são iguais. Variações não comprovam causalidade.';
    $('comparison-output').replaceChildren(simpleTable(['Métrica','Referência','Selecionada','Diferença','Variação (%)'],data.metrics.map(m=>[m.field,m.left,m.right,m.delta,m.percent])),simpleTable(['Configuração diferente','Referência','Selecionada'],data.differences.map(d=>[d.field,d.left,d.right])));
  }catch(e){$('comparison-note').textContent=e.message;}
};
const graphSpecs=[{key:'active',label:'Usuários observados / último alvo',unit:'usuários',target:true},{key:'rps',label:'RPS por janela',unit:'req/s'},{key:'p95',label:'p95 por janela',unit:'ms'},{key:'errorRate',label:'Falhas HTTP / conexão',unit:'%',percent:true}];
function svgElement(name,attrs={}) {const el=document.createElementNS('http://www.w3.org/2000/svg',name);Object.entries(attrs).forEach(([key,value])=>el.setAttribute(key,value));return el;}
function renderCharts(data) {
  const container=$('metric-charts');
  if(!container.children.length)for(const spec of graphSpecs){
    const card=document.createElement('section');card.className='metric-chart';card.dataset.metric=spec.key;
    const title=document.createElement('h3');title.textContent=spec.label;
    const svg=svgElement('svg',{viewBox:'0 0 640 190',role:'img','aria-label':spec.label});
    const readout=document.createElement('p');readout.className='chart-readout';readout.setAttribute('aria-live','polite');
    const slider=document.createElement('input');slider.type='range';slider.min=0;slider.setAttribute('aria-label',`Consultar janela: ${spec.label}`);
    card.append(title,svg,readout,slider);container.append(card);
  }
  for(const spec of graphSpecs){
    const card=container.querySelector(`[data-metric="${spec.key}"]`),svg=card.querySelector('svg'),slider=card.querySelector('input');
    const val=p=>spec.percent?p[spec.key]*100:p[spec.key];
    const maximum=Math.max(1,...data.map(p=>val(p) || 0),...(spec.target?data.map(p=>p.target || 0):[]));
    const end=data.length?data[data.length-1].second+data[data.length-1].duration:1;
    const x=second=>45+second/end*580,y=value=>155-value/maximum*130;
    const children=[];
    for(let i=0;i<3;i++){const value=maximum*i/2;children.push(svgElement('line',{x1:45,x2:625,y1:y(value),y2:y(value),stroke:'#3d4651'}));const label=svgElement('text',{x:40,y:y(value)+4,'text-anchor':'end',fill:'#c0cad7','font-size':12});label.textContent=number(value,1);children.push(label);}
    const path=key=>{let segment=false;return data.map(p=>{const value=key==='target'?p.target:val(p);if(value===null || value===undefined){segment=false;return '';}const command=segment?'L':'M';segment=true;return `${command} ${x(p.second)} ${y(value)}`;}).join(' ');};
    children.push(svgElement('path',{d:path(spec.key),fill:'none',stroke:'#c0f780','stroke-width':2.5}));
    if(spec.target)children.push(svgElement('path',{d:path('target'),fill:'none',stroke:'#8fb9ef','stroke-width':2,'stroke-dasharray':'5 4'}));
    // A singleton M path has no visible line. Preserve isolated observations.
    for(const key of [spec.key,...(spec.target?['target']:[])]) {
      const valid=data.filter(p=>Number.isFinite(key==='target'?p.target:val(p)));
      if(valid.length===1){const p=valid[0];children.push(svgElement('circle',{cx:x(p.second),cy:y(key==='target'?p.target:val(p)),r:4,fill:key==='target'?'#8fb9ef':'#c0f780'}));}
    }
    for(const [second,anchor]of [[0,'start'],[end,'end']]){const label=svgElement('text',{x:x(second),y:181,'text-anchor':anchor,fill:'#c0cad7','font-size':12});label.textContent=`${number(second,1)}s`;children.push(label);}
    svg.replaceChildren(...children);slider.disabled=!data.length;slider.max=Math.max(0,data.length-1);
    if(slider.dataset.run!==selected){slider.value=slider.max;slider.dataset.run=selected;}else if(document.activeElement!==slider)slider.value=slider.max;
    const display=index=>{const p=data[index];card.querySelector('.chart-readout').textContent=p?`${new Date(p.ts).toLocaleTimeString('pt-BR')} · ${number(p.second,1)}–${number(p.second+p.duration,1)}s: ${number(val(p))} ${spec.unit}${spec.target?` · alvo ${number(p.target)}`:''}${spec.key==='p95'?` · ${number(p.samples,0)} respostas`:''}`:'Aguardando dados registrados.';};
    slider.oninput=()=>display(Number(slider.value));display(Number(slider.value));
    svg.onpointermove=event=>{if(!data.length)return;const rect=svg.getBoundingClientRect(),second=Math.max(0,Math.min(end,((event.clientX-rect.left)/rect.width*640-45)/580*end));const index=Math.min(data.length-1,data.findIndex(p=>p.second+p.duration>second));display(index<0?data.length-1:index);};
  }
}
renderCharts([]);
function renderHistory(data) {
  runs=data.items;const signature=JSON.stringify([runs,selected,historyPage,data.total]);
  $('count').textContent=`${data.total} execuções`;$('nav-count').textContent=data.overview.total;
  $('overview-total').textContent=data.overview.total;$('overview-completed').textContent=data.overview.completed;$('overview-scheduled').textContent=data.overview.scheduled;
  $('history-page').textContent=`Página ${historyPage} de ${Math.max(1,Math.ceil(data.total/data.pageSize))}`;
  $('history-prev').disabled=historyPage===1;$('history-next').disabled=historyPage*data.pageSize>=data.total;
  for(const job of runs)comparisonOptions.set(job.id,job.name);renderComparisonOptions();
  if(signature===historySignature)return;historySignature=signature;
  const focused=document.activeElement?.closest('.history-row')?.dataset.id;
  $('history').replaceChildren(...runs.map(job=>{
    const button=document.createElement('button');button.type='button';button.className='history-row';button.dataset.id=job.id;button.dataset.status=job.status;button.setAttribute('aria-current',String(selected===job.id));
    const title=document.createElement('strong');title.textContent=job.name;
    const info=document.createElement('span');info.textContent=`${new Date(job.scheduledAt).toLocaleString('pt-BR')}${job.result?.purpose==='check'?' · Verificação':''}`;
    const symbol=document.createElement('span');symbol.className='history-symbol';symbol.append(icon(job.status==='scheduled'?'clock':job.status==='completed'?'shield':'pulse'));
    const content=document.createElement('div');content.className='history-text';content.append(title,info);
    const badge=document.createElement('span'),outcome=verdict(job);badge.className=`badge ${outcome==='approved'?'completed':outcome==='rejected'?'failed':'scheduled'}`;
    badge.textContent=['completed','failed','cancelled'].includes(job.status)?verdictLabels[outcome]:labels[job.status] || job.status;
    button.append(symbol,content,badge);button.onclick=()=>{selectRun(job.id);location.hash=['running','stopping','scheduled'].includes(job.status)?'#monitor':'#results-panel';refresh().catch(showError);};return button;
  }));
  if(!runs.length){const empty=document.createElement('p');empty.className='empty-history';empty.textContent=data.overview.total?'Nenhuma execução corresponde aos filtros.':'Seu histórico começa com a primeira execução.';$('history').append(empty);}
  if(focused)$('history').querySelector(`[data-id="${focused}"]`)?.focus({preventScroll:true});
}
async function refresh() {
  const sequence=++refreshSequence;
  const query=new URLSearchParams({page:String(historyPage),pageSize:'20',q:$('history-search').value,status:$('history-status').value});
  const data=await api(`/api/runs?${query}`);if(sequence!==refreshSequence)return;
  renderHistory(data);
  if(Date.now()-lastLibraryRefresh>10000){await refreshLibrary();lastLibraryRefresh=Date.now();}
  if(!selected && data.items.length)selectRun(data.items[0].id);
  if(!selected)return;
  const id=selected;
  let job;
  try{job=await api(`/api/runs/${encodeURIComponent(id)}`);}catch(e){if(id===selected){selected=undefined;sessionStorage.removeItem('stress-selected');}throw e;}
  if(id!==selected || sequence!==refreshSequence)return;render(job);
  const key=`${job.id}:${job.status}:${job.result?.reportStatus}`;
  if(seriesKey!==key || ['running','stopping'].includes(job.status)) {
    const data=await api(`/api/runs/${id}/series`);if(id!==selected)return;
    points=data.points;seriesKey=key;renderCharts(points);
    $('series-message').textContent=data.available===false?data.reason:`${points.length} janelas persistidas · consultas por horário real. Verde: observado; azul tracejado: alvo.`;
  }
}
let searchTimer;
$('history-search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{historyPage=1;refresh().catch(showError);},250);};
$('history-status').onchange=()=>{historyPage=1;refresh().catch(showError);};
$('history-prev').onclick=()=>{historyPage=Math.max(1,historyPage-1);refresh().catch(showError);};
$('history-next').onclick=()=>{historyPage++;refresh().catch(showError);};
async function poll(){try{await refresh();$('connection').classList.remove('offline');$('connection-label').textContent='Servidor conectado';}catch(e){$('connection').classList.add('offline');$('connection-label').textContent='Servidor desconectado';}finally{setTimeout(poll,1000);}}
poll();
