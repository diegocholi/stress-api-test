const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {validate} = require('../lib/config');
const {Runner} = require('../lib/runner');
const base = steps => ({mode:'builder',scenario:{variables:[],steps},stages:'2:1',timeout:5000,maxWorkers:1,evidence:{minResponses:1,minLoadPercent:0}});
const step = {method:'GET',url:'http://127.0.0.1/health',expectedStatus:200};
test('builder rejects invalid URLs, JSON, headers and validation paths',()=>{
  assert.throws(()=>validate(base([{...step,url:'file:///etc/passwd'}])),/URL HTTP/);
  assert.throws(()=>validate(base([{...step,bodyType:'json',body:'{broken'}])),/JSON inválido/);
  assert.throws(()=>validate(base([{...step,headers:[{key:'X-Test',value:'a\r\nb'}]}])),/quebra de linha/);
  assert.throws(()=>validate(base([{...step,jsonCheck:{path:'data[0]',value:1}}])),/Caminho JSON/);
  assert.throws(()=>validate(base([{...step,extract:{path:'data.token',variable:'bad name'}}])),/variável extraída/);
  assert.throws(()=>validate({...base([step]),scenario:{steps:[step],variables:[{value:'x'}]}}),/variável inválido/);
  assert.throws(()=>validate({...base([step]),mode:'unknown'}),/Modo/);
});
test('interface scenario performs ordered login, extraction, templated body, headers and assertions',async t=>{
  let logins=0, authorized=0;const tokens=new Set();
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/login') {
      let body='';for await(const chunk of req)body+=chunk;
      const data=JSON.parse(body);assert.match(data.email,/^user_.+@example.com$/);assert.equal(req.headers['content-type'],'application/json');
      const token=`token-${++logins}`;tokens.add(token);res.end(JSON.stringify({data:{token}}));
    } else {
      const token=req.headers.authorization?.replace('Bearer ','');
      if(tokens.delete(token)){authorized++;res.end(JSON.stringify({ok:true,items:[{id:42}]}));}
      else {res.statusCode=401;res.end(JSON.stringify({ok:false}));}
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const input=base([
    {name:'Login',method:'POST',url:'{{BASE_URL}}/login',bodyType:'json',body:'{"email":"{{UNIQUE_EMAIL}}"}',expectedStatus:200,extract:{path:'data.token',variable:'TOKEN'}},
    {name:'Authenticated',method:'GET',url:'{{BASE_URL}}/profile',headers:[{key:'Authorization',value:'Bearer {{TOKEN}}'}],expectedStatus:200,contains:'"ok":true',jsonCheck:{path:'items.0.id',value:42}}
  ]);
  input.scenario.variables=[{key:'BASE_URL',value:`http://127.0.0.1:${server.address().port}`}];
  const result=await new Runner(input).start();
  assert.equal(result.status,'completed',JSON.stringify(result));assert.ok(logins>1);assert.equal(authorized,logins);
  assert.equal(result.requests,logins+authorized);assert.equal(result.assertionFailures,0);assert.equal(result.scriptFailures,0);assert.ok(result.passed);
});
test('a response validation fails without injecting code from expected text',async t=>{
  const server=http.createServer((_req,res)=>res.end('ok'));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const result=await new Runner(base([{...step,url:`http://127.0.0.1:${server.address().port}`,contains:"'); throw new Error('injected'); //"}])).start();
  assert.equal(result.status,'completed');assert.equal(result.failedRequests,0);assert.ok(result.assertionFailures>0);assert.equal(result.scriptFailures,0);assert.equal(result.passed,false);
});

test('builder validates variable availability in order and JSON template structure',()=>{
  assert.throws(()=>validate(base([{...step,url:'{{MISSING}}/x'}])),/variável não definida/);
  assert.throws(()=>validate(base([{...step,headers:[{key:'Authorization',value:'{{LATER}}'}]},{...step,extract:{path:'token',variable:'LATER'}}])),/variável não definida/);
  assert.throws(()=>validate({...base([{...step,bodyType:'json',body:'{ invalid {{VALUE}}'}]),scenario:{variables:[{key:'VALUE',value:'1'}],steps:[{...step,bodyType:'json',body:'{ invalid {{VALUE}}'}]}}),/JSON inválido/);
  assert.doesNotThrow(()=>validate(base([{...step,extract:{path:'id',variable:'ID'}},{...step,bodyType:'json',body:'{"id":{{ID}}}'}])));
});
test('JSON templates serialize dynamic quotes safely before sending',async t=>{
  let received=0;const server=http.createServer((_req,res)=>{received++;res.end('ok');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const input=base([{method:'POST',url:`http://127.0.0.1:${server.address().port}`,bodyType:'json',body:'{"value":"{{VALUE}}"}'}]);
  input.singleRun=true;input.scenario.variables=[{key:'VALUE',value:'unescaped"quote'}];
  const result=await new Runner(input).start();assert.equal(received,1);assert.equal(result.requests,1);assert.equal(result.assertionFailures,0,JSON.stringify(result));assert.equal(result.passed,true);
});
