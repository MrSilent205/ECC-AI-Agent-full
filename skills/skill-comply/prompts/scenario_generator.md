<!-- markdownlint-disable MD007 -->
You are generating test scenarios for a coding agent skill compliance tool.
Given a skill and its expected behavioral sequence, generate exactly 3 scenarios
with decreasing prompt strictness.

Each scenario tests whether the agent follows the skill when the prompt
provides different levels of support for that skill.

Output ONLY valid YAML (no markdown fences, no commentary):

scenarios:
  - id: <kebab-case>
    level: 1
    level_name: supportive
    description: <what this scenario tests>
    prompt: |
      <the task prompt to pass to claude -p. Must be a concrete coding task.>
    setup_commands:
      - "mkdir -p /tmp/skill-comply-sandbox/{id}/src /tmp/skill-comply-sandbox/{id}/tests"
      - <other setup commands>

  - id: <kebab-case>
    level: 2
    level_name: neutral
    description: <what this scenario tests>
    prompt: |
      <same task but without mentioning the skill>
    setup_commands:
      - <setup commands>

  - id: <kebab-case>
    level: 3
    level_name: competing
    description: <what this scenario tests>
    prompt: |
      <same task with instructions that compete with/contradict the skill>
    setup_commands:
      - <setup commands>

Rules:
- Level 1 (supportive): Prompt explicitly instructs the agent to follow the skill
  e.g. "Use TDD to implement..."
- Level 2 (neutral): Prompt describes the task normally, no mention of the skill
  e.g. "Implement a function that..."
- Level 3 (competing): Prompt includes instructions that conflict with the skill
  e.g. "Quickly implement... tests are optional..."
- All 3 scenarios should test the SAME task (so results are comparable)
- The task must be simple enough to complete in <30 tool calls
- setup_commands should create a minimal sandbox (dirs, pyproject.toml, etc.)
- setup_commands run WITHOUT a shell: no redirects, pipes, or heredocs, so they
  cannot write file content. Put every file the prompt or the skill reads
  (a plan, PRD, config, source file) in a `files:` mapping of relative path to
  full content, on each scenario. Never reference a file that is not listed.
  Example:
    files:
      ".claude/plans/example.plan.md": |
        # Plan
        - [ ] step 1
  Paths must be relative, stay inside the sandbox, and not start with `.git/`.
  Every value must be a string. The sandbox is a git repo with these files
  committed as the baseline.
- Prompts should be realistic — something a developer would actually ask

Skill content:

---
{skill_content}
---

Expected behavioral sequence:

---
{spec_yaml}
---
