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
  if (!Array.isArray(variables) || variables.length > 100) throw Object.assign(new Error('Variáveis inválidas'),{field:'variables'});
  const seen = new Set();
  const variable = variables.map(v => {
    if (!v || typeof v.key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.key) || seen.has(v.key)) throw Object.assign(new Error('Nome de variável inválido ou duplicado'),{field:'variables'});
    seen.add(v.key); return {key: v.key, value: text(v.value, 'Valor da variável')};
  });
  const available = new Set([...seen, 'VU_ID', 'VU_ITER', 'UNIQUE_ID', 'UNIQUE_EMAIL']);
  const resolve = value => String(value || '').replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_,key) => variable.find(v => v.key === key)?.value ?? 'sample');
  const item = scenario.steps.map((step, index) => {
    const problem = (message, field) => {throw Object.assign(new Error(`Requisição ${index+1}: ${message}`), {step: index, field});};
    const checked = (operation,field) => {try{return operation();}catch(error){problem(error.message,field);}};
    if (!step || !METHODS.has(step.method)) problem('método inválido','method');
    for (const [field, values] of [['url',[step.url]], ['headers',Array.isArray(step.headers)?step.headers.map(h=>h?.value):[]], ['body',[step.body]]]) {
      for (const value of values) for (const match of String(value || '').matchAll(/\{\{([^{}]+)\}\}/g)) {
        if (!available.has(match[1])) problem(`variável não definida: ${match[1]}`, field);
      }
    }
    const url = checked(()=>text(step.url,'URL',10000),'url').trim();
    const resolved = resolve(url);
    try {if (!['http:','https:'].includes(new URL(resolved).protocol)) throw new Error();} catch {problem('informe uma URL HTTP ou HTTPS válida', 'url');}
    const headers = step.headers || [];
    if (!Array.isArray(headers) || headers.length > 100) problem('Headers inválidos','headers');
    const header = headers.map(h => {
      if (!h || typeof h.key !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(h.key)) problem('Nome de header inválido','headers');
      const value = checked(()=>text(h.value,'Valor do header',10000),'headers');
      if (/[\r\n]/.test(value)) problem('Header não pode conter quebra de linha','headers');
      return {key:h.key,value};
    });
    const bodyType = step.bodyType || 'none';
    if (!['none','json','text'].includes(bodyType)) problem('Tipo de corpo inválido','bodyType');
    const request = {method:step.method,url,header};
    if (bodyType !== 'none') {
      const raw = checked(()=>text(step.body || '','Corpo'),'body');
      // Validate static structure even if a future extraction supplies a typed
      // JSON value. The actual substituted body is checked again before HTTP.
      if (bodyType === 'json') {
        const structural = raw.replace(/\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/g, '0');
        try {JSON.parse(structural);} catch {problem('corpo JSON inválido', 'body');}
      }
      request.body = {mode:'raw',raw,options:{raw:{language:bodyType === 'json' ? 'json' : 'text'}}};
      if (bodyType === 'json' && !header.some(h=>h.key.toLowerCase()==='content-type')) header.push({key:'Content-Type',value:'application/json'});
    }
    const scripts = [];
    if (step.expectedStatus !== undefined && step.expectedStatus !== null && step.expectedStatus !== '') {
      const code = Number(step.expectedStatus);
      if (!Number.isInteger(code) || code < 100 || code > 599) problem('Status esperado inválido','expectedStatus');
      scripts.push(`pm.test('Status HTTP ${code}', function () { pm.response.to.have.status(${code}); });`);
    }
    if (step.contains) scripts.push(`pm.test('Conteúdo da resposta', function () { pm.expect(pm.response.text()).to.include(${JSON.stringify(checked(()=>text(step.contains,'Conteúdo esperado'),'contains'))}); });`);
    if (step.jsonCheck || step.extract) {
      scripts.push('function readPath(path) { return path.split(".").reduce(function (value, key) { if (value == null || !Object.prototype.hasOwnProperty.call(value, key)) throw new Error("Campo ausente: " + path); return value[key]; }, pm.response.json()); }');
    }
    if (step.jsonCheck) {
      const path = checked(()=>jsonPath(step.jsonCheck.path),'jsonPath');
      if (step.jsonCheck.value === undefined) problem('Informe o valor JSON esperado','jsonValue');
      scripts.push(`pm.test('Campo JSON ${path}', function () { pm.expect(readPath(${JSON.stringify(path)})).to.deep.equal(${JSON.stringify(step.jsonCheck.value)}); });`);
    }
    if (step.extract) {
      const key = step.extract.variable;
      if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) problem('Nome de variável extraída inválido','extractVariable');
      const path = checked(()=>jsonPath(step.extract.path),'extractPath');
      available.add(key);
      scripts.push(`pm.test('Extrair variável ${key}', function () { var value = readPath(${JSON.stringify(path)}); pm.collectionVariables.set(${JSON.stringify(key)}, typeof value === 'object' ? JSON.stringify(value) : String(value)); });`);
    }
    return {name: checked(()=>text(step.name || `Requisição ${index+1}`, 'Nome', 120),'name'),request,
      event:[...(bodyType === 'json' ? [{listen:'prerequest',script:{type:'text/javascript',exec:[
        `try { JSON.parse(pm.variables.replaceIn(pm.request.body.raw)); } catch (error) { pm.test(${JSON.stringify(`Requisição ${index+1}: corpo JSON válido após substituir variáveis`)}, function () { throw new Error('Corpo JSON inválido após substituir variáveis'); }); pm.execution.skipRequest(); }`
      ]}}] : []), ...(scripts.length ? [{listen:'test',script:{type:'text/javascript',exec:scripts}}] : [])]};
  });
  return {info:{name,schema:'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},variable,item};
}
module.exports = {compileScenario};
