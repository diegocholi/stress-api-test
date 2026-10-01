const {defineConfig} = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
module.exports = defineConfig({
  testDir: './test/browser', timeout: 45000, workers: 1, reporter: 'list',
  use: {baseURL: 'http://127.0.0.1:3099', headless: true, launchOptions: {
    ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : process.platform === 'darwin' ? {executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'} : {})
  }},
  webServer: {command: 'node server.js', port: 3099, reuseExistingServer: false,
    env: {PORT: '3099', STRESS_DATA_DIR: path.join(os.tmpdir(), `stress-browser-${process.pid}`)}}
});
