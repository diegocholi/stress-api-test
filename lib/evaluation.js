const SCHEMA_VERSION = 3;
const METHODOLOGY_VERSION = '3.0';
const TOOL_VERSION = require('../package.json').version;

function evaluate(result, config, {integrity = true, stages = []} = {}) {
  const modern = config.schemaVersion >= 3;
  const functional = modern && (config.singleRun || result.purpose === 'check');
  const measured = modern ? (result.performance || result) : result;
  const limits = config.thresholds;
  const evidence = config.evidence || {minResponses: 100, minLoadPercent: 90};
  const coverage = stages.length ? stages : (config.stages || []).map((s,i)=>({...s,stage:i+1,loadPercent:null}));
  const criteria = [
    {id: 'traffic', label: 'Tentativas HTTP', observed: result.requests, limit: '> 0', passed: result.requests > 0},
    {id: 'p95', label: 'p95 (ms)', observed: result.p95, limit: limits.p95, passed: result.p95 !== null && result.p95 <= limits.p95},
    {id: 'errors', label: 'Falhas HTTP / conexão (%)', observed: result.errorRate, limit: limits.errorRate, passed: result.errorRate <= limits.errorRate},
    ...[['assertionFailures', 'Validações reprovadas'], ['scriptFailures', 'Falhas de scripts'], ['runFailures', 'Falhas de execução']].map(([id, label]) => ({id, label, observed: result[id] || 0, limit: 0, passed: !result[id]})),
    {id: 'samples', label: 'Respostas com latência', observed: result.samples || 0, limit: evidence.minResponses, passed: (result.samples || 0) >= evidence.minResponses, evidence: true},
    ...coverage.filter(s => (s.target > 0 || s.fromTarget > 0)).map(s => ({id: `load-${s.stage}`, label: `Carga do estágio ${s.stage} (%)`, observed: s.loadPercent, limit: evidence.minLoadPercent, passed: evidence.minLoadPercent===0 || (Number.isFinite(s.loadPercent) && s.loadPercent >= evidence.minLoadPercent), evidence: true})),
    {id: 'integrity', label: 'Integridade dos registros', observed: integrity, limit: true, passed: integrity, evidence: true}
  ];
  if (functional) {
    criteria.push({id:'functional-http',label:'Falhas HTTP / conexão',observed:result.failedRequests || 0,limit:0,passed:!result.failedRequests});
    for (let i = criteria.length - 1; i >= 0; i--) if (['p95','errors','samples'].includes(criteria[i].id) || criteria[i].id.startsWith('load-')) criteria.splice(i,1);
  } else if (modern) {
    criteria.push({id:'generator',label:config.schemaVersion===4?'Coletor sem atraso sustentado':'Gerador sem atraso sustentado',observed:!result.generatorHealth?.overloaded,limit:true,passed:!result.generatorHealth?.overloaded,evidence:true});
    for (const c of criteria) {
      if (c.id === 'p95') {c.observed = measured.p95; c.passed = Number.isFinite(measured.p95) && measured.p95 <= limits.p95;}
      if (c.id === 'errors') {c.observed = measured.errorRate; c.passed = measured.errorRate <= limits.errorRate;}
      if (c.id === 'samples') {c.observed = measured.samples || 0; c.passed = c.observed >= evidence.minResponses;}
    }
    for (const stage of coverage.filter(s => s.target > 0 || s.fromTarget > 0)) {
      for (const [id,label,value,limit,pass,isEvidence] of [
        ['samples','Respostas',stage.samples || 0,evidence.minResponses,(stage.samples || 0) >= evidence.minResponses,true],
        ['p95','p95 (ms)',stage.p95,limits.p95,Number.isFinite(stage.p95) && stage.p95 <= limits.p95,false],
        ['errors','Falhas (%)',stage.errorRate,limits.errorRate,Number.isFinite(stage.errorRate) && stage.errorRate <= limits.errorRate,false]
      ]) criteria.push({id:`stage-${stage.stage}-${id}`,label:`Estágio ${stage.stage}: ${label}`,observed:value,limit,passed:pass,evidence:isEvidence});
    }
    for (const rule of config.endpointThresholds || []) {
      const matches = (result.endpoints || []).filter(e => rule.nodeId?e.nodeId===rule.nodeId:e.name === rule.name);
      // Ambiguous duplicate names cannot silently select an arbitrary endpoint.
      const endpoint = matches.length === 1 ? matches[0] : {};
      criteria.push({id:`endpoint-${rule.name}-samples`,label:`${rule.name}: respostas`,observed:endpoint.samples || 0,limit:rule.minResponses,passed:(endpoint.samples || 0) >= rule.minResponses,evidence:true});
      criteria.push({id:`endpoint-${rule.name}-p95`,label:`${rule.name}: p95 (ms)`,observed:endpoint.p95 ?? null,limit:rule.p95,passed:Number.isFinite(endpoint.p95) && endpoint.p95 <= rule.p95});
    }
  }
  if(config.schemaVersion===4){criteria.push({id:'journey-success',label:'Jornadas reprovadas',observed:result.failedRuns || 0,limit:0,passed:!result.failedRuns});if(config.journeyThresholds?.p95&&!functional){criteria.push({id:'journey-samples',label:'Respostas de jornada',observed:result.scenarios?.samples || 0,limit:config.journeyThresholds.minResponses,passed:(result.scenarios?.samples || 0)>=config.journeyThresholds.minResponses,evidence:true});criteria.push({id:'journey-p95',label:'p95 da jornada (ms)',observed:result.scenarios?.p95,limit:config.journeyThresholds.p95,passed:Number.isFinite(result.scenarios?.p95)&&result.scenarios.p95<=config.journeyThresholds.p95});}}
  const final = ['completed', 'failed', 'cancelled'].includes(result.status);
  let verdict = 'pending';
  if (final) {
    if (result.status !== 'completed' || result.failure || !integrity) verdict = 'partial';
    else if (criteria.some(c => c.evidence && !c.passed) || !result.requests) verdict = 'inconclusive';
    else verdict = criteria.every(c => c.passed) ? 'approved' : 'rejected';
  }
  const reasons = criteria.filter(c => !c.passed).map(c => `${c.label}: observado ${c.observed ?? 'indisponível'}; limite ${c.limit}`);
  if (result.failure) reasons.unshift(result.failure);
  if (result.status === 'cancelled') reasons.unshift('Execução cancelada; resultados parciais.');
  return {schemaVersion: config.schemaVersion===4?4:modern ? 3 : 2, methodologyVersion: config.schemaVersion===4?'4.0':modern ? '3.0' : '2.0', purpose:functional ? 'check' : 'load', verdict, provisional: !final, criteria, reasons};
}

