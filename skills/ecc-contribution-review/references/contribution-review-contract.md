# ECC contribution review contract

The compiler can only prepare a packet for review. It validates the shape and
internal consistency of supplied observations; it does not independently
inspect repository files, Git state, CI, tests, coverage, or evidence refs.
Every structurally valid packet returns `require_review`. Contradictions
return `reject`. Neither result approves or qualifies a contribution.

The local observation contract checks for:

- exact active repository, non-default branch, base/head, package lock, install
  manifests, catalog script, placement policy, and checkpoint identity;
- a bounded, non-breaking, skills-first change with no unnecessary command shim;
- one canonical curated source, explicit non-generated artifacts, manifest
  coverage, tests, and required harness metadata;
- normalized content parity across Claude, Codex, and Cursor with zero drift;
- filesystem/documented counts, manifest coverage, intentional unshipped
  exceptions, catalog check, and command registry reconciled;
- observed RED/GREEN/REFACTOR, named failing tests, passing behavior tests, and
  line/function/branch/statement coverage at or above 80%;
- eight green validators, security and supply-chain review, bounded change/test
  budgets, twelve hostile probes, and seven typed runners;
- a concise conventional commit proposal, while commit/push/PR effects remain
  false;
- no source-file, test, catalog, git, PR, Control Store, canonical-memory, or
  Semantic Commit claim or requested effect;
- every generated `may*` authority false.

Contradictions reject. Missing or malformed observations require review.
