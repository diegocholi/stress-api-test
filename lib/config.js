const os = require('node:os');
const {compileScenario} = require('./scenario');
function integer(value, fallback, min, max, name) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}: use um inteiro entre ${min} e ${max}`);
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
    collection: input.collection, environment: input.environment,
    stages: stages.map(s => ({durationSec: integer(s.durationSec, undefined, 1, 86400, 'Duração'), target: integer(s.target, undefined, 0, 500, 'Usuários')})),
    maxWorkers: integer(input.maxWorkers, Math.min(4, os.cpus().length), 1, 32, 'Workers'),
    timeout: integer(input.timeout, 10000, 1, 600000, 'Timeout'),
    thinkTime: integer(input.thinkTime, 0, 0, 60000, 'Pausa'),
    keepAlive: input.keepAlive !== false && input.keepAlive !== 'false',
    insecure: input.insecure === true || input.insecure === 'true',
    bail: input.bail === true || input.bail === 'true',
    thresholds: {
      p95: integer(input.thresholds?.p95, 1000, 1, 600000, 'Limite p95'),
      errorRate: (() => {const n = Number(input.thresholds?.errorRate ?? 1); if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('Taxa de erro inválida'); return n;})()
    }
  };
}
module.exports = {validate};
