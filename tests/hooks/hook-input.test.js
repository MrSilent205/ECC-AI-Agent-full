/**
 * Regression tests for bounded hook stdin reads.
 */

'use strict';

const assert = require('assert');
const { PassThrough } = require('stream');
const { getToolResult, getToolResultText, readStdinRaw } = require('../../scripts/hooks/hook-input');
const { run: runConfigProtection } = require('../../scripts/hooks/config-protection');

const TEST_STDIN_LIMIT = 1024;
const STREAM_SETTLEMENT_TIMEOUT_MS = 500;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

async function readFromErroredStream(partialInput) {
  const stream = new PassThrough();
  const resultPromise = readStdinRaw(stream, { maxStdin: TEST_STDIN_LIMIT });
  stream.write(partialInput);
  stream.destroy(new Error('simulated stdin read failure'));
  return resultPromise;
}

async function readFromClosedStream(partialInput) {
  const stream = new PassThrough();
  const resultPromise = readStdinRaw(stream, { maxStdin: TEST_STDIN_LIMIT });
  stream.write(partialInput);
  stream.destroy();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('readStdinRaw did not settle after stream close')),
      STREAM_SETTLEMENT_TIMEOUT_MS
    );
    resultPromise.then(
      result => {
        clearTimeout(timer);
        resolve(result);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function runTests() {
  console.log('\nHook input reader tests:');

  let passed = 0;
  let failed = 0;

  if (
    await test('clean end preserves complete input', async () => {
      const stream = new PassThrough();
      const resultPromise = readStdinRaw(stream, { maxStdin: TEST_STDIN_LIMIT });
      stream.end('{"complete":true}');

      assert.deepStrictEqual(await resultPromise, {
        raw: '{"complete":true}',
        truncated: false
      });
    })
  )
    passed++;
  else failed++;

  if (
    await test('stream error marks partial input as truncated', async () => {
      const partialInput = '{"tool_name":"Write","tool_input":{';
      const result = await readFromErroredStream(partialInput);

      assert.strictEqual(result.raw, partialInput);
      assert.strictEqual(result.truncated, true);
    })
  )
    passed++;
  else failed++;

  if (
    await test('close without end marks partial input as truncated', async () => {
      const partialInput = '{"tool_name":"Write","tool_input":{';
      const result = await readFromClosedStream(partialInput);

      assert.strictEqual(result.raw, partialInput);
      assert.strictEqual(result.truncated, true);
    })
  )
    passed++;
  else failed++;

  if (
    await test('errored partial PreToolUse input remains fail closed', async () => {
      const partialInput = '{"tool_name":"Write","tool_input":{"file_path":".eslintrc.js"';
      const inputResult = await readFromErroredStream(partialInput);
      const hookResult = runConfigProtection(inputResult.raw, {
        truncated: inputResult.truncated,
        maxStdin: TEST_STDIN_LIMIT
      });

      assert.strictEqual(inputResult.truncated, true);
      assert.strictEqual(hookResult.exitCode, 2);
      assert.match(hookResult.stderr, /Refusing to bypass config-protection/);
    })
  )
    passed++;
  else failed++;

  if (
    await test('reads the tool result from Claude Code and from adapted payloads', async () => {
      // Claude Code sends tool_response; Bash results carry stdout and stderr.
      const bash = { stdout: 'out', stderr: 'err', interrupted: false, isImage: false };
      assert.strictEqual(getToolResult({ tool_response: bash }), bash);
      assert.strictEqual(getToolResultText({ tool_response: bash }), 'out\nerr');
      assert.strictEqual(getToolResultText({ tool_response: { stdout: 'out', stderr: '' } }), 'out');
      assert.strictEqual(getToolResultText({ tool_response: 'plain' }), 'plain');
      // The Cursor adapter and older payloads send tool_output.
      assert.strictEqual(getToolResultText({ tool_output: { output: 'adapted' } }), 'adapted');
      assert.strictEqual(getToolResultText({ tool_output: 'legacy' }), 'legacy');
      assert.strictEqual(getToolResultText({ tool_response: { stdout: 'new' }, tool_output: 'old' }), 'new');
      // A result without text, or no result at all.
      assert.strictEqual(getToolResultText({ tool_response: { filePath: '/tmp/a.txt', type: 'create' } }), '');
      assert.strictEqual(getToolResultText({}), '');
      assert.strictEqual(getToolResultText(null), '');
    })
  )
    passed++;
  else failed++;

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