function stageEvidence(config, history, spans, endedAt) {
  return config.stages.map((s, i) => {
    const actual = history[i];
    if(config.schemaVersion===4&&config.loadModel!=='arrival'){const {area}=require('./load-profile'),plannedUserSeconds=area(s,0,s.durationSec),observedUserSeconds=actual?.observedUserSeconds || 0;return {...s,...actual,stage:i+1,plannedUserSeconds,observedUserSeconds,loadPercent:plannedUserSeconds?Math.min(100,observedUserSeconds/plannedUserSeconds*100):null,evidenceMethod:'k6 vus: integração de observações; lacunas iniciais não estimadas'};}
    if(config.loadModel==='arrival'){const {area}=require('./load-profile'),plannedArrivals=config.schemaVersion===4?Math.ceil(area(s,0,s.durationSec)-1e-9):Math.floor(area(s,0,s.durationSec)+1e-9);return {...s,...actual,stage:i+1,plannedArrivals,startedArrivals:actual?.startedArrivals || 0,droppedArrivals:actual?.droppedArrivals || 0,plannedUserSeconds:null,observedUserSeconds:null,loadPercent:plannedArrivals?Math.min(100,(actual?.startedArrivals || 0)/plannedArrivals*100):null};}
    const {area} = require('./load-profile');
    const plannedUserSeconds = area(s, 0, s.durationSec);
    let observedUserSeconds = 0;
    if (actual) {
      const end = actual.endedAt || endedAt;
      const changes = [];
      for (const span of spans.values()) {
        const from = Math.max(span.startedAt, actual.startedAt), to = Math.min(span.endedAt || endedAt, end);
        if (to > from) changes.push([from, 1], [to, -1]);
      }
      changes.sort((a,b) => a[0]-b[0]);
      let active = 0, last = actual.startedAt;
      for (const [time, delta] of changes) {observedUserSeconds += area(s, (last-actual.startedAt)/1000, (time-actual.startedAt)/1000, active); active += delta; last = time;}
    }
    // Surplus retiring users cannot compensate for missing planned users.
    return {...s, ...actual, stage: i + 1, plannedUserSeconds, observedUserSeconds,
      loadPercent: plannedUserSeconds ? Math.min(100, observedUserSeconds / plannedUserSeconds * 100) : null};
  });
}

module.exports = {evaluate, stageEvidence, SCHEMA_VERSION, METHODOLOGY_VERSION, TOOL_VERSION};
