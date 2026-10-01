const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {Runner} = require('./lib/runner');
const {validate} = require('./lib/config');
const {generateReport}=require('./lib/report/run');
const exportsInProgress=new Map();
const ROOT = process.env.STRESS_DATA_DIR || path.join(__dirname, '.runs'); fs.mkdirSync(ROOT, {recursive: true, mode: 0o700});
const jobs = new Map(); let current;
const save = job => {
  const filename = path.join(ROOT, `${job.id}.json`), temporary = `${filename}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(job), {mode: 0o600}); fs.renameSync(temporary, filename);
};
for (const name of fs.readdirSync(ROOT).filter(n => /^[a-f0-9-]+\.json$/.test(n))) {
  try {
    const job = JSON.parse(fs.readFileSync(path.join(ROOT,name), 'utf8'));
    if (['running','stopping'].includes(job.status)) {job.status = 'failed'; job.result = {...job.result, status: 'failed', failure: 'Servidor reiniciado durante o teste'}; delete job.config; save(job);}
    jobs.set(job.id, job);
  } catch (err) {console.error(`Histórico inválido: ${name}: ${err.message}`);}
}
const view = job => ({id: job.id, name: job.name, status: job.status, scheduledAt: job.scheduledAt, createdAt: job.createdAt, result: job.result});
async function execute(job) {
  current = {job}; job.status = 'running'; save(job);
  try {
    const runner = new Runner({...job.config,name:job.name,source:job.source,reportContext:{id:job.id,createdAt:job.createdAt,scheduledAt:job.scheduledAt}}, path.join(ROOT, `${job.id}.xlsx`)); current.runner = runner;
    runner.on('snapshot', result => {job.result = result; job.status = result.status;});
    job.result = await runner.start(); job.status = job.result.status;
  } catch (err) {job.status = 'failed'; job.result = {status: 'failed', failure: err.message};}
  delete job.config; save(job); current = null;
}
const scheduler = setInterval(() => {
  if (current) return;
  const next = [...jobs.values()].filter(j => j.status === 'scheduled' && Date.parse(j.scheduledAt) <= Date.now()).sort((a,b) => Date.parse(a.scheduledAt)-Date.parse(b.scheduledAt))[0];
  if (next) void execute(next);
}, 1000);
function json(res, status, data) {res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data));}
async function body(req) {
  let bytes = 0, chunks = [];
  for await (const chunk of req) {bytes += chunk.length; if (bytes > 5*1024*1024) throw new Error('Limite de upload: 5 MB'); chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString());
}
const server = http.createServer(async (req,res) => {
  try {
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return json(res,403,{error:'Host inválido'});
    // Local control surface: reject cross-origin mutation attempts.
    if (req.method === 'POST' && ((req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || req.headers['content-type']?.split(';')[0] !== 'application/json')) return json(res,403,{error:'Origem ou tipo de conteúdo inválido'});
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/runs' && req.method === 'GET') return json(res,200,[...jobs.values()].reverse().map(view));
    if (url.pathname === '/api/runs' && req.method === 'POST') {
      const input = await body(req); const config = validate(input);
      if (input.scheduledAt && (!Number.isFinite(Date.parse(input.scheduledAt)) || Date.parse(input.scheduledAt) <= Date.now())) throw new Error('Agende uma data futura');
      if (!input.scheduledAt && current) return json(res,409,{error:'Já existe um teste ativo. Aguarde ou agende outro.'});
      const job = {id: randomUUID(), name: String(input.name || config.collection.info.name || 'Teste').slice(0,120), config,source:input.mode==='builder'?'Interface':'Postman',
        createdAt: new Date().toISOString(), scheduledAt: input.scheduledAt || new Date().toISOString(), status:'scheduled'};
      jobs.set(job.id,job); save(job); if (!input.scheduledAt) void execute(job);
      return json(res,201,view(job));
    }
    const match = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)\/(cancel|xlsx)$/);
    if (match) {
      const job = jobs.get(match[1]); if (!job) return json(res,404,{error:'Teste não encontrado'});
      if (match[2] === 'cancel' && req.method === 'POST') {
        if (current?.job.id === job.id) current.runner?.stop();
        else if (job.status === 'scheduled') {job.status = 'cancelled'; delete job.config; save(job);}
        return json(res,200,view(job));
      }
      if (match[2] === 'xlsx' && req.method === 'GET') {
        if (['running','stopping','scheduled'].includes(job.status) || job.result?.reportStatus==='generating') return json(res,409,{error:'Relatório XLSX disponível após o encerramento e a geração do arquivo'});
        const filename=path.join(ROOT,`${job.id}.xlsx`), legacyFile=path.join(ROOT,`${job.id}.csv`);
        if(!fs.existsSync(filename) && fs.existsSync(legacyFile)) {
          if(!exportsInProgress.has(job.id)) {
            const conversion=generateReport({output:filename,events:legacyFile,legacy:true,metadata:{name:job.name,source:'Versão anterior',result:job.result}})
              .then(()=>{job.result={...job.result,reportStatus:'ready'};save(job);}).finally(()=>exportsInProgress.delete(job.id));
            exportsInProgress.set(job.id,conversion);
          }
          await exportsInProgress.get(job.id);
        }
        if(!fs.existsSync(filename))return json(res,404,{error:job.result?.reportError || 'Esta execução não possui relatório XLSX'});
        const name=job.name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9_-]+/g,'-').slice(0,70) || 'teste';
        res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="stress-lab-${name}-${job.id.slice(0,8)}.xlsx"`});
        fs.createReadStream(filename).on('error',()=>res.destroy()).pipe(res);return;
      }
    }
    const files = {'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
    if (req.method === 'GET' && files[url.pathname]) {
      const ext = path.extname(files[url.pathname]);
      res.writeHead(200,{'Content-Type': {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}[ext], 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'"});
      return fs.createReadStream(path.join(__dirname,'public',files[url.pathname])).pipe(res);
    }
    json(res,404,{error:'Não encontrado'});
  } catch (err) {json(res,400,{error:err.message});}
});
server.listen(Number(process.env.PORT || 3000), '127.0.0.1', () => console.log(`Stress Lab: http://127.0.0.1:${server.address().port}`));
async function shutdown() {clearInterval(scheduler); current?.runner?.stop(); server.close();}
process.once('SIGINT',shutdown); process.once('SIGTERM',shutdown);
