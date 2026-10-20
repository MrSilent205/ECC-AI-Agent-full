# SessionEnd Feedback Hook — Security Evidence

Scope: `hooks/hooks.json` (SessionEnd entries), `hooks/hooks.metadata.json`,
`scripts/hooks/success-feedback-prompt.js`, `scripts/lib/success-feedback.js`
— the exact paths flagged by the ecc-tools Security Evidence gate on PR #3038.

## Scanner attempts

`ecc-agentshield@1.6.0` was run against `scripts/hooks` and `hooks`:

```bash
npx --yes ecc-agentshield@1.6.0 scan --path scripts/hooks --format json --evidence-pack <tmp>
npx --yes ecc-agentshield@1.6.0 scan --path hooks --format json --evidence-pack <tmp>
```

Both runs exited 0 with grade A but reported `filesScanned: 0` — AgentShield
recognizes Claude-config skill surfaces, not this hook surface, so its empty
SARIF is **not** committed here (an empty SARIF would be misleading evidence).

## Secret sweep (genuine output)

Pattern sweep (`ghp_`, `sk-live/test/ant`, `AKIA`, `xoxb/xoxp/xoxa`,
`PRIVATE KEY`, `api_key`/`secret`/`password` assignments) over the 11
PR-surface files under `hooks scripts tests package.json` plus all 13
working-tree files:

- PR surface: scanned=11 hits=0
- Working tree: scanned=13 hits=0

## Focused security regressions (all passing)

- `tests/hooks/hook-id-consistency.test.js` (new, 4/4): every SessionEnd
  runtime hook ID is published in metadata and vice versa; `ECC_DISABLED_HOOKS`
  disables `session:end:feedback` by its published ID; the feedback entry runs
  synchronously so SessionEnd stderr reaches the user.
- `tests/hooks/success-feedback-prompt.test.js` (12/12): milestone claim is
  exclusive across concurrent processes (two-process fixture), failed state
  writes stay silent and retry-eligible, opt-out respected.
- `tests/lib/success-feedback.test.js` (11/11): unknown persisted milestones
  cannot retire valid ones.
- `node scripts/ci/validate-hooks.js`: 28 hook matchers validated (exit 0),
  including fingerprint integrity for the SessionEnd entries.

## Gate status (observed, not claimed)

The ecc-tools Security Evidence check still reports `action_required`, and its
own comments state "Check publication was denied or unavailable. An app owner
must enable Checks: read and write." That permission belongs to the app owner,
not this PR — reported as blocked, pending owner action.
