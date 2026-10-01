const {spawnSync} = require('node:child_process');

function start() {
  try {
    for(const dependency of ['newman','exceljs','yauzl','yazl'])require(dependency);
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    console.log('Instalando as dependências para iniciar o Stress Lab…');
    const npmCli = process.env.npm_execpath;
    const install = npmCli
      ? spawnSync(process.execPath, [npmCli, ...(/pnpm/.test(npmCli)?['install','--frozen-lockfile']:['ci'])], {cwd: require('node:path').join(__dirname, '..'), stdio: 'inherit'})
      : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci'], {
        cwd: require('node:path').join(__dirname, '..'), stdio: 'inherit', shell: process.platform === 'win32'
      });
    if (install.error || install.status !== 0) {
      console.error('Não foi possível instalar as dependências. Verifique a conexão e tente novamente.');
      process.exitCode = install.status || 1;
      return;
    }
  }
  require('../server');
}

start();
