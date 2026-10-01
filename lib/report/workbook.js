const Excel=require('exceljs');
const fs=require('node:fs');
const readline=require('node:readline');
const {accumulator,observe,finish,sanitizeUrl}=require('./metrics');
const {addCharts}=require('./charts');
const {createGunzip}=require('node:zlib');
const {Observations,EventAudit,GeneratorHealth}=require('../observations');
const {Timeline, checkIntegrity}=require('../measurement');
const {evaluate,stageEvidence}=require('../evaluation');
const C={navy:'162331',mint:'C0F780',ink:'25364A',muted:'66788D',light:'F3F6FA',line:'DFE6EF',green:'E7F4DA',red:'FBE8EC',amber:'FFF2D9',white:'FFFFFF'};
for(const key of Object.keys(C))C[key]='FF'+C[key];
const F={integer:'#,##0',decimal:'#,##0.00',percent:'0.00%',date:'yyyy-mm-dd hh:mm:ss.000',bytes:'#,##0" B"'};
const PAGE_SIZE=1048570;
const statuses={completed:'Concluído',cancelled:'Cancelado — resultado parcial',failed:'Falhou — resultado parcial'};
const safe=value=>typeof value==='string'?value.slice(0,32767):value;
const blank=value=>value===undefined?null:value;
async function* events(filename,legacy=false) {
  const lines=readline.createInterface({input:filename.endsWith('.gz') ? fs.createReadStream(filename).pipe(createGunzip()) : fs.createReadStream(filename),crlfDelay:Infinity});
  let number=0;
  for await(const line of lines) {
    number++;
    if(!line.trim())continue;
    if(legacy) {
      if(line.startsWith('timestamp,'))continue;
      const [ts,vu,iter,code,latency,failed]=line.split(',');
      yield {type:'request',ts:Number(ts),startedAt:Number(ts),vu:Number(vu),iter:Number(iter),code:Number(code),latency:latency===''?null:Number(latency),failed:failed==='true',transport:Number(code)===0,name:'Não registrado (versão anterior)',method:'Não registrado',url:'Não registrado',route:'Não registrado',stage:0,bytes:null,message:''};
    } else {
      try {yield JSON.parse(line);}catch {yield {type:'recordError',message:`Registro JSON incompleto ou inválido na linha ${number}`};}
    }
  }
}
function sheet(workbook,name,title,subtitle,columns,color=C.mint) {
  const ws=workbook.addWorksheet(name,{properties:{tabColor:{argb:color}},views:[{state:'frozen',ySplit:6,showGridLines:false}],pageSetup:{orientation:'landscape',paperSize:9,fitToPage:true,fitToWidth:1,fitToHeight:0},headerFooter:{oddFooter:'Stress Lab | &A | Página &P de &N'}});
  ws.columns=columns.map(c=>({width:c.width || 18,style:c.format?{numFmt:c.format}:undefined}));
  ws.mergeCells(1,1,2,columns.length);const titleRow=ws.getRow(1);titleRow.getCell(1).value=title;titleRow.getCell(1).font={name:'Calibri',size:20,bold:true,color:{argb:C.white}};titleRow.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:C.navy}};titleRow.getCell(1).alignment={vertical:'middle',indent:1};titleRow.height=30;ws.getRow(2).height=16;titleRow.commit();ws.getRow(2).commit();
  ws.mergeCells(3,1,3,columns.length);ws.getRow(3).getCell(1).value=subtitle;ws.getRow(3).font={name:'Calibri',size:10,color:{argb:C.muted}};ws.getRow(3).height=25;ws.getRow(3).commit();ws.getRow(4).commit();ws.getRow(5).commit();
  const header=ws.getRow(6);columns.forEach((c,i)=>{const cell=header.getCell(i+1);cell.value=c.label;cell.font={name:'Calibri',size:10,bold:true,color:{argb:C.white}};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:C.navy}};cell.alignment={vertical:'middle',wrapText:true};});header.height=32;header.commit();
  ws._reportColumns=columns;ws._reportCount=0;return ws;
}
function dataRow(ws,values,{failed=false}={}) {
  const row=ws.addRow(values.map(v=>safe(blank(v))));ws._reportCount++;
  row.eachCell({includeEmpty:true},(cell,index)=>{
    const format=ws._reportColumns[index-1]?.format;
    cell.font={name:'Calibri',size:10,color:{argb:failed?'FF9B3347':C.ink}};
    cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:failed?C.red:ws._reportCount%2?C.white:C.light}};
    cell.alignment={vertical:'top',wrapText:ws._reportColumns[index-1]?.wrap || false};
    if(format)cell.numFmt=format;
  });
  const lines=values.reduce((max,value,index)=>{const column=ws._reportColumns[index];return column?.wrap && typeof value==='string'?Math.max(max,Math.ceil(value.length/(column.width || 18)),value.split('\n').length):max;},1);
  row.height=Math.min(120,Math.max(failed?30:21,lines*13+8));row.commit();
}
function finishSheet(ws) {ws.autoFilter={from:{row:6,column:1},to:{row:6+ws._reportCount,column:ws._reportColumns.length}};ws.pageSetup.printTitlesRow='1:6';ws.commit();}
function pages(workbook,prefix,title,subtitle,columns,limit) {
  let ws,index=0;
  return {add(values,options){if(!ws || ws._reportCount>=limit){if(ws)finishSheet(ws);ws=sheet(workbook,`${prefix} ${++index}`,title,subtitle,columns);}dataRow(ws,values,options);},finish(){if(!ws)ws=sheet(workbook,`${prefix} 1`,title,subtitle,columns);finishSheet(ws);}};
}
function configRows(metadata) {
  const c=metadata.config || {}, r=metadata.result || {};
  return [
    ['Teste',metadata.name],['Identificador',metadata.id || 'Execução pela linha de comando'],['Reexecução de',metadata.repeatedFrom || 'Execução original'],['Criado em (UTC)',metadata.createdAt || 'Não registrado'],['Agendado para (UTC)',metadata.scheduledAt || 'Execução imediata'],['Origem',metadata.source || (metadata.legacy?'Versão anterior':'Não registrado')],['Estado',statuses[r.status] || r.status || 'Não registrado'],
    ['Início (UTC)',metadata.startedAt?new Date(metadata.startedAt).toISOString():'Não registrado'],['Fim da medição (UTC)',metadata.endedAt?new Date(metadata.endedAt).toISOString():'Não registrado'],
    ['Versão da ferramenta',metadata.toolVersion || 'Não registrada'],['Versão da metodologia',metadata.methodologyVersion || '1 (histórico)'],['Finalidade',r.purpose === 'check' ? 'Verificação funcional: uma execução' : 'Teste de carga'],['Duração de carga (s)',r.loadElapsed ?? 'Não registrada'],['Duração de drenagem (s)',r.drainElapsed ?? 'Não registrada'],['RPS durante a carga',r.loadRps ?? 'Não registrado'],['Mínimo de respostas',c.evidence?.minResponses ?? 'Não registrado'],['Cumprimento mínimo da carga (%)',c.evidence?.minLoadPercent ?? 'Não registrado'],['Duração medida (s)',r.elapsed ?? null],['Modelo de carga',c.loadModel==='arrival'?'Aberto: taxa de chegada de cenários/s':'Fechado: usuários concorrentes, cenários repetidos'],['Aquecimento (s)',c.warmupSec ?? 0],['Atraso máximo sustentado do gerador (ms)',c.generatorLagLimitMs ?? 'Não registrado'],['Limite de cenários simultâneos',c.maxConcurrent ?? 'Não registrado'],['Máximo de threads',c.maxWorkers ?? null],['Timeout por requisição (ms)',c.timeout ?? null],['Timeout por script (ms)',c.scriptTimeout ?? c.timeout ?? null],['Prazo máximo por cenário (ms)',c.scenarioTimeout === 0 ? 'Sem limite global' : c.scenarioTimeout ?? (c.timeout?c.timeout*2:null)],['Prazo de drenagem (ms)',c.drainTimeout ?? 'Não registrado'],['Pausa entre cenários (ms)',c.thinkTime ?? null],
    ['Keep-alive',c.keepAlive===undefined?'Não registrado':c.keepAlive?'Sim':'Não'],['Aceitar certificado inválido',c.insecure===undefined?'Não registrado':c.insecure?'Sim':'Não'],['Interromper cenário ao falhar',c.bail===undefined?'Não registrado':c.bail?'Sim':'Não'],
    ['Limite p95 (ms)',c.thresholds?.p95 ?? null],['Limite de falhas (%)',c.thresholds?.errorRate ?? null],['Node.js',metadata.node || 'Não registrado'],['Plataforma',metadata.platform || 'Não registrado'],['Gerado em (UTC)',new Date().toISOString()],
    ['Motivo de encerramento',r.failure || (r.status==='cancelled'?'Cancelado pelo usuário':'Prazo dos estágios encerrado')],['Escopo','Métricas HTTP e do gerador; CPU, banco e filas da API não são medidos por este relatório.']
  ];
}
function dashboard(workbook,m,overall,counts,integrity,highlights=[]) {
  const ws=workbook.addWorksheet('Resumo',{properties:{tabColor:{argb:C.mint}},views:[{showGridLines:false}],pageSetup:{orientation:'landscape',paperSize:9,fitToPage:true,fitToWidth:1,fitToHeight:1,printArea:m.schemaVersion>=2?'A1:L70':'A1:L63'},headerFooter:{oddFooter:'Stress Lab | Relatório de performance | &P / &N'}});
  ws.columns=Array.from({length:12},()=>({width:12}));
  const merge=(r,c1,c2,value,fill=C.white,font={})=>{ws.mergeCells(r,c1,r,c2);const cell=ws.getRow(r).getCell(c1);cell.value=safe(value);cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:fill}};cell.font={name:'Calibri',size:11,color:{argb:C.ink},...font};cell.alignment={vertical:'middle',wrapText:true,indent:1};return cell;};
  merge(1,1,12,'STRESS LAB  /  RELATÓRIO DE PERFORMANCE',C.navy,{size:23,bold:true,color:{argb:C.white}});ws.getRow(1).height=43;
  merge(2,1,12,'Cenários reais · Carga sustentada · Evidências por requisição',C.navy,{size:11,color:{argb:C.mint}});ws.getRow(2).height=25;
  const result=m.result || {},completed=result.status==='completed',approved=completed && result.passed && integrity;
  const verdict=m.schemaVersion >= 2 ? ({approved:'APROVADO',rejected:'REPROVADO',inconclusive:'INCONCLUSIVO',partial:'RESULTADO PARCIAL',pending:'PROVISÓRIO'}[result.evaluation.verdict]) : !integrity?'DADOS PARCIAIS':!completed?'RESULTADO PARCIAL':approved?'APROVADO':'REPROVADO';
  merge(4,1,4,result.purpose==='check' && result.passed?'FLUXO APROVADO':verdict,!integrity||!completed||result.evaluation?.verdict==='inconclusive'?C.amber:approved?C.green:C.red,{bold:true,size:15});merge(4,5,12,m.name || 'Teste de carga',C.light,{size:16,bold:true});ws.getRow(4).height=35;
  merge(5,1,12,`${statuses[result.status] || result.status || 'Não registrado'} · ${m.startedAt?new Date(m.startedAt).toISOString():'Data não registrada'} · ${result.elapsed?.toFixed(2) || '—'} segundos`,C.white,{color:{argb:C.muted},size:10});
  const card=(row,col,label,value,format,note,accent=false)=>{merge(row,col,col+3,label,C.light,{size:10,color:{argb:C.muted},bold:true});const cell=merge(row+1,col,col+3,value,accent?C.green:C.light,{size:25,bold:true});if(format)cell.numFmt=format;ws.getRow(row+1).height=43;merge(row+2,col,col+3,note,C.light,{size:9,color:{argb:C.muted}});};
  card(8,1,'TENTATIVAS HTTP',overall.requests,F.integer,'Cada tentativa é contada uma vez');card(8,5,'THROUGHPUT DA CARGA / S',result.loadRps ?? (result.elapsed?overall.requests/result.elapsed:0),F.decimal,'Carga; média global na Configuração');card(8,9,'P95 / MILISSEGUNDOS',result.performance ? result.performance.p95 : overall.p95,F.decimal,`${result.performance?.samples ?? overall.samples} respostas avaliadas`,approved&&result.purpose!=='check');
  card(12,1,'TAXA DE FALHAS',result.performance ? result.performance.errorRate/100 : overall.errorRate,F.percent,'HTTP ≥400 ou falha de transporte');card(12,5,'P99 / MILISSEGUNDOS',result.performance ? result.performance.p99 : overall.p99,F.decimal,'99% das latências com resposta');card(12,9,'VALIDAÇÕES COM FALHA',counts.validationFailures,F.integer,`${counts.validations} validações registradas`);
  merge(17,1,12,'CRITÉRIOS DE APROVAÇÃO',C.navy,{bold:true,color:{argb:C.white}});ws.getRow(17).height=25;
  const checks=[
    ['Tráfego registrado',overall.requests,'> 0',overall.requests>0],
    ['p95 (ms)',overall.p95,m.config?.thresholds?.p95 ?? 'Não registrado',m.config?.thresholds?overall.p95!==null&&overall.p95<=m.config.thresholds.p95:null],
    ['Falhas HTTP / conexão (%)',overall.errorRate*100,m.config?.thresholds?.errorRate ?? 'Não registrado',m.config?.thresholds?overall.errorRate*100<=m.config.thresholds.errorRate:null],
    ['Validações reprovadas',result.assertionFailures ?? counts.validationFailures,0,(result.assertionFailures ?? counts.validationFailures)===0],
    ['Falhas de scripts',result.scriptFailures ?? counts.scriptFailures,0,(result.scriptFailures ?? counts.scriptFailures)===0],
    ['Falhas de execução',result.runFailures ?? counts.runFailures,0,(result.runFailures ?? counts.runFailures)===0],
    ['Integridade dos registros',`${overall.requests} de ${result.requests ?? overall.requests}`,'Sem perda de tentativas',integrity]
  ];
  if(m.schemaVersion >= 2) {
    let selected=result.evaluation.criteria.filter(c=>!c.id.startsWith('load-')).slice(0,7);
    if(m.schemaVersion>=3){const ids=result.purpose==='check'?['traffic','functional-http','assertionFailures','scriptFailures','runFailures','integrity']:['traffic','p95','errors','samples','integrity','generator'];selected=ids.map(id=>result.evaluation.criteria.find(c=>c.id===id)).filter(Boolean);if(result.purpose!=='check'){const bad=result.evaluation.criteria.filter(c=>(c.id.startsWith('stage-') || c.id.startsWith('load-'))&&!c.passed);selected.push({label:'Critérios por estágio com falha',observed:bad.length,limit:0,passed:bad.length===0});}}
    checks.splice(0,checks.length,...selected.map(c=>[c.label,c.observed,c.limit,c.passed]));
  }
  checks.forEach(([name,observed,limit,pass],i)=>{const row=19+i;merge(row,1,4,name,i%2?C.white:C.light);const actual=merge(row,5,7,observed,i%2?C.white:C.light);if(typeof observed==='number')actual.numFmt=F.decimal;merge(row,8,10,limit,i%2?C.white:C.light);merge(row,11,12,pass===null?'N/D':pass?'PASSOU':'FALHOU',pass===null?C.amber:pass?C.green:C.red,{bold:true,size:10});ws.getRow(row).height=25;});
  if(m.schemaVersion >= 2) {merge(26,1,12,`Carga: ${result.loadElapsed?.toFixed(2)}s · drenagem: ${result.drainElapsed?.toFixed(2)}s · RPS da carga: ${result.loadRps?.toFixed(2)} · detalhes na aba Critérios`,C.light,{size:10});ws.getRow(26).height=28;}
  merge(27,1,12,result.evaluation?.reasons.length?result.evaluation.reasons.join(' | ').slice(0,500):!integrity?'Atenção: o registro detalhado não contém todas as tentativas contadas. Consulte as limitações.':!completed?'Execução interrompida. As métricas e gráficos representam somente os dados coletados.':'Consulte as abas para detalhar endpoints, estágios, validações e falhas.',!integrity||!completed?C.amber:C.light,{size:10});ws.getRow(27).height=30;
  for(let row=29;row<=60;row++)ws.getRow(row).height=18;
  merge(62,1,12,'LEITURA DO RELATÓRIO  ·  Configuração → Estágios → Endpoints → Evolução → HTTP → Validações → Falhas → Requisições',C.navy,{color:{argb:C.white},size:10});ws.getRow(62).height=28;
  merge(63,1,12,'Datas em UTC. Não são exportados corpos, headers, credenciais de URL nem valores de query string. Metodologia na última aba.',C.white,{size:9,color:{argb:C.muted}});ws.getRow(63).height=28;
  if(m.schemaVersion>=2) {
    merge(65,1,12,'PRINCIPAIS PONTOS DE ATENÇÃO  ·  Mais falhas, depois maior p95',C.navy,{color:{argb:C.white},size:10});ws.getRow(65).height=25;
    highlights.forEach((e,i)=>{const row=66+i;merge(row,1,6,`${e.method} ${e.name}`,C.light,{size:10});merge(row,7,9,`p95: ${e.p95 ?? '—'} ms`,C.light,{size:10});merge(row,10,12,`${e.failed} falhas / ${e.requests}`,C.light,{size:10});ws.getRow(row).height=26;});
  }
  for(const [row,label,target] of [[71,'Ir para critérios','Critérios'],[72,'Ir para estágios','Estágios'],[73,'Ir para falhas','Falhas 1']]) {
    if(m.schemaVersion>=3){const cell=merge(row,1,12,label,C.light);cell.value={text:label,hyperlink:`#'${target}'!A1`};}
  }
  if(m.schemaVersion>=3){const worst=[...(result.stages || [])].filter(s=>s.target>0 || s.fromTarget>0).sort((a,b)=>(b.p95 || 0)-(a.p95 || 0))[0];merge(69,1,12,worst?`Pior estágio por p95: ${worst.stage} · ${worst.p95 ?? '—'} ms · carga ${worst.loadPercent?.toFixed(1) ?? '—'}%`:'Sem estágio de carga avaliado',C.light);merge(70,1,12,result.generatorHealth?.overloaded?'Gerador com atraso sustentado: evidência inconclusiva.':'Gerador: CPU e event loop na aba Evolução; não representam telemetria da API.',C.light);ws.pageSetup.printArea='A1:L73';ws.pageSetup.fitToHeight=2;}
  ws.commit();
}
async function buildReport({output,events:filename,metadata:m,legacy=false,detailPageSize=PAGE_SIZE}) {
  m={...m,legacy};
  const interval=Math.max(m.timelineInterval || 1,Math.ceil((m.result?.elapsed || 1)/3600));
  const observations=new Observations(),audit=new EventAudit(),spans=new Map(),arrivals=new Map(),health=new GeneratorHealth(m.config?.generatorLagLimitMs);
  const totals=accumulator(),endpoints=new Map(),stageStats=new Map(),timeline=new Timeline(m.startedAt || 0, interval),codes=new Map(),vus=new Map();
  const counts={requests:0,validations:0,validationFailures:0,scriptFailures:0,runFailures:0,details:0,runs:0,startedRequests:0,startedRuns:0,invalidRecords:0,telemetrySamples:0,plannedArrivals:0,arrivalDispositions:0};
  let loadRequests=0,lastEventTs=m.startedAt || 0;
  for await(const e of events(filename,legacy)) {
    if(e.type==='vuStart' && m.config?.loadModel!=='arrival')spans.set(e.vu,{startedAt:e.ts});
    if(e.type==='vuEnd'&&spans.has(e.vu))spans.get(e.vu).endedAt=e.ts;
    if(e.type==='arrivalPlanned')counts.plannedArrivals++;
    if(e.type==='arrival')counts.arrivalDispositions++;
    if(e.type==='arrival'&&e.stage>0){if(!arrivals.has(e.stage))arrivals.set(e.stage,{plannedArrivals:0,startedArrivals:0,droppedArrivals:0,arrivalLagMaxMs:0});const a=arrivals.get(e.stage);a.plannedArrivals++;a.startedArrivals+=Number(e.started);a.droppedArrivals+=Number(!e.started);a.arrivalLagMaxMs=Math.max(a.arrivalLagMaxMs,e.lagMs);}
    if(Number.isFinite(e.ts))lastEventTs=Math.max(lastEventTs,e.ts);
    timeline.observe(e);observations.observe(e);health.observe(e);if(m.schemaVersion>=3)audit.observe(e);
    if(e.type==='request') {
      observe(totals,e);
      // Group by configured item URL/name/method, rather than dynamic data values.
      const key=`${e.name}\0${e.method}\0${e.route || e.url}`;
      const routeKey=endpoints.has(key)||endpoints.size<5000?key:'__other__';
      if((m.schemaVersion<3 || e.phase!=='warmup') && !endpoints.has(routeKey))endpoints.set(routeKey,{...accumulator(),name:routeKey==='__other__'?'Outros endpoints (limite de 5.000 grupos)':e.name,method:e.method,url:e.route || e.url});
      if(m.schemaVersion<3 || e.phase!=='warmup')observe(endpoints.get(routeKey),e);
      const stage=e.stage || 0;if(!stageStats.has(stage))stageStats.set(stage,accumulator());observe(stageStats.get(stage),e);
      counts.requests++;
      if(e.ts >= (m.loadStartedAt || m.startedAt || 0) && e.ts<=(m.loadEndedAt || (m.startedAt || 0)+(m.result?.loadElapsed || 0)*1000))loadRequests++;
      if(!codes.has(e.code))codes.set(e.code,accumulator());observe(codes.get(e.code),e);
      if(!vus.has(e.vu))vus.set(e.vu,{...accumulator(),iterations:0,lastIteration:null});observe(vus.get(e.vu),e);if(vus.get(e.vu).lastIteration!==e.iter){vus.get(e.vu).iterations++;vus.get(e.vu).lastIteration=e.iter;}
    } else if(e.type==='validation') {counts.validations++;counts.validationFailures+=Number(!e.passed&&!e.skipped);}
    else if(e.type==='script')counts.scriptFailures++;
    else if(['run','runInterrupted'].includes(e.type))counts.runFailures++;
    else if(e.type==='runEnd')counts.runs++;
    else if(e.type==='requestStart')counts.startedRequests++;
    else if(e.type==='runStart')counts.startedRuns++;
    else if(e.type==='tick')counts.telemetrySamples++;
    else if(e.type==='recordError')counts.invalidRecords++;
  }
  if(m.result?.status==='failed' && !m.endedAt && m.startedAt) {
    const elapsed=Math.max(m.result.elapsed || 0,(lastEventTs-m.startedAt)/1000);
    m={...m,endedAt:lastEventTs,result:{...m.result,elapsed,loadElapsed:m.result.loadElapsed ?? elapsed}};
  }
  const overall=finish(totals);Object.assign(counts,{samples:overall.samples,failedRequests:overall.failed,transportErrors:overall.transport,p50:overall.p50,p95:overall.p95,p99:overall.p99,latencySum:overall.sum});
  const integrityDetails=checkIntegrity({...m.result,...m.result?.engineMetrics},counts);
  if(counts.invalidRecords){integrityDetails.complete=false;integrityDetails.checks.push({counter:'Registros JSON inválidos',expected:0,recorded:counts.invalidRecords,matches:false});}
  if(m.schemaVersion>=3){const identity=audit.check(m.workerCount || 0);integrityDetails.checks.push(identity);integrityDetails.complete &&= identity.matches;}
  const integrity=integrityDetails.complete;
  const measured={...(m.schemaVersion>=3?{...observations.snapshot(),generatorHealth:health.snapshot(),telemetrySamples:counts.telemetrySamples}:{}),requests:overall.requests,failedRequests:overall.failed,transportErrors:overall.transport,samples:overall.samples,
    p50:overall.p50,p95:overall.p95,p99:overall.p99,errorRate:overall.errorRate*100,
    assertions:counts.validations,assertionFailures:counts.validationFailures,scriptFailures:counts.scriptFailures,runFailures:counts.runFailures,
    runs:counts.runs,startedRequests:counts.startedRequests,startedRuns:counts.startedRuns,elapsed:m.result?.elapsed || 0,
    rps:m.result?.elapsed?overall.requests/m.result.elapsed:0,loadRequests,loadRps:m.result?.loadElapsed?loadRequests/m.result.loadElapsed:0};
  if(m.schemaVersion >= 2) {
    const result={...m.result,...measured};
    if(m.schemaVersion>=3){const history=(m.stageHistory || []).map((s,i)=>({...s,...(arrivals.get(i+1) || {plannedArrivals:0,startedArrivals:0,droppedArrivals:0})}));result.stages=stageEvidence(m.config,history,spans,m.endedAt || lastEventTs).map(s=>({...s,...observations.stage(s.stage)}));measured.stages=result.stages;}
    result.evaluation=evaluate(result,m.config,{integrity,stages:result.stages || []});result.passed=result.evaluation.verdict==='approved';m={...m,result};
  }
  const base=`${output}.building`,temporary=`${output}.tmp`;
  fs.closeSync(fs.openSync(base,'w',0o600));
  const workbook=new Excel.stream.xlsx.WorkbookWriter({filename:base,useStyles:true,useSharedStrings:false});
  workbook.creator='Stress Lab';workbook.title=m.name || 'Relatório de carga';workbook.subject='Medição de performance HTTP';workbook.created=new Date();
  try {
    dashboard(workbook,m,overall,counts,integrity,[...endpoints.values()].map(finish).sort((a,b)=>b.failed-a.failed || (b.p95 || 0)-(a.p95 || 0)).slice(0,3));
    const config=sheet(workbook,'Configuração','CONFIGURAÇÃO DO TESTE','Parâmetros efetivamente utilizados. Valores ausentes não são estimados.',[{label:'Parâmetro',width:42},{label:'Valor',width:105,wrap:true}]);configRows(m).forEach(row=>dataRow(config,row));finishSheet(config);
    if(m.schemaVersion>=3){const scenarioSheet=sheet(workbook,'Cenários','DURAÇÃO DOS CENÁRIOS','Duração inclui scripts, validações e requisições sequenciais; não substitui latência HTTP.',[{label:'Estágio'},{label:'Concluídos'},{label:'Com falha'},{label:'Média (ms)'},{label:'p95 (ms)'},{label:'p99 (ms)'}]);const c=measured.scenarios;dataRow(scenarioSheet,['Global',c.requests,c.failed,c.average,c.p95,c.p99]);for(const stage of m.result.stages || []){const c=observations.scenarioStage(stage.stage);dataRow(scenarioSheet,[stage.stage,c.requests,c.failed,c.average,c.p95,c.p99]);}finishSheet(scenarioSheet);}
    const metricColumns=[{label:'Tentativas',format:F.integer},{label:'Falhas HTTP / conexão',format:F.integer},{label:'Transporte',format:F.integer},{label:'Taxa de falhas',format:F.percent},{label:'Respostas com latência',format:F.integer},{label:'Mínimo (ms)',format:F.decimal},{label:'Média (ms)',format:F.decimal},{label:'p50 (ms)',format:F.decimal},{label:'p90 (ms)',format:F.decimal},{label:'p95 (ms)',format:F.decimal},{label:'p99 (ms)',format:F.decimal},{label:'Máximo (ms)',format:F.decimal},{label:'Corpo recebido (bytes)',format:F.integer}];
    const metrics=a=>{const x=a.hist?finish(a):a;return [x.requests,x.failed,x.transport,x.errorRate,x.samples,x.min,x.average,x.p50,x.p90,x.p95,x.p99,x.max,x.bytes];};
    const stageSheet=sheet(workbook,'Estágios','ESTÁGIOS DE CARGA','Atribuição pelo início da tentativa. Estágios não iniciados permanecem identificados.',[{label:'Estágio'},{label:'Estado',width:23},{label:'Duração planejada (s)',format:F.decimal},{label:m.config?.loadModel==='arrival'?'Cenários/s alvo':'Usuários alvo',format:F.integer},{label:'Início real (UTC)',width:26,format:F.date},{label:'Fim real (UTC)',width:26,format:F.date},{label:'Duração real (s)',format:F.decimal},...metricColumns,{label:'Usuários-segundo planejados',format:F.decimal},{label:'Usuários-segundo observados',format:F.decimal},{label:'Cumprimento (%)',format:F.decimal},{label:'Perfil'},{label:'Alvo inicial',format:F.decimal},{label:'Chegadas previstas',format:F.integer},{label:'Chegadas iniciadas',format:F.integer},{label:'Chegadas descartadas',format:F.integer},{label:'Atraso máximo de chegada (ms)',format:F.decimal}]);
    (m.config?.stages || []).forEach((s,i)=>{const actual=m.stageHistory?.[i];dataRow(stageSheet,[i+1,actual?'Executado':'Não iniciado',s.durationSec,s.target,actual?new Date(actual.startedAt):null,actual?.endedAt?new Date(actual.endedAt):null,actual?.endedAt?(actual.endedAt-actual.startedAt)/1000:null,...metrics(stageStats.get(i+1)||accumulator()),m.result?.stages?.[i]?.plannedUserSeconds,m.result?.stages?.[i]?.observedUserSeconds,m.result?.stages?.[i]?.loadPercent,s.ramp?'Rampa':'Degrau',s.fromTarget ?? s.target,actual?.plannedArrivals,actual?.startedArrivals,actual?.droppedArrivals,actual?.arrivalLagMaxMs]);});
    if(stageStats.has(0))dataRow(stageSheet,['Drenagem / não registrado',legacy?'Versão anterior':'Fora dos estágios',null,0,null,null,null,...metrics(stageStats.get(0))]);finishSheet(stageSheet);
    const endpointSheet=sheet(workbook,'Endpoints','DESEMPENHO POR REQUISIÇÃO','Agrupado por nome, método e URL do item; aquecimento excluído na metodologia 3.0; valores de query ocultos.',[{label:'Requisição',width:32},{label:'Método',width:12},{label:'URL do item',width:65,wrap:true},...metricColumns]);
    [...endpoints.values()].sort((a,b)=>(finish(b).p95||0)-(finish(a).p95||0)).forEach(a=>dataRow(endpointSheet,[a.name,a.method,a.url,...metrics(a)],{failed:a.failed>0}));finishSheet(endpointSheet);
    const times=m.startedAt?timeline.points(m.result?.elapsed || 0):[];
    const evolution=sheet(workbook,'Evolução','EVOLUÇÃO DA EXECUÇÃO',`Janelas de ${interval}s. RPS por conclusão HTTP; usuários são observações do gerador, sem interpolação.`,[{label:'Início da janela (s)',format:F.decimal},{label:'Horário (UTC)',width:26,format:F.date},{label:'Duração da janela (s)',format:F.decimal},{label:'RPS da janela',format:F.decimal},{label:'Ativos: média observada',format:F.decimal},{label:'Ativos: pico observado',format:F.integer},{label:'Último alvo observado',format:F.integer},{label:'Memória máxima do gerador (MB)',format:F.decimal},{label:'Atraso máximo do event loop (ms)',format:F.decimal},...metricColumns,{label:'Cenários em execução',format:F.integer},{label:'Usuários em pausa',format:F.integer},{label:'Event loop dos workers (ms)',format:F.decimal},{label:'CPU do gerador (%)',format:F.decimal},{label:'Sucessos HTTP/s',format:F.decimal},{label:'Cenários/s',format:F.decimal},{label:'Janela parcial'},{label:'Cenários iniciados/s',format:F.decimal}]);
    times.forEach(a=>dataRow(evolution,[a.second,m.startedAt?new Date(a.ts):null,a.duration,a.rps,a.active,a.activePeak,a.target,a.rss,a.lag,...metrics(a),a.busy,a.paused,a.workerLag,a.cpu,a.successRps,a.scenarioRps,a.partial?'Sim':'Não',a.startedScenarioRps]));finishSheet(evolution);
    const httpSheet=sheet(workbook,'HTTP','DISTRIBUIÇÃO DOS CÓDIGOS HTTP','Código 0 significa ausência de resposta: falha de transporte.',[{label:'Código',width:12},{label:'Categoria',width:25},{label:'Participação',format:F.percent},...metricColumns]);
    const httpRows=[...codes].sort((a,b)=>a[0]-b[0]);httpRows.forEach(([code,a])=>dataRow(httpSheet,[String(code),code===0?'Transporte':code>=500?'5xx · servidor':code>=400?'4xx · cliente':code>=300?'3xx · redirecionamento':code>=200?'2xx · sucesso':'1xx · informativo',overall.requests?a.requests/overall.requests:0,...metrics(a)],{failed:code===0||code>=400}));finishSheet(httpSheet);
    const users=sheet(workbook,'Usuários','USUÁRIOS VIRTUAIS','Iterações são as execuções distintas observadas nas tentativas HTTP desse usuário.',[{label:'Usuário virtual',format:F.integer},{label:'Iterações com HTTP',format:F.integer},...metricColumns]);[...vus].sort((a,b)=>a[0]-b[0]).forEach(([id,a])=>dataRow(users,[id,a.iterations,...metrics(a)]));finishSheet(users);
    const validationColumns=[{label:'Horário (UTC)',width:26,format:F.date},{label:'Usuário',format:F.integer},{label:'Iteração',format:F.integer},{label:'Requisição',width:30},{label:'Método',width:12},{label:'URL',width:65,wrap:true},{label:'Validação',width:45,wrap:true},{label:'Resultado',width:15},{label:'Mensagem',width:85,wrap:true}];
    const validations=pages(workbook,'Validações','VALIDAÇÕES EXECUTADAS','Inclui aprovações, reprovações e validações ignoradas.',validationColumns,Math.min(PAGE_SIZE,Math.max(1,detailPageSize)));
    const failureColumns=[{label:'Horário (UTC)',width:26,format:F.date},{label:'Tipo',width:22},{label:'Usuário',format:F.integer},{label:'Iteração',format:F.integer},{label:'Requisição',width:30},{label:'Método',width:12},{label:'URL',width:65,wrap:true},{label:'Status HTTP',format:F.integer},{label:'Latência (ms)',format:F.decimal},{label:'Validação',width:40,wrap:true},{label:'Mensagem / motivo',width:90,wrap:true}];
    const failures=pages(workbook,'Falhas','REGISTRO DE FALHAS','Falhas HTTP, transporte, validações, scripts e execução. Essas categorias não são somadas à taxa HTTP.',failureColumns,Math.min(PAGE_SIZE,Math.max(1,detailPageSize)));
    const requests=pages(workbook,'Requisições','TODAS AS TENTATIVAS HTTP','Uma linha por tentativa, sem amostragem. Datas em UTC; dados sensíveis de URL são ocultos.',[{label:'Nº',format:F.integer},{label:'Início (UTC)',width:26,format:F.date},{label:'Conclusão (UTC)',width:26,format:F.date},{label:'Estágio',width:18},{label:'Usuário',format:F.integer},{label:'Iteração',format:F.integer},{label:'Requisição',width:32},{label:'Método',width:12},{label:'URL efetiva',width:65,wrap:true},{label:'Status HTTP',format:F.integer},{label:'Latência (ms)',format:F.decimal},{label:'Corpo recebido (bytes)',format:F.integer},{label:'Resultado',width:18},{label:'Erro',width:85,wrap:true}],Math.min(PAGE_SIZE,Math.max(1,detailPageSize)));
    let number=0;
    for await(const e of events(filename,legacy)) {
      if(e.type==='request')requests.add([++number,new Date(e.startedAt || e.ts),new Date(e.ts),e.phase==='warmup'?'Aquecimento':e.stage || (legacy?'Não registrado':'Drenagem'),e.vu,e.iter,e.name,e.method,sanitizeUrl(e.url),e.code,e.latency,e.bytes,e.interrupted?'INTERROMPIDA':e.failed?'FALHA':'SUCESSO',e.message],{failed:e.failed});
      if(e.type==='validation')validations.add([new Date(e.ts),e.vu,e.iter,e.name,e.method,sanitizeUrl(e.url),e.assertion,e.skipped?'IGNORADA':e.passed?'PASSOU':'FALHOU',e.message],{failed:!e.passed&&!e.skipped});
      if((e.type==='request'&&e.failed)||(e.type==='validation'&&!e.passed&&!e.skipped)||['script','run','runInterrupted','recordError'].includes(e.type)) {
        failures.add([e.ts?new Date(e.ts):null,e.type==='recordError'?'Registro':e.type==='request'?(e.transport?'Transporte':'HTTP'):e.type==='validation'?'Validação':e.type==='script'?'Script':'Execução',e.vu,e.iter,e.name,e.method,sanitizeUrl(e.url),e.code,e.latency,e.assertion,e.message || (e.type==='request'?`Resposta HTTP ${e.code}`:'Falha registrada')],{failed:true});counts.details++;
      }
    }
    requests.finish();validations.finish();failures.finish();
    if(m.schemaVersion >= 2) {
      const criteria=sheet(workbook,'Critérios','AVALIAÇÃO E EVIDÊNCIAS','Mesmas regras da API e da interface. Volume mínimo não é garantia estatística.',[{label:'Critério',width:40},{label:'Observado',width:25},{label:'Limite',width:25},{label:'Resultado',width:18}]);
      m.result.evaluation.criteria.forEach(c=>dataRow(criteria,[c.label,c.observed,c.limit,c.passed?'PASSOU':'FALHOU'],{failed:!c.passed}));finishSheet(criteria);
      const integritySheet=sheet(workbook,'Integridade','INTEGRIDADE DOS REGISTROS','Uma execução interrompida permanece parcial mesmo quando as contagens conferem.',[{label:'Contador',width:30},{label:'Motor',format:F.integer},{label:'Registro',format:F.integer},{label:'Resultado',width:18}]);
      integrityDetails.checks.forEach(c=>dataRow(integritySheet,[c.counter,c.expected,c.recorded,c.matches?'CONFERE':'DIVERGE'],{failed:!c.matches}));finishSheet(integritySheet);
    }
    const glossary=sheet(workbook,'Metodologia','METODOLOGIA E LIMITAÇÕES','Como interpretar as métricas e quais informações não foram coletadas.',[{label:'Conceito',width:35},{label:'Definição / observação',width:130,wrap:true}]);
    [
      ['Evidência de carga',m.config?.loadModel==='arrival'?'Inícios confirmados pelos workers / chegadas planejadas. Atrasos acima de 100 ms e limite de simultaneidade são descartados. Cumprimento insuficiente: inconclusivo.':'Usuários-segundo observados por estágio, limitados ao alvo em cada instante / usuários-segundo planejados. Inclui usuários em pausa; não mede requisições simultâneas. Carga ou amostra insuficiente: inconclusivo.'],
      ['Modelo fechado','Quando a API fica lenta, os usuários iniciam menos operações. Este modelo não comprova capacidade para uma taxa fixa de chegadas.'],
      ['CPU do gerador','Uso de CPU do processo, incluindo threads, dividido pelo tempo real. 100% equivale a um núcleo ocupado; pode exceder 100%. Não mede a API.'],
      ['Aprovação','A execução deve concluir, gerar tráfego, cumprir p95 e taxa de falhas e não apresentar falhas de validação, script ou execução. Cancelamentos e interrupções são parciais.'],
      ['Tentativas HTTP','Uma ocorrência do evento request do Newman ou tentativa iniciada e interrompida por encerramento forçado. Inclui requisições de scripts e falhas de transporte. Redirects internos não são tratados como tentativas independentes.'],
      ['Taxa de falhas','Tentativas com HTTP ≥400 ou falha de transporte divididas pelo total de tentativas HTTP. Assertions são apresentadas separadamente.'],
      ['Percentis','Método nearest rank, histograma de 1 ms e teto de 600.000 ms. Considera somente tentativas com responseTime disponível; não inventa latência de timeout.'],
      ['Média, mínimo e máximo','Usam os responseTime originais com resposta, antes do arredondamento do histograma.'],
      ['RPS global','Total de tentativas / duração entre o início e o fim da medição, incluindo inicialização e drenagem. A geração do arquivo está fora da medição.'],
      ['RPS por janela',`Conclusões HTTP por duração da janela (até ${interval}s). Janelas sem amostra de usuários não recebem valor estimado.`],
      ['Estágios','Atribuição pelo início da tentativa. Requisições iniciadas após o fim dos estágios são marcadas como drenagem.'],
      ['Endpoints','Agrupamento por nome, método e URL do item configurado. Após 5.000 grupos, os demais são agregados em Outros; as tentativas permanecem detalhadas.'],
      ['Dados da API','Este relatório não mede CPU, memória, banco de dados, filas ou cache da API de destino. Memória e event loop são do gerador.'],
      ['Bytes recebidos','Tamanho do corpo de resposta disponível no runtime. Não representa necessariamente bytes trafegados na rede, headers ou compressão.'],
      ['Confidencialidade','Headers, corpos de requisição/resposta e variáveis não são incluídos. Credenciais de URL e valores de query string são removidos. Mensagens de validação são produzidas pelos scripts da collection.'],
      ['Paginação','Dados detalhados são divididos em abas numeradas ao atingir o limite de linhas do Excel; nenhuma tentativa é descartada para caber na planilha.'],
      ['Integridade',`${overall.requests} tentativas no arquivo; ${m.result?.requests ?? overall.requests} tentativas no contador do runner. ${integrity?'Contagens conferem.':'Contagens divergem: resultado parcial.'}`],
      ['Registros inválidos',`${counts.invalidRecords} linhas JSON inválidas. Linhas incompletas não são reconstruídas; são registradas como falha de integridade.`],
      ['Relatórios anteriores',legacy?'Convertido de CSV antigo. URL, método, configuração, validações e telemetria não estavam registrados e não são reconstruídos.':'Este relatório foi gerado a partir do registro detalhado desta execução.'],
      ['Versão da metodologia',m.methodologyVersion || 'Histórico'],
      ['Metodologia 3.0',m.schemaVersion>=3?'Critérios globais e por estágio. Aquecimento excluído da performance. Cenários têm duração própria. Chegadas atrasadas mais de 100 ms são descartadas, sem rajadas de compensação.':'Não aplicada: relatório de metodologia anterior.'],
      ['Gráficos','Gráficos nativos editáveis referenciam as abas Evolução e HTTP. Valores ausentes de latência/usuários permanecem vazios na tabela.'],
    ].forEach(row=>dataRow(glossary,row));finishSheet(glossary);
    await workbook.commit();
    const categories={formula:`'Evolução'!$A$7:$A$${6+times.length}`,values:times.map(a=>a.second),strings:false};
    const series=(name,col,values,color)=>({name,formula:`'Evolução'!$${col}$7:$${col}$${6+times.length}`,values,color});
    const charts=[
      {title:'Evolução do throughput · RPS',categories,series:[series('Tentativas/s','D',times.map(a=>a.rps),'6D9F42'),series('Sucessos/s','AA',times.map(a=>a.successRps),'426A9D'),series('Cenários/s','AB',times.map(a=>a.scenarioRps),'C58B32')]},
      {title:'Latência por janela · ms',categories,series:[series('p95','S',times.map(a=>a.p95),'426A9D')]},
      m.config?.loadModel==='arrival'?{title:'Taxa de chegada · cenários/s',categories,series:[series('Iniciados/s','AD',times.map(a=>a.startedScenarioRps),'6D9F42'),series('Taxa alvo','G',times.map(a=>a.target),'426A9D')]}:{title:'Usuários ativos e alvo',categories,series:[series('Ativos observados','E',times.map(a=>a.active),'6D9F42'),series('Alvo observado','G',times.map(a=>a.target),'426A9D')]},
      {title:'Distribuição HTTP',bar:true,categories:{formula:`'HTTP'!$A$7:$A$${6+httpRows.length}`,values:httpRows.map(([code])=>String(code)),strings:true},series:[{name:'Tentativas',formula:`'HTTP'!$D$7:$D$${6+httpRows.length}`,values:httpRows.map(([,a])=>a.requests),color:'6D9F42'}]}
    ];
    // Empty series have no valid Excel range; omit those charts.
    const validCharts=charts.filter(chart=>chart.categories.values.length && chart.series.some(s=>s.values.some(Number.isFinite)));
    await addCharts(base,temporary,validCharts);
    fs.renameSync(temporary,output);
    return {rows:number,validationRows:counts.validations,failureRows:counts.details,invalidRecords:counts.invalidRecords,integrity,integrityDetails,metrics:measured,evaluation:m.result?.evaluation,
      endpoints:[...endpoints.values()].map(a=>{const {hist,...row}=finish(a);return row;}).sort((a,b)=>(b.p95 || 0)-(a.p95 || 0)).slice(0,20),
      failureCounts:{http:overall.failed-overall.transport,transport:overall.transport,validation:counts.validationFailures,script:counts.scriptFailures,run:counts.runFailures},
      sheets:(m.schemaVersion>=3?11:m.schemaVersion >= 2?10:8)+Math.max(1,Math.ceil(number/detailPageSize))+Math.max(1,Math.ceil(counts.validations/detailPageSize))+Math.max(1,Math.ceil(counts.details/detailPageSize)),charts:validCharts.length,bytes:fs.statSync(output).size};
  } finally {
    for(const filename of [base,temporary])if(fs.existsSync(filename))fs.unlinkSync(filename);
  }
}
module.exports={buildReport,PAGE_SIZE};
