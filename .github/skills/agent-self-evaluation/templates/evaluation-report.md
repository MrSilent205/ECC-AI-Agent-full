# Agent Self-Evaluation Report Template

Copy this template and fill in after completing a task. The format matches `scripts/evaluate.py` output.

```
============================================================
AGENT SELF-EVALUATION REPORT
============================================================
Summary: Overall score X.X/5 across 5 assessed quality axes.

  Accuracy         █████ 5/5    or    ███░░ 3/5
    + [Evidence: passing tests, verified claims]
    - [Gaps: unverified claims, hedging language]
    → [Improvement if score < 5]

  Completeness      █████ 5/5
    + [What's covered: all requirements + edge cases]
    - [What's missing: explicitly acknowledge gaps]
    → [Improvement if score < 5]

  Clarity           █████ 5/5
    + [Structure: headings, code blocks, bullet points]
    - [Issues: undefined terms, wall of text, no summary]
    → [Improvement if score < 5]

  Actionability     █████ 5/5
    + [User can: merge PR, run command, review file]
    - [Blockers: missing steps, vague suggestions]
    → [Improvement if score < 5]

  Conciseness       █████ 5/5
    + [Tight: no repetition, high information density]
    - [Bloat: filler, meta-commentary, repeated points]
    → [Improvement if score < 5]

  OVERALL           X.X/5

CRITICAL ISSUES (axes ≤ 2):
  [Axis] Score N/5 — specific fix needed
  (or "None" if no axis ≤ 2)

Self-check: Would the user agree with this assessment? [Yes/No + brief justification]

TOP IMPROVEMENTS:
  1. [Highest impact fix]
  2. [Second highest]
  (Only list axes scoring < 4, ranked by user impact)

VERDICT: [Deliver as-is / Ask the user whether to redo or deliver / Redo from scratch]
```

If any axis is unassessed, show `N/A` for that axis, report the number of assessed axes, and state that manual review is required before assigning an overall score or verdict.

## Quick Reference: Scoring Triggers

| If you see this... | Accuracy | Completeness | Clarity | Actionability | Conciseness |
|---|---|---|---|---|---|
| "should work" / "probably fine" | ≤4 | — | — | — | — |
| "I think" / "I believe" | ≤4 | — | — | — | — |
| No verification signal cited | ≤3 | — | — | — | — |
| "TODO" / "FIXME" left behind | ≤3 | ≤3 | — | ≤3 | — |
| Missing error handling | — | ≤3 | — | — | — |
| Only happy path covered | — | ≤3 | — | — | — |
| Wall-of-text paragraph (>200 words) | — | — | ≤3 | — | — |
| No headings or structure | — | — | ≤3 | — | — |
| "You should..." without specifics | — | — | — | ≤3 | — |
| No PR or file created | — | — | — | ≤3 | — |
| User needs to figure out next step | — | — | — | ≤2 | — |
| Repeated points (3+ times) | — | — | — | — | ≤3 |
| "Let me explain..." / "To summarize..." x3+ | — | — | — | — | ≤3 |
| Output >15x longer than task | — | — | — | — | ≤3 |

## When to Skip

Skip the evaluation if:
- Task was a single tool call (e.g., "read this file" — nothing to evaluate)
- User explicitly says "don't evaluate" or "just do it"
- Task is purely conversational (greeting, small talk)
- You're mid-workflow and the user will judge the final output, not intermediate steps

## Post-Evaluation Actions

| Overall Score | What to do |
|---|---|
| ≥4.5 | Deliver as-is. No changes needed. |
| 3.5–4.4 | Flag top improvement but deliver. Fix if <30 seconds. |
| 2.5–3.4 | Ask user whether to redo the weakest axis or deliver as-is. |
| <2.5 | Don't deliver. State the evidence and redo with specific fixes. |
| Any axis unassessed | Manually review that axis before assigning an overall score or verdict. |
