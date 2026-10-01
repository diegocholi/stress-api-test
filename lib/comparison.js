const CONFIG_FIELDS = ['stages', 'maxWorkers', 'timeout', 'scriptTimeout', 'scenarioTimeout', 'drainTimeout', 'thinkTime', 'keepAlive', 'bail', 'insecure', 'thresholds', 'evidence'];
function compare(left, right, leftDefinition, rightDefinition) {
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
  return {schemaVersion: 2, left: {id:left.id,name:left.name}, right:{id:right.id,name:right.name}, differences, metrics};
}
module.exports = {compare};
