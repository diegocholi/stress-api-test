const SCHEMA_VERSION = 2;
const METHODOLOGY_VERSION = '2.0';
const TOOL_VERSION = require('../package.json').version;

function evaluate(result, config, {integrity = true, stages = []} = {}) {
  const limits = config.thresholds;
  const evidence = config.evidence || {minResponses: 100, minLoadPercent: 90};
  const coverage = stages.length ? stages : (config.stages || []).map((s,i)=>({...s,stage:i+1,loadPercent:null}));
  const criteria = [
    {id: 'traffic', label: 'Tentativas HTTP', observed: result.requests, limit: '> 0', passed: result.requests > 0},
    {id: 'p95', label: 'p95 (ms)', observed: result.p95, limit: limits.p95, passed: result.p95 !== null && result.p95 <= limits.p95},
    {id: 'errors', label: 'Falhas HTTP / conexão (%)', observed: result.errorRate, limit: limits.errorRate, passed: result.errorRate <= limits.errorRate},
    ...[['assertionFailures', 'Validações reprovadas'], ['scriptFailures', 'Falhas de scripts'], ['runFailures', 'Falhas de execução']].map(([id, label]) => ({id, label, observed: result[id] || 0, limit: 0, passed: !result[id]})),
    {id: 'samples', label: 'Respostas com latência', observed: result.samples || 0, limit: evidence.minResponses, passed: (result.samples || 0) >= evidence.minResponses, evidence: true},
    ...coverage.filter(s => s.target > 0).map(s => ({id: `load-${s.stage}`, label: `Carga do estágio ${s.stage} (%)`, observed: s.loadPercent, limit: evidence.minLoadPercent, passed: evidence.minLoadPercent===0 || (Number.isFinite(s.loadPercent) && s.loadPercent >= evidence.minLoadPercent), evidence: true})),
    {id: 'integrity', label: 'Integridade dos registros', observed: integrity, limit: true, passed: integrity, evidence: true}
  ];
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
  return {schemaVersion: SCHEMA_VERSION, methodologyVersion: METHODOLOGY_VERSION, verdict, provisional: !final, criteria, reasons};
}

function stageEvidence(config, history, spans, endedAt) {
  return config.stages.map((s, i) => {
    const actual = history[i];
    const plannedUserSeconds = s.durationSec * s.target;
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
      for (const [time, delta] of changes) {observedUserSeconds += Math.min(s.target, active) * (time-last) / 1000; active += delta; last = time;}
    }
    // Surplus retiring users cannot compensate for missing planned users.
    return {...s, ...actual, stage: i + 1, plannedUserSeconds, observedUserSeconds,
      loadPercent: plannedUserSeconds ? Math.min(100, observedUserSeconds / plannedUserSeconds * 100) : null};
  });
}

module.exports = {evaluate, stageEvidence, SCHEMA_VERSION, METHODOLOGY_VERSION, TOOL_VERSION};
