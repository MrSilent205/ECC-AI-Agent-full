'use strict';

const path = require('path');

const { stripPluginNamespace } = require('./plugin-namespace');
const { adaptAntigravityAgent } = require('./antigravity-agent');
const { adaptCopilotAgent } = require('./copilot-agent');
const { disableOpenCodeHookPluginRegistration, getDisabledOpenCodePluginContent } = require('./hook-consent');

function rewriteCopilotWorkflowPaths(content, sourceRelativePath) {
  if (!/\.md$/i.test(sourceRelativePath)) return content;
  // Commands run from the installed project root. Rewrite only the supported
  // helper entrypoint, leaving unrelated project scripts and URLs untouched.
  return content
    .replace(/(^|[\s`"'(])\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/setup-package-manager\.js\b/g,
      '$1.github/ecc/scripts/setup-package-manager.js')
    .replace(/(^|[\s`"'(])\$ecc_tdd_plugin_root\/scripts\/setup-package-manager\.js\b/g,
      '$1.github/ecc/scripts/setup-package-manager.js')
    .replace(/(^|[\s`"'(])scripts\/setup-package-manager\.js\b/g,
      '$1.github/ecc/scripts/setup-package-manager.js');
}

function rewriteStandaloneTddDetector(operation, content) {
  if (String(operation.sourceRelativePath || '').replace(/\\/g, '/') !== 'skills/tdd-workflow/SKILL.md') return content;
  const command = /node (?:"(?:\$\{CLAUDE_PLUGIN_ROOT\}|\$ecc_tdd_plugin_root)\/scripts\/setup-package-manager\.js"|scripts\/setup-package-manager\.js) --detect/g;
  if (!command.test(content)) return content;
  const destination = operation.destinationPath;
  if (typeof destination !== 'string' || !path.isAbsolute(destination)
    || path.basename(destination) !== 'SKILL.md'
    || path.basename(path.dirname(destination)) !== 'tdd-workflow'
    || path.basename(path.dirname(path.dirname(destination))) !== 'skills') {
    throw new Error('Invalid standalone TDD skill destination');
  }
  const root = path.dirname(path.dirname(path.dirname(destination)));
  const helper = path.join(root, 'scripts', 'setup-package-manager.js').split(path.sep).join('/');
  // This is a Bash command in Markdown. Single-quote the complete argument so
  // spaces, quotes and shell metacharacters in the install root stay literal.
  const quoted = "'" + helper.replace(/'/g, "'\\''") + "'";
  return content.replace(command, () => `node ${quoted} --detect`);
}

function transformInstallContent(operation, content) {
  if (!operation.contentTransform) {
    return content;
  }
  if (operation.contentTransform === 'claude-manual-plugin-namespace') {
    return rewriteStandaloneTddDetector(operation, stripPluginNamespace(content));
  }
  if (operation.contentTransform === 'qwen-agent-frontmatter') {
    return require('../../qwen-adapt-agents').adaptFrontmatter(content).text;
  }
  if (operation.contentTransform === 'antigravity-agent-frontmatter') {
    return adaptAntigravityAgent(content, operation.sourceRelativePath);
  }
  if (operation.contentTransform === 'copilot-agent-frontmatter') {
    return rewriteCopilotWorkflowPaths(adaptCopilotAgent(content, operation.sourceRelativePath), operation.sourceRelativePath);
  }
  if (operation.contentTransform === 'copilot-workflow-paths') {
    return rewriteCopilotWorkflowPaths(content, operation.sourceRelativePath);
  }
  if (operation.contentTransform === 'opencode-disable-ecc-hooks') {
    return transformInstallContent({ ...operation, contentTransform: 'opencode-home-skills-path' },
      disableOpenCodeHookPluginRegistration(content, operation.sourceRelativePath));
  }
  if (operation.contentTransform === 'opencode-disable-plugin-entrypoint') {
    return getDisabledOpenCodePluginContent();
  }
  if (operation.contentTransform === 'opencode-home-skills-path') {
    const config = JSON.parse(content);
    if (!Array.isArray(config?.skills?.paths) || !config.skills.paths.includes('../skills')) {
      return content;
    }
    const installedConfig = {
      ...config,
      skills: {
        ...config.skills,
        paths: config.skills.paths.map(skillPath => skillPath === '../skills' ? './skills' : skillPath),
      },
    };
    return `${JSON.stringify(installedConfig, null, 2)}\n`;
  }
  throw new Error(`Unknown install content transform: ${operation.contentTransform}`);
}

module.exports = { transformInstallContent };
