'use strict';

const { StringDecoder } = require('string_decoder');

const DEFAULT_MAX_STDIN = 1024 * 1024;

function resolveMaxStdin(value, options = {}) {
  const writeDiagnostic = options.writeDiagnostic || (() => {});
  if (value === undefined || value === '') return DEFAULT_MAX_STDIN;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    writeDiagnostic(
      '[Hook] ECC_HOOK_INPUT_MAX_BYTES must be a positive safe integer; using the 1 MiB default\n'
    );
    return DEFAULT_MAX_STDIN;
  }
  if (parsed > DEFAULT_MAX_STDIN) {
    writeDiagnostic(
      '[Hook] ECC_HOOK_INPUT_MAX_BYTES exceeds the 1 MiB safety maximum; clamping to 1 MiB\n'
    );
    return DEFAULT_MAX_STDIN;
  }
  return parsed;
}

function readStdinRaw(stream = process.stdin, options = {}) {
  const maxStdin = options.maxStdin || DEFAULT_MAX_STDIN;
  const decoder = new StringDecoder('utf8');
  let raw = '';
  let acceptedBytes = 0;
  let truncated = options.truncated === true;

  return new Promise(resolve => {
    let settled = false;
    stream.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (typeof options.onChunk === 'function') options.onChunk(buffer);
      const remaining = Math.max(0, maxStdin - acceptedBytes);
      const accepted = buffer.subarray(0, remaining);
      if (accepted.length > 0) {
        raw += decoder.write(accepted);
        acceptedBytes += accepted.length;
      }
      if (accepted.length < buffer.length) truncated = true;
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      if (!truncated) raw += decoder.end();
      resolve({ raw, truncated });
    };
    const finishIncomplete = () => {
      if (settled) return;
      truncated = true;
      finish();
    };
    stream.once('end', finish);
    // A transport error or premature close can leave a syntactically plausible
    // prefix behind. Mark it incomplete so safety hooks remain fail closed.
    stream.once('error', finishIncomplete);
    stream.once('close', finishIncomplete);
  });
}

/**
 * The result a PostToolUse payload carries for its tool. Claude Code sends it as
 * `tool_response`, which for Bash is an object with `stdout` and `stderr`; the
 * Cursor adapter and older callers send `tool_output`, a string or `{ output }`.
 */
function getToolResult(input) {
  return input?.tool_response ?? input?.tool_output;
}

/**
 * The text of that result: a string as it is, an adapted `output`, or the
 * `stdout` and `stderr` of a Bash result. An empty string when it has no text.
 */
function getToolResultText(input) {
  const result = getToolResult(input);
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  if (typeof result.output === 'string') return result.output;
  return [result.stdout, result.stderr].filter(part => typeof part === 'string' && part !== '').join('\n');
}

module.exports = {
  DEFAULT_MAX_STDIN,
  getToolResult,
  getToolResultText,
  readStdinRaw,
  resolveMaxStdin
};
