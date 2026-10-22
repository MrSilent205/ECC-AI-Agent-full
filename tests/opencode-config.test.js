/**
 * Tests for .opencode/opencode.json local file references.
 *
 * Run with: node tests/opencode-config.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

function test(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    return true;
  } catch (err) {
    console.log(`  [FAIL] ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

const repoRoot = path.join(__dirname, "..");
const opencodeDir = path.join(repoRoot, ".opencode");
const configPath = path.join(opencodeDir, "opencode.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

let passed = 0;
let failed = 0;

if (test("model selection inherits the user configured OpenCode provider", () => {
  assert.ok(!Object.prototype.hasOwnProperty.call(config, "model"), "Root config must not pin a provider-specific model");
  assert.ok(!Object.prototype.hasOwnProperty.call(config, "small_model"), "Root config must not pin a provider-specific small model");
  assert.ok(config.agent && typeof config.agent === "object" && !Array.isArray(config.agent) && Object.keys(config.agent).length > 0, "Reference config must define registered agents");
  for (const [agentId, agent] of Object.entries(config.agent)) {
    assert.ok(!Object.prototype.hasOwnProperty.call(agent, "model"), `Agent "${agentId}" must inherit the selected OpenCode model`);
  }
})) passed++; else failed++;

if (test("no explicit plugin registration in opencode.json (V2 auto-discovers)", () => {
  assert.ok(!Object.prototype.hasOwnProperty.call(config, "plugin"), "Legacy v1 plugin key must not be present");
  assert.ok(!Object.prototype.hasOwnProperty.call(config, "plugins"), "V2 does not need explicit plugin registration when the module lives under .opencode/plugins/");
})) passed++; else failed++;

if (test("instruction entries resolve to shipped files", () => {
  const instructions = config.instructions || [];
  assert.ok(instructions.length > 0, "Expected at least one instruction file");
  for (const entry of instructions) {
    const candidates = [path.resolve(opencodeDir, entry)];
    if (entry.startsWith("skills/")) candidates.push(path.resolve(repoRoot, entry));
    assert.ok(candidates.some((c) => fs.existsSync(c)), `Instruction entry should resolve to a shipped file: ${entry}`);
  }
})) passed++; else failed++;

if (test("file references are config-relative and resolve to existing files", () => {
  const refs = [];
  function walk(value) {
    if (typeof value === "string") {
      const matches = value.matchAll(/\{file:([^}]+)\}/g);
      for (const match of matches) refs.push(match[1]);
      return;
    }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === "object") Object.values(value).forEach(walk);
  }
  walk(config);
  assert.ok(refs.length > 0, "Expected to find file references in opencode.json");
  for (const ref of refs) {
    assert.ok(!ref.startsWith(".opencode/"), `File ref should not duplicate .opencode/: ${ref}`);
    assert.ok(fs.existsSync(path.resolve(opencodeDir, ref)), `File ref should resolve from .opencode/: ${ref}`);
  }
})) passed++; else failed++;

if (test("command markdown frontmatter agent ids resolve to a registered opencode agent", () => {
  const commandsDir = path.join(opencodeDir, "commands");
  const registeredAgents = new Set(Object.keys(config.agent || {}));
  assert.ok(registeredAgents.size > 0, "Expected opencode.json to register at least one agent");
  for (const entry of fs.readdirSync(commandsDir)) {
    if (!entry.endsWith(".md")) continue;
    const body = fs.readFileSync(path.join(commandsDir, entry), "utf8");
    const match = body.match(/^agent:\s*(.+)$/m);
    if (!match) continue;
    const agentId = match[1].trim().replace(/^['"]|['"]$/g, "");
    assert.ok(!agentId.includes(":"), `${entry}: command agent must be unscoped, got ${agentId}`);
    assert.ok(registeredAgents.has(agentId), `${entry}: command agent "${agentId}" not registered`);
  }
})) passed++; else failed++;

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
