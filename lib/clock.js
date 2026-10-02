const { performance } = require('node:perf_hooks')
// Epoch-compatible timestamps which cannot jump when the system clock changes.
const now = () => performance.timeOrigin + performance.now()
module.exports = { now }
