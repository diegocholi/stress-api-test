# stress-api-test

Teste de stress em APIs a partir de arquivos postman.json

## Criação do projeto:

Basta executar `npm init -y` e instalar as 3 dependências:

```
npm i async newman path
```

```
{
 "name": "newman_parallel",
 "version": "1.0.0",
 "description": "",
 "main": "index.js",
 "scripts": {
   "start": "node index.js"
 },
 "keywords": [],
 "author": "",
 "license": "ISC",
 "dependencies": {
   "async": "^3.1.0",
   "newman": "^4.5.6",
   "path": "^0.12.7"
 }
}
```

Atualize o caminho para sua coleção e ambiente, especifique o número de execução simultânea que você deseja iniciar com a constante `PARALLEL_RUN_COUNT` e execute o script com `npm start`

```
const path = require('path')
const async = require('async')
const newman = require('newman')

const PARALLEL_RUN_COUNT = 2

const parametersForTestRun = {
   collection: path.join(__dirname, 'postman/postman_collection.json'), // your collection
   environment: path.join(__dirname, 'postman/localhost.postman_environment.json'), //your env
   reporters: 'cli'
};

parallelCollectionRun = function (done) {
   newman.run(parametersForTestRun, done);
};

let commands = []
for (let index = 0; index < PARALLEL_RUN_COUNT; index++) {
   commands.push(parallelCollectionRun);
}

// Runs the Postman sample collection thrice, in parallel.
async.parallel(
   commands,
   (err, results) => {
       err && console.error(err);

       results.forEach(function (result) {
           var failures = result.run.failures;
           console.info(failures.length ? JSON.stringify(failures.failures, null, 2) :
               `${result.collection.name} ran successfully.`);
       });
   });
```

### Definir quantidade de memória para o processo:

```
node --max-old-space-size=4096 yourFile.js
```

HELP: https://docs.google.com/document/d/11W2tqpMXhqYtd0zzGY-nPqCy0n8S9uTypY9AnLNT5AU/edit#
