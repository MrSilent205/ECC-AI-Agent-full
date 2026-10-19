#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const { adaptCopilotAgent } = require(path.join(
  REPO_ROOT,
  'scripts',
  'lib',
  'install',
  'copilot-agent'
));

function listFiles(root, relativePath = '') {
  return fs.readdirSync(path.join(root, relativePath), { withFileTypes: true })
    .flatMap(entry => {
      const entryPath = path.join(relativePath, entry.name);
      if (entry.isDirectory()) return listFiles(root, entryPath);
      if (!entry.isFile()) return [];
      return [entryPath.split(path.sep).join('/')];
    })
    .sort();
}

function assertSameFileSet(sourceRoot, copyRoot, label) {
  const sourceFiles = listFiles(sourceRoot);
  const copyFiles = listFiles(copyRoot);
  assert.deepStrictEqual(
    copyFiles,
    sourceFiles,
    `${label} file set differs:\n` +
      `  missing: ${sourceFiles.filter(file => !copyFiles.includes(file)).join(', ') || '<none>'}\n` +
      `  extra: ${copyFiles.filter(file => !sourceFiles.includes(file)).join(', ') || '<none>'}`
  );
  return sourceFiles;
}

function listDirectories(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
}

const tests = [
  ['checked-in Copilot agents match transformed canonical agents', () => {
    const sourceRoot = path.join(REPO_ROOT, 'agents');
    const copyRoot = path.join(REPO_ROOT, '.github', 'agents');
    const files = assertSameFileSet(sourceRoot, copyRoot, 'Copilot agents');
    const drift = files.filter(file => {
      const source = fs.readFileSync(path.join(sourceRoot, file), 'utf8');
      const copied = fs.readFileSync(path.join(copyRoot, file), 'utf8');
      return adaptCopilotAgent(source, `agents/${file}`) !== copied;
    });
    assert.deepStrictEqual(drift, [], `out-of-date Copilot agents:\n  ${drift.join('\n  ')}`);
  }],
  ['checked-in Copilot skills match canonical skill files', () => {
    const sourceSkillsRoot = path.join(REPO_ROOT, 'skills');
    const copySkillsRoot = path.join(REPO_ROOT, '.github', 'skills');
    const sourceSkills = listDirectories(sourceSkillsRoot);
    const copiedSkills = listDirectories(copySkillsRoot);
    assert.deepStrictEqual(
      copiedSkills,
      copiedSkills.filter(skill => sourceSkills.includes(skill)),
      'Copilot skills contain directories without canonical sources'
    );

    for (const skill of copiedSkills) {
      const sourceRoot = path.join(sourceSkillsRoot, skill);
      const copyRoot = path.join(copySkillsRoot, skill);
      const files = assertSameFileSet(sourceRoot, copyRoot, `Copilot skill ${skill}`);
      const drift = files.filter(file =>
        !fs.readFileSync(path.join(sourceRoot, file))
          .equals(fs.readFileSync(path.join(copyRoot, file)))
      );
      assert.deepStrictEqual(drift, [], `out-of-date Copilot skill ${skill} files:\n  ${drift.join('\n  ')}`);
    }
  }],
];

let failed = 0;
console.log('\n=== Testing checked-in Copilot copies ===\n');
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.error(`    ${error.message}`);
  }
}

console.log(`\nResults: Passed: ${tests.length - failed}, Failed: ${failed}`);
if (failed > 0) process.exitCode = 1;
