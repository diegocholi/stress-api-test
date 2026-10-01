const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {once} = require('node:events');
const http = require('node:http');
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
test('web API imports, schedules persist, cancels, executes and downloads exact CSV',async t=>{
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
  const immediate=(await call('/api/runs',input)).data;
  assert.equal((await call('/api/runs',input)).response.status,409);
  for(let i=0;i<80;i++){
    jobs=(await call('/api/runs')).data;
    if(jobs.find(j=>j.id===immediate.id)?.status==='completed')break;
    await pause(100);
  }
  const result=jobs.find(j=>j.id===immediate.id);assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(result.result.requests,received);assert.ok(received>0);
  const csv=await fetch(`${app.base}/api/runs/${immediate.id}/csv`);assert.equal(csv.status,200);
  assert.equal((await csv.text()).trim().split('\n').length-1,received);
  const stored=JSON.parse(fs.readFileSync(path.join(dir,`${immediate.id}.json`)));assert.equal(stored.config,undefined);
  // A due schedule is picked up without a browser being open.
  const due=(await call('/api/runs',{mode:'builder',scenario:{steps:[{method:'GET',url:collection.item[0].request.url,expectedStatus:200}]},stages:'1:1',maxWorkers:1,scheduledAt:new Date(Date.now()+1200).toISOString()})).data;
  for(let i=0;i<80;i++){
    const job=(await call('/api/runs')).data.find(j=>j.id===due.id);
    if(job.status==='completed'){assert.ok(job.result.requests>0);return;}
    await pause(100);
  }
  assert.fail('Scheduled run did not execute');
});
