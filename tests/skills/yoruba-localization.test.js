const { spawnSync } = require('node:child_process');
const path = require('node:path');

const suite = path.join(__dirname, '../../skills/yoruba-localization-testing/examples/localization.test.mjs');
const result = spawnSync(process.execPath, ['--test', suite], { encoding: 'utf8' });

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status || 1;
