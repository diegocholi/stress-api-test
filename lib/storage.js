const fs = require('node:fs');
function writeJson(filename, value) {
  const temporary = `${filename}.tmp`;
  fs.writeFileSync(temporary,JSON.stringify(value),{mode:0o600});
  fs.renameSync(temporary,filename);
}
module.exports = {writeJson};
