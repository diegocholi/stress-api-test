const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
function text(value, name, max=100000) {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${name} inválido`);
  return value;
}
function jsonPath(value) {
  text(value, 'Caminho JSON', 200);
  if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(value)) throw new Error('Caminho JSON: use pontos, como data.token ou items.0.id');
  return value;
}
function compileScenario(scenario, name='Teste pela interface') {
  if (!scenario || !Array.isArray(scenario.steps) || scenario.steps.length < 1 || scenario.steps.length > 50) throw new Error('Informe de 1 a 50 requisições');
  const variables = scenario.variables || [];
  if (!Array.isArray(variables) || variables.length > 100) throw new Error('Variáveis inválidas');
  const seen = new Set();
  const variable = variables.map(v => {
    if (!v || typeof v.key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.key) || seen.has(v.key)) throw new Error('Nome de variável inválido ou duplicado');
    seen.add(v.key); return {key: v.key, value: text(v.value, 'Valor da variável')};
  });
  const item = scenario.steps.map((step, index) => {
    if (!step || !METHODS.has(step.method)) throw new Error(`Requisição ${index+1}: método inválido`);
    const url = text(step.url, 'URL', 10000).trim();
    const resolved = url.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_,key) => variable.find(v => v.key === key)?.value || 'sample');
    try {if (!['http:','https:'].includes(new URL(resolved).protocol)) throw new Error();} catch {throw new Error(`Requisição ${index+1}: informe uma URL HTTP ou HTTPS válida`);}
    const headers = step.headers || [];
    if (!Array.isArray(headers) || headers.length > 100) throw new Error('Headers inválidos');
    const header = headers.map(h => {
      if (!h || typeof h.key !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(h.key)) throw new Error('Nome de header inválido');
      const value = text(h.value, 'Valor do header', 10000);
      if (/[\r\n]/.test(value)) throw new Error('Header não pode conter quebra de linha');
      return {key:h.key,value};
    });
    const bodyType = step.bodyType || 'none';
    if (!['none','json','text'].includes(bodyType)) throw new Error('Tipo de corpo inválido');
    const request = {method:step.method,url,header};
    if (bodyType !== 'none') {
      const raw = text(step.body || '', 'Corpo');
      // Placeholders are substituted at run time; validate literal JSON now.
      if (bodyType === 'json' && !/\{\{[^}]+\}\}/.test(raw)) {try {JSON.parse(raw);} catch {throw new Error(`Requisição ${index+1}: corpo JSON inválido`);}}
      request.body = {mode:'raw',raw,options:{raw:{language:bodyType === 'json' ? 'json' : 'text'}}};
      if (bodyType === 'json' && !header.some(h=>h.key.toLowerCase()==='content-type')) header.push({key:'Content-Type',value:'application/json'});
    }
    const scripts = [];
    if (step.expectedStatus !== undefined && step.expectedStatus !== null && step.expectedStatus !== '') {
      const code = Number(step.expectedStatus);
      if (!Number.isInteger(code) || code < 100 || code > 599) throw new Error('Status esperado inválido');
      scripts.push(`pm.test('Status HTTP ${code}', function () { pm.response.to.have.status(${code}); });`);
    }
    if (step.contains) scripts.push(`pm.test('Conteúdo da resposta', function () { pm.expect(pm.response.text()).to.include(${JSON.stringify(text(step.contains,'Conteúdo esperado'))}); });`);
    if (step.jsonCheck || step.extract) {
      scripts.push('function readPath(path) { return path.split(".").reduce(function (value, key) { if (value == null || !Object.prototype.hasOwnProperty.call(value, key)) throw new Error("Campo ausente: " + path); return value[key]; }, pm.response.json()); }');
    }
    if (step.jsonCheck) {
      const path = jsonPath(step.jsonCheck.path);
      if (step.jsonCheck.value === undefined) throw new Error('Informe o valor JSON esperado');
      scripts.push(`pm.test('Campo JSON ${path}', function () { pm.expect(readPath(${JSON.stringify(path)})).to.deep.equal(${JSON.stringify(step.jsonCheck.value)}); });`);
    }
    if (step.extract) {
      const key = step.extract.variable;
      if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Nome de variável extraída inválido');
      const path = jsonPath(step.extract.path);
      scripts.push(`pm.test('Extrair variável ${key}', function () { var value = readPath(${JSON.stringify(path)}); pm.collectionVariables.set(${JSON.stringify(key)}, typeof value === 'object' ? JSON.stringify(value) : String(value)); });`);
    }
    return {name: text(step.name || `Requisição ${index+1}`, 'Nome', 120),request,
      event:scripts.length ? [{listen:'test',script:{type:'text/javascript',exec:scripts}}] : []};
  });
  return {info:{name,schema:'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},variable,item};
}
module.exports = {compileScenario};
