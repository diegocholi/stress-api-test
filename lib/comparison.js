const CONFIG_FIELDS = ['generatorLagLimitMs','loadModel','warmupSec','maxConcurrent','endpointThresholds','stages', 'maxWorkers', 'timeout', 'scriptTimeout', 'scenarioTimeout', 'drainTimeout', 'thinkTime', 'keepAlive', 'bail', 'insecure', 'thresholds', 'evidence'];
function compare(left, right, leftDefinition, rightDefinition) {
  const effective=d=>d?.singleRun?{...d,stages:[{durationSec:86400,target:1}],maxWorkers:1,loadModel:'users',warmupSec:0,endpointThresholds:[],evidence:{minResponses:1,minLoadPercent:0}}:d;
  const applied=d=>{d=effective(d);if(!d)return d;return {...d,loadModel:d.loadModel || 'users',warmupSec:d.warmupSec || 0,endpointThresholds:d.endpointThresholds || [],maxConcurrent:d.loadModel==='arrival'?d.maxConcurrent:undefined,thinkTime:d.loadModel==='arrival' || d.singleRun?0:d.thinkTime,generatorLagLimitMs:d.schemaVersion>=3?d.generatorLagLimitMs ?? 100:undefined};};
  leftDefinition=applied(leftDefinition);rightDefinition=applied(rightDefinition);
  const differences = [];
  if (!leftDefinition || !rightDefinition) differences.push({field: 'configuração', left: leftDefinition ? 'Registrada' : 'Não registrada', right: rightDefinition ? 'Registrada' : 'Não registrada'});
  else {
    for (const field of CONFIG_FIELDS) if (JSON.stringify(leftDefinition[field]) !== JSON.stringify(rightDefinition[field])) differences.push({field, left: leftDefinition[field] ?? 'Não registrado', right: rightDefinition[field] ?? 'Não registrado'});
    // Compare definitions without exporting bodies, headers or credentials.
    for (const [field,a,b] of [
      ['cenário', leftDefinition.scenario?.steps || leftDefinition.collection, rightDefinition.scenario?.steps || rightDefinition.collection],
      ['variáveis / environment', leftDefinition.scenario?.variables || leftDefinition.environment, rightDefinition.scenario?.variables || rightDefinition.environment]
    ]) if (JSON.stringify(a) !== JSON.stringify(b)) differences.push({field, left: 'Definição A', right: 'Definição B (diferente)'});
  }
  if (left.result?.purpose !== right.result?.purpose) differences.push({field: 'finalidade', left: left.result?.purpose || 'Não registrada', right: right.result?.purpose || 'Não registrada'});
  if (left.result?.methodologyVersion !== right.result?.methodologyVersion) differences.push({field: 'metodologia', left: left.result?.methodologyVersion || '1 (histórico)', right: right.result?.methodologyVersion || '1 (histórico)'});
  const metrics = ['requests', 'samples', 'rps', 'loadRps', 'p95', 'p99', 'errorRate'].map(field => {
    const a = left.result?.[field], b = right.result?.[field];
    return {field, left: a ?? null, right: b ?? null, delta: Number.isFinite(a) && Number.isFinite(b) ? b-a : null,
      percent: Number.isFinite(a) && Number.isFinite(b) && a !== 0 ? (b-a)/a*100 : null};
  });
  return {schemaVersion: 3,compatible:differences.length===0 && left.result?.evaluation?.verdict==='approved' && right.result?.evaluation?.verdict==='approved', left: {id:left.id,name:left.name}, right:{id:right.id,name:right.name}, differences, metrics};
}
module.exports = {compare};
