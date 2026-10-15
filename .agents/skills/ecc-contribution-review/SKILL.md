---
name: ecc-contribution-review
description: Prepare an ECC repository contribution for review by organizing repository, install-surface, cross-harness, validation, security, and commit observations into a local proposal. Use when preparing a skill, agent, command, hook, rule, or script contribution for review.
metadata:
  origin: ECC
---

# ECC Contribution Review Packet

Use this workflow to prepare contribution observations for maintainer review.
It compiles supplied observations; it does not independently inspect Git,
files, CI, test results, coverage, or referenced evidence. Treat every imported
claim as unverified until a reviewer checks its evidence.

## Workflow

1. Start from the active ECC checkout. Record the branch, base and head, package
   lock, install manifests, catalog generator, skill placement policy, and a
   checkpoint.
2. Identify the canonical source under `skills/` for curated workflows. Keep
   generated, learned, and imported content outside shipped sources.
3. Record the change intent, artifact graph, install coverage, harness copies,
   catalog and registry counts, test phases, coverage, security review,
   budgets, and commit proposal with evidence references.
4. Run the required validators and tests separately. Record exact commands,
   results, and evidence. The compiler does not execute them.
5. Copy the template, then edit the copy to replace every placeholder with
   current observations and references to evidence you gathered. The template
   is intentionally incomplete and must not be treated as an observation.
   After editing it, compile the packet:

   ```bash
   mkdir -p .memory-kit
   cp skills/ecc-contribution-review/templates/contribution-review-observation.json \
     .memory-kit/contribution-review-observation.json
   python3 skills/ecc-contribution-review/scripts/compile_contribution_review.py \
     .memory-kit/contribution-review-observation.json \
     --output .memory-kit/ecc-contribution-review.json
   ```

   `--output` writes a new capsule file in the existing parent directory and
   refuses to overwrite any existing path. The compiler does not create
   directories, modify source files, run tests, update catalogs, commit, push,
   or open a pull request. Exit code 0 means the packet compiled; it does not
   mean the change passed review.

6. Review every reported contradiction and semantic page fault. The compiler
   returns `require_review` for structurally valid input and never approves a
   contribution. It does not prove that supplied claims are true or CI passed.
7. Recompile after changes to HEAD, policy, manifests, catalog, adapters, tests,
   coverage, security findings, or review evidence.

## Local Contract

The packet describes source ownership, generated-root exclusion, install
coverage, normalized harness identity, catalog reconciliation, TDD claims,
security review, validation gates, and a conventional-commit proposal. Runner
proposals are typed argument arrays and remain unexecuted. All generated
authority and external effects remain false.

See [the workflow](docs/WORKFLOW.md), [the design](docs/DESIGN.md), and [the
contract](references/contribution-review-contract.md). The JSON input is an
illustrative fixture, not a current repository observation.
