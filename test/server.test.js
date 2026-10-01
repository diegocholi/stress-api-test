const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {once} = require('node:events');
const http = require('node:http');
const Excel=require('exceljs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function boot(dir) {
  const child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,PORT:'0',STRESS_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
  let output='';
  const base=await new Promise((resolve,reject)=>{
    child.stdout.on('data',data=>{output+=data;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});
    child.once('error',reject);child.once('exit',code=>reject(new Error(`Server exit ${code}: ${output}`)));
  });return {child,base};
}
async function stop(child) {if(child.exitCode!==null)return;const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
test('web API imports, schedules persist, cancels, executes and downloads final XLSX',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stress-server-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let app=await boot(dir);t.after(()=>stop(app.child));
  const call=async(route,body)=>{
    const response=await fetch(app.base+route,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {response,data:await response.json()};
  };
  const collection=JSON.parse(fs.readFileSync(path.join(__dirname,'../examples/local.postman_collection.json')));
  const input={collection,stages:'1:1',maxWorkers:1};
  assert.equal((await fetch(app.base)).status,200);
  const script=await (await fetch(app.base+'/app.js')).text();assert.ok(script.includes('scheduledAt'));
  assert.equal((await call('/api/runs',{...input,collection:{}})).response.status,400);
  const scheduled=await call('/api/runs',{...input,scheduledAt:new Date(Date.now()+60000).toISOString()});assert.equal(scheduled.response.status,201);
  await stop(app.child);app=await boot(dir);
  let jobs=(await call('/api/runs')).data;assert.equal(jobs[0].status,'scheduled');
  assert.equal((await call(`/api/runs/${jobs[0].id}/cancel`,{})).data.status,'cancelled');
  let received=0;const target=http.createServer((_req,res)=>{received++;res.end('ok');});
  await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>target.close(resolve)));
  collection.item[0].request.url=`http://127.0.0.1:${target.address().port}`;
  const savedResponse=await call('/api/templates',{name:'Health salvo',mode:'builder',scenario:{steps:[{method:'GET',url:collection.item[0].request.url,expectedStatus:200}]},stages:'1:1',maxWorkers:1});
  assert.equal(savedResponse.response.status,201);const saved=savedResponse.data;
  assert.equal((await call('/api/runs')).data.filter(j=>j.status==='running').length,0,'saving does not execute');
  await stop(app.child);app=await boot(dir);
  assert.equal((await call('/api/templates')).data[0].id,saved.id);
  const loaded=(await call(`/api/templates/${saved.id}`)).data;
  const updated=await call(`/api/templates/${saved.id}`,{...loaded.definition,name:'Health atualizado',revision:loaded.revision});assert.equal(updated.data.revision,2);
  assert.equal((await call(`/api/templates/${saved.id}`,{...loaded.definition,revision:1})).response.status,409);
  const copy=(await call(`/api/templates/${saved.id}/duplicate`,{})).data;assert.notEqual(copy.id,saved.id);
  const immediate=(await call('/api/runs',(await call(`/api/templates/${saved.id}`)).data.definition)).data;
  assert.equal((await call('/api/runs',input)).response.status,409);
  for(let i=0;i<80;i++){
    jobs=(await call('/api/runs')).data;
    if(jobs.find(j=>j.id===immediate.id)?.result?.reportStatus==='ready')break;
    await pause(100);
  }
  const result=jobs.find(j=>j.id===immediate.id);assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(result.result.requests,received);assert.ok(received>0);
  const xlsx=await fetch(`${app.base}/api/runs/${immediate.id}/xlsx`);assert.equal(xlsx.status,200);
  assert.match(xlsx.headers.get('content-type'),/spreadsheetml/);
  const workbook=new Excel.Workbook();await workbook.xlsx.load(Buffer.from(await xlsx.arrayBuffer()));
  assert.equal(workbook.getWorksheet('Requisições 1').rowCount-6,received);
  assert.equal(workbook.getWorksheet('Resumo').getCell('A9').value,received);
  const stored=JSON.parse(fs.readFileSync(path.join(dir,`${immediate.id}.json`)));assert.equal(stored.config,undefined);
  assert.equal((await call(`/api/templates/${saved.id}/delete`,{})).response.status,200);
  assert.equal((await call(`/api/templates/${saved.id}`)).response.status,404);
  assert.ok((await call('/api/runs')).data.some(j=>j.id===immediate.id),'deleting a template preserves run history');
  // Replay must use the original snapshot even after deleting the saved template.
  const repeat=await call(`/api/runs/${immediate.id}/repeat`,{});assert.equal(repeat.response.status,201,JSON.stringify(repeat.data));
  assert.notEqual(repeat.data.id,immediate.id);assert.equal(repeat.data.repeatedFrom,immediate.id);
  for(let i=0;i<80;i++) {
    jobs=(await call('/api/runs')).data;if(jobs.find(j=>j.id===repeat.data.id)?.result?.reportStatus==='ready')break;await pause(100);
  }
  const repeated=jobs.find(j=>j.id===repeat.data.id);assert.equal(repeated.status,'completed');assert.ok(repeated.result.requests>0);assert.equal(repeated.canRepeat,true);
  assert.equal(jobs.find(j=>j.id===immediate.id).result.requests,result.result.requests,'original results are retained');
  assert.ok(fs.existsSync(path.join(dir,`${immediate.id}.xlsx`)));assert.ok(fs.existsSync(path.join(dir,`${repeated.id}.xlsx`)));
  assert.equal(fs.statSync(path.join(dir,'inputs',`${immediate.id}.json`)).mode&0o777,0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'inputs',`${scheduled.data.id}.json`))).scheduledAt,undefined,'snapshots exclude the old schedule');
  // A due schedule is picked up without a browser being open.
  const due=(await call('/api/runs',{mode:'builder',scenario:{steps:[{method:'GET',url:collection.item[0].request.url,expectedStatus:200}]},stages:'1:1',maxWorkers:1,scheduledAt:new Date(Date.now()+1200).toISOString()})).data;
  for(let i=0;i<80;i++){
    const job=(await call('/api/runs')).data.find(j=>j.id===due.id);
    if(job.status==='completed' && job.result.reportStatus==='ready'){assert.ok(job.result.requests>0);return;}
    await pause(100);
  }
  assert.fail('Scheduled run did not execute');
});
