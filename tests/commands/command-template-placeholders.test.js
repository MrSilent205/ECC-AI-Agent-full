'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const commandsDir = path.join(repoRoot, 'commands');

// Installer-time substitution tokens such as {{LITE_MODE_FLAG}} come from
// upstream command templates (e.g. ccg-workflow). ECC installs commands
// verbatim, so any such token reaches the shell as a literal argument.
const TEMPLATE_TOKEN = /\{\{[A-Z][A-Z0-9_]*\}\}/g;
const WRAPPER_CALL = /codeagent-wrapper\s+(\S+)/g;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

function listCommandFiles(filter = () => true) {
  return fs.readdirSync(commandsDir)
    .filter(name => name.endsWith('.md') && filter(name))
    .sort();
}

function readCommand(name) {
  return fs.readFileSync(path.join(commandsDir, name), 'utf8');
}

console.log('\n=== Testing command template placeholders ===\n');

test('commands ship without unrendered {{TEMPLATE}} tokens', () => {
  const hits = [];

  for (const name of listCommandFiles()) {
    readCommand(name).split('\n').forEach((line, index) => {
      for (const match of line.matchAll(TEMPLATE_TOKEN)) {
        hits.push(`commands/${name}:${index + 1} ${match[0]}`);
      }
    });
  }

  assert.deepStrictEqual(hits, [], `Unrendered template tokens:\n${hits.join('\n')}`);
});

test('multi-* codeagent-wrapper calls pass --backend as the first argument', () => {
  const files = listCommandFiles(name => name.startsWith('multi-'));
  const bad = [];
  let calls = 0;

  for (const name of files) {
    for (const match of readCommand(name).matchAll(WRAPPER_CALL)) {
      calls++;
      if (match[1] !== '--backend') {
        bad.push(`commands/${name}: codeagent-wrapper ${match[1]}`);
      }
    }
  }

  assert.ok(files.length > 0, 'Expected multi-* command files');
  assert.ok(calls > 0, 'Expected codeagent-wrapper calls in multi-* commands');
  assert.deepStrictEqual(bad, [], `Wrapper calls with a non --backend first argument:\n${bad.join('\n')}`);
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
