const path = require('path')
const async = require('async')
const newman = require('newman')

const PARALLEL_RUN_COUNT = 400

let successfullyCount = 0
let failuresCount = 0

const parametersForTestRun = {
  collection: path.join(__dirname, 'postman/postman_collection.json'), // your collection
  // environment: path.join(__dirname, 'postman/localhost.postman_environment.json'), //your env
  reporters: 'cli',
}

parallelCollectionRun = function (done) {
  newman.run(parametersForTestRun, done)
}

let commands = []
for (let index = 0; index < PARALLEL_RUN_COUNT; index++) {
  commands.push(parallelCollectionRun)
}

// Runs the Postman sample collection thrice, in parallel.
async.parallel(commands, (err, results) => {
  err && console.error(err)

  results.forEach(function (result) {
    var failures = result.run.failures
    if (failures.length) failuresCount++
    else successfullyCount++
  })

  console.info(`Número de requisições feitas: ${PARALLEL_RUN_COUNT}`)
  console.info(`Sucessos: ${successfullyCount} | Falhas: ${failuresCount}`)
})
