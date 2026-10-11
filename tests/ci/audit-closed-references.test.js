#!/usr/bin/env node
/**
 * Contract + unit tests for the closed-issue reference audit.
 *
 * Contract side: the maintenance workflow must run the audit on the weekly
 * schedule. Unit side: the pure functions that decide verdicts, including the
 * #3223 failure mode — an issue citing a PR that was closed without merging.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const audit = require('../../scripts/ci/audit-closed-references.js');

const WORKFLOW_PATH = path.join(__dirname, '..', '..', '.github', 'workflows', 'maintenance.yml');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function run() {
  console.log('\n=== Testing closed-issue reference audit ===\n');
  let passed = 0;
  let failed = 0;
  const check = (name, fn) => (test(name, fn) ? passed++ : failed++);

  const source = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  check('maintenance workflow runs the audit on schedule', () => {
    assert.match(source, /closed-reference-audit:/);
    assert.match(source, /node scripts\/ci\/audit-closed-references\.js/);
    assert.match(source, /GH_TOKEN:\s*\$\{\{ github\.token \}\}/);
  });

  check('audit stays read-only: no comment or close calls', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'ci', 'audit-closed-references.js'), 'utf8');
    assert.doesNotMatch(script, /-X\s*(POST|PATCH|PUT)/);
    assert.doesNotMatch(script, /issues\/\$`?\{?\d*[^`]*\/comments['"`]\s*,\s*\[\s*['"`]-X/);
    assert.doesNotMatch(script, /method:\s*['"](POST|PATCH|PUT|DELETE)/);
  });

  const NOW = Date.parse('2026-10-11T12:00:00Z');
  const days = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

  check('delivery-claim references are extracted', () => {
    assert.deepStrictEqual(audit.extractReferencedPrs('fixed in #3133, tracked in #3205'), [3133, 3205]);
    assert.deepStrictEqual(audit.extractReferencedPrs('shipped via #3495'), [3495]);
    assert.deepStrictEqual(audit.extractReferencedPrs('see discussion in #100'), []);
  });

  check('window filter keeps only recent closed issues and drops PRs', () => {
    const issues = [
      { number: 1, state: 'closed', closed_at: days(3) },
      { number: 2, state: 'closed', closed_at: days(45) },
      { number: 3, state: 'open', closed_at: days(1) },
      { number: 4, state: 'closed', closed_at: days(2), pull_request: { url: 'x' } },
      { number: 5, state: 'closed', closed_at: null },
    ];
    const kept = audit.selectRecentClosedIssues(issues, NOW, 30).map((i) => i.number);
    assert.deepStrictEqual(kept, [1]);
  });

  check('comment window starts at issue closure (close comments count)', () => {
    const comments = [
      { body: 'closed as shipped in #3133', created_at: days(10) },
      { body: 'old pre-close chatter #999', created_at: days(40) },
      { body: 'post-close follow-up landed in #3500', created_at: days(1) },
    ];
    const bodies = audit.selectWindowComments(comments, days(11), 30, NOW);
    assert.strictEqual(bodies.length, 2);
    assert.match(bodies[0], /3133/);
    assert.match(bodies[1], /3500/);
  });

  check('#3223 failure mode: citing an unmerged PR fails the verdict', () => {
    const entries = [{ issue: 3223, referencedPrs: [2099, 2104] }];
    const merged = new Map([
      [2099, false],
      [2104, null],
    ]);
    const verdicts = audit.buildVerdicts(entries, merged);
    assert.deepStrictEqual(verdicts.map((v) => v.ok), [false, false]);
    const summary = audit.buildSummary(verdicts).join('\n');
    assert.match(summary, /cites #2099/);
    assert.match(summary, /closed without merging/);
    assert.match(summary, /unverifiable/);
  });

  check('merged citations pass and the all-clear summary is explicit', () => {
    const verdicts = audit.buildVerdicts([{ issue: 3222, referencedPrs: [3133] }], new Map([[3133, true]]));
    assert.deepStrictEqual(verdicts.map((v) => v.ok), [true]);
    assert.match(audit.buildSummary(verdicts).join('\n'), /All cited PRs are merged/);
  });

  check('collectEntries wires issues and comments into verdict inputs', () => {
    const fetchIssues = () => [
      { number: 11, state: 'closed', closed_at: days(2), title: 'release gap', body: null },
    ];
    const fetchComments = () => [{ body: 'resolved in #2104', created_at: days(2) }];
    const entries = audit.collectEntries(fetchIssues, fetchComments, NOW, 30);
    assert.deepStrictEqual(entries, [{ issue: 11, referencedPrs: [2104] }]);
    assert.deepStrictEqual(audit.uniquePrNumbers(entries), [2104]);
  });

  console.log(`\nPassed: ${passed}  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run();
