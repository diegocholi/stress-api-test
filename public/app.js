const $ = id => document.getElementById(id);
const stages = $('stages'); let selected, runs = [], points = [], lastPoint;
let mode = 'builder';
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
}
stages.addEventListener('input',updateLoadSummary);
function updateNavigation() {
  const hash=location.hash || '#configure';
  document.querySelectorAll('.nav-link').forEach(link=>{const active=link.getAttribute('href')===hash;link.classList.toggle('active',active);if(active)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current');});
}
window.addEventListener('hashchange',updateNavigation);updateNavigation();
const labels = {scheduled:'Agendado',running:'Executando',stopping:'Encerrando',completed:'Concluído',failed:'Falhou',cancelled:'Cancelado'};
function addStage(duration=30,target=10) {
  const row = document.createElement('div'); row.className='stage';
  row.innerHTML='<input type="number" min="1" max="86400" required aria-label="Duração do estágio em segundos"><input type="number" min="0" max="500" required aria-label="Usuários do estágio"><button type="button" aria-label="Remover estágio">×</button>';
  row.children[0].value=duration; row.children[1].value=target;
  row.children[2].onclick=()=>{if(stages.children.length>1) row.remove();updateLoadSummary();}; stages.append(row);updateLoadSummary();
}
addStage(); addStage(60,20);
$('add-stage').onclick=()=>{if(stages.children.length<50)addStage();};

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
  $(tab+'-tab').onclick=()=>setMode(tab);
  $(tab+'-tab').onkeydown=event=>{
    if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
      event.preventDefault(); const next=event.key==='Home'?'builder':event.key==='End'?'postman':mode==='builder'?'postman':'builder';
      setMode(next); $(next+'-tab').focus();
    }
  };
}
function updateRequests() {
  const rows=[...$('requests').children];
  rows.forEach((row,index)=>{
    row.querySelector('strong').textContent=String(index+1).padStart(2,'0');
    row.querySelector('[data-action="up"]').disabled=index===0;
    row.querySelector('[data-action="down"]').disabled=index===rows.length-1;
    row.querySelector('[data-action="remove"]').disabled=rows.length===1;
  });
  $('add-request').disabled=rows.length>=50;
  $('request-count').textContent=`${rows.length} ${rows.length===1?'REQUISIÇÃO':'REQUISIÇÕES'}`;
}
function addRequest() {
  if ($('requests').children.length>=50) return;
  const row=document.createElement('div');row.className='request-card';
  row.innerHTML=`<div class="request-head"><div class="request-identity"><strong></strong><span class="request-label">Requisição</span><span class="method-badge">GET</span></div><div class="request-controls"><button type="button" data-action="up" aria-label="Mover requisição para cima">↑</button><button type="button" data-action="down" aria-label="Mover requisição para baixo">↓</button><button type="button" data-action="remove" aria-label="Remover requisição">×</button></div></div>
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
  row.querySelectorAll('[data-action]').forEach(button=>button.onclick=()=>{
    const action=button.dataset.action;
    if(action==='up'&&row.previousElementSibling)row.parentNode.insertBefore(row,row.previousElementSibling);
    if(action==='down'&&row.nextElementSibling)row.parentNode.insertBefore(row.nextElementSibling,row);
    if(action==='remove'&&$('requests').children.length>1)row.remove();
    updateRequests();
  });
  $('requests').append(row);updateRequests();
}
function pairs(value, separator, label) {
  return value.split(/\r?\n/).filter(line=>line.trim()).map(line=>{
    const at=line.indexOf(separator);
    if(at<1)throw new Error(`${label}: use Nome${separator} valor, um por linha.`);
    return {key:line.slice(0,at).trim(),value:line.slice(at+1).trim()};
  });
}
function readScenario() {
  return {variables:pairs($('variables').value,'=','Variáveis'),steps:[...$('requests').children].map((row,index)=>{
    const value=field=>row.querySelector(`[data-field="${field}"]`).value;
    const step={name:value('name'),method:value('method'),url:value('url').trim(),headers:pairs(value('headers'),':','Headers'),
      bodyType:value('bodyType'),body:value('body'),expectedStatus:value('expectedStatus'),contains:value('contains')};
    if(value('jsonPath')||value('jsonValue')) {
      if(!value('jsonPath')||!value('jsonValue'))throw new Error(`Requisição ${index+1}: informe o campo e o valor JSON esperado.`);
      try {step.jsonCheck={path:value('jsonPath').trim(),value:JSON.parse(value('jsonValue'))};}
      catch {throw new Error(`Requisição ${index+1}: valor esperado precisa ser JSON válido.`);}
    }
    if(value('extractPath')||value('extractVariable')) {
      if(!value('extractPath')||!value('extractVariable'))throw new Error(`Requisição ${index+1}: informe o campo e o nome da variável extraída.`);
      step.extract={path:value('extractPath').trim(),variable:value('extractVariable').trim()};
    }
    return step;
  })};
}
$('add-request').onclick=addRequest;
addRequest();setMode('builder');

async function api(url, data) {
  const res = await fetch(url,data === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result = await res.json(); if(!res.ok)throw new Error(result.error || 'Falha na requisição'); return result;
}
async function readFile(id, required=false) {
  const file=$(id).files[0]; if(!file){if(required)throw new Error('Selecione a collection');return undefined;}
  if(file.size>5*1024*1024)throw new Error('Arquivo excede 5 MB');
  try{return JSON.parse(await file.text());}catch{throw new Error(`${file.name}: JSON inválido`);}
}
$('collection').onchange=async()=>{try{const c=await readFile('collection');$('collection-name').textContent=c?.info?.name || 'Collection sem nome';}catch(e){$('collection-name').textContent=e.message;}};
$('form').onsubmit=async event=>{
  event.preventDefault(); $('submit').disabled=true; $('message').textContent='Preparando teste…'; $('message').className='';
  updateLoadSummary();
  try {
    const form=event.target.elements;
    const source = mode === 'builder' ? {scenario:readScenario()} : {collection:await readFile('collection',true),environment:await readFile('environment')};
    const input={name:form.name.value,mode,...source,
      stages:[...stages.children].map(row=>({durationSec:Number(row.children[0].value),target:Number(row.children[1].value)})),
      maxWorkers:Number(form.maxWorkers.value),timeout:Number(form.timeout.value),thinkTime:Number(form.thinkTime.value),
      keepAlive:form.keepAlive.checked,bail:form.bail.checked,insecure:form.insecure.checked,
      thresholds:{p95:Number(form.p95.value),errorRate:Number(form.errorRate.value)},
      scheduledAt:form.scheduledAt.value ? new Date(form.scheduledAt.value).toISOString() : undefined};
    const job=await api('/api/runs',input); selected=job.id;points=[];lastPoint=null;
    $('message').textContent=input.scheduledAt?'Teste agendado. Mantenha o servidor aberto para executar.':'Teste iniciado.'; await refresh();
  }catch(e){$('message').textContent=e.message;$('message').className='error';}
  finally{$('submit').disabled=false;}
};
function renderMetrics(s={}) {
  const metrics=[['Requisições',s.requests ?? 0,'Tentativas HTTP'],['RPS',Number(s.rps || 0).toFixed(1),'Média da execução'],['Usuários',`${s.active || 0} / ${s.target || 0}`,'Ativos / alvo'],['p95',s.p95 == null?'—':`${s.p95} ms`,'95% das respostas'],['p99',s.p99 == null?'—':`${s.p99} ms`,'99% das respostas'],['Falhas',`${Number(s.errorRate || 0).toFixed(2)}%`,'HTTP ≥400 ou conexão']];
  $('metrics').replaceChildren(...metrics.map(([label,value,help])=>{const el=document.createElement('div');el.className='metric';for(const [tag,text]of [['span',label],['strong',value],['small',help]]){const child=document.createElement(tag);child.textContent=text;if(tag==='span')child.append(icon(label==='Usuários'?'users':label==='Falhas'?'shield':label==='Requisições'?'code':label==='RPS'?'pulse':'clock'));el.append(child);}return el;}));
}
renderMetrics();
function render(job) {
  const s=job.result || {}; $('status').textContent=labels[job.status] || job.status;
  const statusClass=job.status==='completed'?(s.passed?'completed':'failed'):['running','stopping'].includes(job.status)?'running':job.status==='scheduled'?'scheduled':job.status==='failed'?'failed':'neutral';
  $('status').className=`badge ${statusClass}`;
  $('run-name').textContent=job.name;
  $('run-info').textContent=`${new Date(job.scheduledAt).toLocaleString()} · Estágio ${s.stage || 0} · ${Number(s.elapsed || 0).toFixed(1)} segundos`;
  renderMetrics(s);
  if(s.elapsed && s.elapsed !== lastPoint){points.push(s.active||0);if(points.length>60)points.shift();lastPoint=s.elapsed;}
  const max=Math.max(1,...points);
  const coords=points.map((n,i)=>[points.length===1?300:i*600/(points.length-1),145-n/max*130]);
  const line=coords.map(([x,y],i)=>`${i?'L':'M'} ${x} ${y}`).join(' ');
  $('chart-line').setAttribute('d',line);
  $('chart-area').setAttribute('d',coords.length>1?`${line} L 600 150 L 0 150 Z`:'');
  $('chart-empty').hidden=coords.length>0;$('chart-point').toggleAttribute('hidden',!coords.length);
  if(coords.length){const [x,y]=coords[coords.length-1];$('chart-point').setAttribute('cx',Math.max(4,Math.min(596,x)));$('chart-point').setAttribute('cy',y);}
  $('diagnostics').hidden=!job.result;
  $('chart-caption').textContent=`Máximo visível: ${max} usuários`;
  $('verdict').textContent=s.failure || (job.status==='completed'?(s.passed?'Aprovado nos critérios configurados.':'Reprovado nos critérios configurados.'):
    job.status==='scheduled'?'Aguardando horário. Se houver um teste ativo, entrará na fila.':job.status==='cancelled'?'Execução cancelada. Resultados parciais.':'Coletando resultados. A aprovação é avaliada no encerramento.');
  $('verdict').className=`verdict ${s.failure || (job.status==='completed'&&!s.passed)?'error':job.status==='completed'?'success':'pending'}`;
  $('cancel').hidden=!['scheduled','running','stopping'].includes(job.status);
  $('xlsx').hidden=!['completed','cancelled','failed'].includes(job.status) || !(s.reportStatus==='ready' || (!s.reportStatus && s.csvRows));
  $('report-message').hidden=!['generating','error'].includes(s.reportStatus) && !s.reportInfo;
  $('report-message').textContent=s.reportStatus==='error'?`Não foi possível gerar o XLSX: ${s.reportError}`:s.reportStatus==='ready' && s.reportInfo?`${s.reportInfo.sheets} abas · ${s.reportInfo.charts} gráficos · ${s.reportInfo.rows.toLocaleString('pt-BR')} tentativas detalhadas · ${(s.reportInfo.bytes/1024).toFixed(0)} KB`:'Preparando seu relatório XLSX com gráficos e dados detalhados…';
  $('report-message').classList.toggle('error',s.reportStatus==='error');
  $('xlsx').href=`/api/runs/${job.id}/xlsx`;
  $('details').textContent=job.result ? `HTTP: ${Object.entries(s.codes||{}).map(([code,n])=>`${code}: ${n}`).join(' · ')}\nConexão: ${s.transportErrors||0} · Assertions: ${s.assertionFailures||0} · Scripts: ${s.scriptFailures||0} · Execuções: ${s.runFailures||0}\nMemória do gerador: ${Number(s.rssMB||0).toFixed(0)} MB · Atraso do event loop: ${Number(s.eventLoopLagMs||0).toFixed(0)} ms` : '';
}
$('cancel').onclick=async()=>{try{await api(`/api/runs/${selected}/cancel`,{});await refresh();}catch(e){$('message').textContent=e.message;}};
async function refresh(){
  runs=await api('/api/runs');$('count').textContent=`${runs.length} ${runs.length===1?'TESTE':'TESTES'}`;
  $('connection').classList.remove('offline');$('connection-label').textContent='Servidor conectado';
  $('overview-total').textContent=runs.length;$('nav-count').textContent=runs.length;
  $('overview-completed').textContent=runs.filter(job=>job.status==='completed').length;
  $('overview-scheduled').textContent=runs.filter(job=>job.status==='scheduled').length;
  if(!selected&&runs.length)selected=runs[0].id;
  $('history').replaceChildren(...runs.map(job=>{
    const button=document.createElement('button');button.type='button';button.className='history-row';button.dataset.status=job.status;button.setAttribute('aria-current',String(selected===job.id));
    const title=document.createElement('strong');title.textContent=job.name;
    const info=document.createElement('span');info.textContent=new Date(job.scheduledAt).toLocaleString();
    const symbol=document.createElement('span');symbol.className='history-symbol';symbol.append(icon(job.status==='scheduled'?'clock':job.status==='completed'?'shield':'pulse'));
    const content=document.createElement('div');content.className='history-text';content.append(title,info);
    const badge=document.createElement('span');const failed=job.status==='failed'||(job.status==='completed'&&!job.result?.passed);
    badge.className=`badge ${failed?'failed':job.status==='scheduled'?'scheduled':job.status==='running'?'running':job.status==='completed'?'completed':'neutral'}`;
    badge.textContent=job.status==='completed'?(job.result?.passed?'Aprovado':'Reprovado'):labels[job.status]||job.status;
    button.append(symbol,content,badge);button.onclick=()=>{selected=job.id;points=[];lastPoint=null;document.querySelectorAll('.history-row').forEach(row=>row.setAttribute('aria-current',String(row===button)));render(job);};return button;
  }));
  if(!runs.length) {
    const empty=document.createElement('div');empty.className='empty-history';const title=document.createElement('strong');title.textContent='Seu histórico começa aqui.';
    const help=document.createElement('p');help.textContent='Testes executados e agendados aparecem neste painel.';empty.append(icon('clock'),title,help);$('history').append(empty);
  }
  const job=runs.find(j=>j.id===selected);if(job)render(job);
}
async function poll(){try{await refresh();}catch(e){$('status').textContent='SEM CONEXÃO';$('status').className='badge failed';$('connection').classList.add('offline');$('connection-label').textContent='Servidor desconectado';}finally{setTimeout(poll,1000);}}
poll();
