const os = require('node:os');
const {compileScenario} = require('./scenario');
function integer(value, fallback, min, max, name) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw Object.assign(new Error(`${name}: use um inteiro entre ${min} e ${max}`),{field:({'Workers':'maxWorkers','Timeout':'timeout','Timeout de script':'scriptTimeout','Timeout do cenário':'scenarioTimeout','Prazo de drenagem':'drainTimeout','Pausa':'thinkTime','Limite p95':'p95','Mínimo de respostas':'minResponses'})[name]});
  return n;
}
function validate(input) {
  if (input.mode && !['builder', 'postman'].includes(input.mode)) throw new Error('Modo de teste inválido');
  if (input.mode === 'builder') input = {...input, collection: compileScenario(input.scenario, String(input.name || 'Teste pela interface').slice(0,120)), environment: undefined};
  if (!input.collection?.info || !Array.isArray(input.collection.item)) throw new Error('Collection Postman inválida');
  const hasRequest = items => items.some(i => i.request || (Array.isArray(i.item) && hasRequest(i.item)));
  if (!hasRequest(input.collection.item)) throw new Error('Collection sem requisições');
  if (input.environment && !Array.isArray(input.environment.values)) throw new Error('Environment inválido');
  const stages = typeof input.stages === 'string' ? input.stages.split(',').map(s => {const [durationSec, target] = s.split(':'); return {durationSec, target};}) : input.stages;
  if (!Array.isArray(stages) || !stages.length || stages.length > 50) throw new Error('Informe de 1 a 50 estágios');
  return {
    schemaVersion: 2,
    collection: input.collection, environment: input.environment,
    stages: input.singleRun === true ? [{durationSec:86400,target:1}] : stages.map(s => ({durationSec: integer(s.durationSec, undefined, 1, 86400, 'Duração'), target: integer(s.target, undefined, 0, 500, 'Usuários')})),
    maxWorkers: input.singleRun === true ? 1 : integer(input.maxWorkers, Math.min(4, os.cpus().length), 1, 32, 'Workers'),
    timeout: integer(input.timeout, 10000, 1, 600000, 'Timeout'),
    scriptTimeout: integer(input.scriptTimeout, input.timeout ?? 10000, 1, 600000, 'Timeout de script'),
    scenarioTimeout: integer(input.scenarioTimeout, 0, 0, 86400000, 'Timeout do cenário'),
    drainTimeout: integer(input.drainTimeout, Math.max(Number(input.timeout ?? 10000), Number(input.scriptTimeout ?? input.timeout ?? 10000)) * 2 + 3000, 1, 86400000, 'Prazo de drenagem'),
    singleRun: input.singleRun === true,
    evidence: {
      minResponses: input.singleRun === true ? 1 : integer(input.evidence?.minResponses, 100, 1, 100000000, 'Mínimo de respostas'),
      minLoadPercent: input.singleRun === true ? 0 : (() => {const n = Number(input.evidence?.minLoadPercent ?? 90); if (!Number.isFinite(n) || n < 0 || n > 100) throw Object.assign(new Error('Cumprimento mínimo de carga: use 0 a 100%'),{field:'minLoadPercent'}); return n;})()
    },
    thinkTime: integer(input.thinkTime, 0, 0, 60000, 'Pausa'),
    keepAlive: input.keepAlive !== false && input.keepAlive !== 'false',
    insecure: input.insecure === true || input.insecure === 'true',
    bail: input.bail === true || input.bail === 'true',
    thresholds: {
      p95: integer(input.thresholds?.p95, 1000, 1, 600000, 'Limite p95'),
      errorRate: (() => {const n = Number(input.thresholds?.errorRate ?? 1); if (!Number.isFinite(n) || n < 0 || n > 100) throw Object.assign(new Error('Taxa de erro inválida'),{field:'errorRate'}); return n;})()
    }
  };
}
function legacyInput(input) {
  if (input.schemaVersion) return input;
  return {...input, schemaVersion: 2, scriptTimeout: input.timeout ?? 10000,
    scenarioTimeout: (input.timeout ?? 10000) * 2, evidence: {minResponses: 1, minLoadPercent: 0}};
}
module.exports = {validate, legacyInput};
