const http = require('node:http');
http.createServer((req,res) => {res.writeHead(req.url === '/health' ? 200 : 404, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:req.url==='/health'}));}).listen(4000,'127.0.0.1',()=>console.log('API de exemplo: http://127.0.0.1:4000/health'));
