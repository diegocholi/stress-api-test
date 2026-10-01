const {test}=require('node:test');
const assert=require('node:assert/strict');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const run=promisify(execFile);
test('CLI returns zero only for a completed approved measurement with a generated XLSX',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stress-cli-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const server=http.createServer((_req,res)=>res.end('ok'));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const collection=path.join(dir,'collection.json');fs.writeFileSync(collection,JSON.stringify({info:{name:'CLI'},item:[{name:'GET',request:{method:'GET',url:`http://127.0.0.1:${server.address().port}`}}]}));
  const args=[path.join(__dirname,'../load-runner.js'),`--collection=${collection}`,'--stages=1:1','--maxWorkers=1','--minLoadPercent=0'];
  const approved=await run(process.execPath,[...args,'--minResponses=1',`--xlsx=${path.join(dir,'approved.xlsx')}`]);
  const snapshots=approved.stdout.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));assert.equal(snapshots[0].passed,false);assert.equal(snapshots.at(-1).passed,true);assert.equal(snapshots.at(-1).evaluation.verdict,'approved');assert.ok(fs.existsSync(path.join(dir,'approved.xlsx')));
  let failed;try{await run(process.execPath,[...args,'--minResponses=100000000',`--xlsx=${path.join(dir,'inconclusive.xlsx')}`]);}catch(err){failed=err;}
  assert.equal(failed?.code,1);const result=failed.stdout.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line)).at(-1);assert.equal(result.evaluation.verdict,'inconclusive');assert.equal(result.passed,false);assert.equal(result.reportStatus,'ready');
});
