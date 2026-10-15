#!/usr/bin/env python3
"""Compile supplied ECC contribution observations into a review packet."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path, PurePosixPath
from typing import Any

ROLES = {
    "canonical-skill", "install-manifest",
    "agents-mirror", "cursor-mirror",
    "codex-metadata", "unit-test",
}
HARNESSES = {"claude", "codex", "cursor"}
GATES = {
    "strict-skill-frontmatter", "install-manifests",
    "catalog-sync", "command-registry",
    "harness-adapters", "unicode-safety",
    "no-personal-paths", "test-and-coverage",
}
FAILURES = {
    "generated-root-as-canonical", "missing-manifest-entry",
    "harness-content-drift", "catalog-count-drift",
    "stale-command-registry", "missing-red-test",
    "coverage-regression", "secret-in-diff",
    "personal-path-in-diff", "unsafe-hook-permission",
    "breaking-change-unmarked", "commit-before-gates",
}
FAILURE_OUTCOMES: dict[Any, str] = {
    "generated-root-as-canonical": "reject", "missing-manifest-entry": "hold",
    "harness-content-drift": "hold", "catalog-count-drift": "hold",
    "stale-command-registry": "hold", "missing-red-test": "hold",
    "coverage-regression": "hold", "secret-in-diff": "reject",
    "personal-path-in-diff": "reject", "unsafe-hook-permission": "reject",
    "breaking-change-unmarked": "hold", "commit-before-gates": "reject",
}
RUNNERS = {
    "resolve-canonical-surface", "compile-change-plan",
    "run-red-green-refactor", "reconcile-harness-parity",
    "reconcile-catalog-and-manifests", "run-security-and-validation-gates",
    "prepare-commit-proposal",
}
AUTHORITY_FIELDS = {
    "mayWriteSourceFiles", "mayExecuteTests",
    "mayUpdateCatalog",
    "mayCommit",
    "mayPush",
    "mayOpenPullRequest",
    "mayWriteControlStore",
    "mayWriteCanonicalMemory",
    "maySemanticCommit",
}
EFFECT_FIELDS = {
    "sourceFileWriteRequested",
    "testExecutionRequested",
    "catalogWriteRequested",
    "commitRequested",
    "pushRequested",
    "pullRequestRequested",
    "controlStoreWriteRequested",
    "canonicalMemoryWriteRequested",
    "semanticCommitRequested",
}


def canonical(value: Any) -> Any:
    """Normalize a value for a deterministic, receipt-independent checksum."""
    if isinstance(value, dict):
        return {
            key: canonical(item)
            for key, item in sorted(value.items())
            if key not in {"artifactId", "semanticChecksum", "returnReceipt"}
        }
    if isinstance(value, list):
        return [canonical(item) for item in value]
    return value


def checksum(value: Any) -> str:
    encoded = json.dumps(
        canonical(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def is_sha256(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def is_finite_number(value: Any) -> bool:
    """Accept finite JSON numbers while excluding booleans."""
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value)


def reject_nonstandard_json_number(value: str) -> None:
    """Reject Python json's non-standard NaN and Infinity extensions."""
    raise ValueError(f"non-standard JSON number: {value}")


def safe_repo_path(value: Any) -> bool:
    """Accept normalized relative POSIX paths, rejecting home/drive/traversal refs."""
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        return False
    if value.startswith("~") or re.match(r"^[A-Za-z]:", value):
        return False
    if any(part in {"", ".", ".."} for part in value.split("/")):
        return False
    path = PurePosixPath(value)
    return not path.is_absolute() and path.as_posix() == value


def add_issue(issues: list[dict[str, Any]], code: str, plane: int, detail: str) -> None:
    if code not in {issue["code"] for issue in issues}:
        issues.append({"code": code, "plane": plane, "detail": detail})


def _validate(observation: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    faults: list[dict[str, Any]] = []
    contradictions: list[dict[str, Any]] = []
    required = {
        "schemaVersion", "observedAt", "subjectRef", "repoIdentity", "changeIntent",
        "surfaceContract", "artifactRecords", "harnessParity", "catalogContract",
        "validationMatrix", "tddContract", "securityContract", "budgetContract",
        "commitContract", "failureProbes", "checkpointContract", "runnerProposals",
        "claimsSourceFilesWrittenByController", "claimsTestsExecutedByController",
        "claimsCatalogUpdatedByController", "claimsCommitCreated", "claimsPushPerformed",
        "claimsPullRequestOpened", "requestedEffects", "claimedAuthority",
    }
    if not isinstance(observation, dict) or not required.issubset(observation):
        add_issue(faults, "observation_envelope_incomplete", 1,
                  "Required ECC contribution observations are missing.")
        return faults, contradictions

    map_fields = (
        "repoIdentity", "changeIntent", "surfaceContract", "harnessParity",
        "catalogContract", "tddContract", "securityContract", "budgetContract",
        "commitContract", "checkpointContract", "requestedEffects", "claimedAuthority",
    )
    list_fields = ("artifactRecords", "validationMatrix", "failureProbes", "runnerProposals")
    if any(not isinstance(observation[field], dict) for field in map_fields) or any(
        not isinstance(observation[field], list) for field in list_fields
    ):
        add_issue(faults, "observation_shape_invalid", 1,
                  "Declared maps and arrays must retain their documented shapes.")
        return faults, contradictions

    repo = observation["repoIdentity"]
    repo_fields = {
        "rootName", "rootPathRef", "branch", "baseSha256", "headSha256",
        "packageLockSha256", "installModulesSha256", "installProfilesSha256",
        "installComponentsSha256", "catalogScriptSha256", "skillPolicySha256",
        "checkpointSha256",
    }
    if (
        set(repo) != repo_fields
        or repo.get("rootName") != "everything-claude-code"
        or repo.get("rootPathRef") != "active-checkout:everything-claude-code"
        or not isinstance(repo.get("branch"), str)
        or not repo.get("branch")
        or repo.get("branch") in {"main", "master"}
        or any(not is_sha256(repo.get(key)) for key in repo_fields if key.endswith("Sha256"))
        or repo.get("baseSha256") == repo.get("headSha256")
    ):
        add_issue(faults, "repo_identity_failed", 2,
                  "Active ECC root, non-default branch, distinct base/head, manifests, catalog, policy, and checkpoint hashes are required.")

    intent = observation["changeIntent"]
    intent_fields = {
        "changeId", "changeKind", "canonicalSurface", "canonicalPath",
        "legacyCommandShimRequired", "breakingChange", "owner", "scopes",
        "evidenceRefs", "counterevidenceRefs",
    }
    scopes = intent.get("scopes")
    if (
        set(intent) != intent_fields
        or not isinstance(intent.get("changeId"), str)
        or not intent.get("changeId")
        or intent.get("changeKind") not in {"skill", "agent", "command", "hook", "rule", "script"}
        or intent.get("canonicalSurface") != "skills"
        or not safe_repo_path(intent.get("canonicalPath"))
        or not intent.get("canonicalPath", "").startswith("skills/")
        or intent.get("legacyCommandShimRequired") is not False
        or intent.get("breakingChange") is not False
        or intent.get("owner") != "ECC"
        or not isinstance(scopes, list)
        or set(scopes) != {"skills", "tests", "manifests", "cross-harness"}
        or not isinstance(intent.get("evidenceRefs"), list)
        or not intent.get("evidenceRefs")
        or not isinstance(intent.get("counterevidenceRefs"), list)
    ):
        add_issue(faults, "change_intent_failed", 1,
                  "A bounded non-breaking skills-first change with explicit scopes and evidence refs is required.")

    surface = observation["surfaceContract"]
    surface_fields = {
        "canonicalFirst", "generatedRootsExcluded", "curatedSkill",
        "installManifestUpdated", "commandShimAdded", "provenanceRequired",
        "mirrorTargets", "docsUpdateRequired", "evidenceRefs", "counterevidenceRefs",
    }
    mirror_targets = surface.get("mirrorTargets")
    if (
        set(surface) != surface_fields
        or surface.get("canonicalFirst") is not True
        or surface.get("generatedRootsExcluded") is not True
        or surface.get("curatedSkill") is not True
        or surface.get("installManifestUpdated") is not True
        or surface.get("commandShimAdded") is not False
        or surface.get("provenanceRequired") is not False
        or not isinstance(mirror_targets, list)
        or set(mirror_targets) != {"agents", "cursor"}
        or surface.get("docsUpdateRequired") is not True
        or not isinstance(surface.get("evidenceRefs"), list)
        or not surface.get("evidenceRefs")
    ):
        add_issue(faults, "canonical_surface_failed", 6,
                  "Curated skills/ must lead; generated roots must be excluded; manifest, docs, and intentional mirrors are required.")

    artifacts = observation["artifactRecords"]
    artifact_fields = {
        "path", "role", "sha256", "exists", "sourceOfTruth", "generated",
        "contentIdentitySha256", "evidenceRefs",
    }
    artifact_paths: list[Any] = []
    artifact_bad = False
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            artifact_bad = True
            continue
        artifact_paths.append(artifact.get("path"))
        source_of_truth = artifact.get("role") == "canonical-skill"
        if (
            set(artifact) != artifact_fields
            or not safe_repo_path(artifact.get("path"))
            or artifact.get("role") not in ROLES
            or not is_sha256(artifact.get("sha256"))
            or artifact.get("exists") is not True
            or artifact.get("sourceOfTruth") is not source_of_truth
            or artifact.get("generated") is not False
            or not is_sha256(artifact.get("contentIdentitySha256"))
            or not isinstance(artifact.get("evidenceRefs"), list)
            or not artifact.get("evidenceRefs")
        ):
            artifact_bad = True
    canonical_artifacts = [
        item for item in artifacts
        if isinstance(item, dict) and item.get("role") == "canonical-skill"
    ]
    if (
        len(artifacts) != 6
        or {item.get("role") for item in artifacts if isinstance(item, dict)} != ROLES
        or len(artifact_paths) != len(set(artifact_paths))
        or len(canonical_artifacts) != 1
        or canonical_artifacts[0].get("path") != intent.get("canonicalPath")
        or artifact_bad
    ):
        add_issue(faults, "artifact_graph_failed", 2,
                  "Six unique, extant, hash-bound artifacts with one exact canonical source are required.")

    parity = observation["harnessParity"]
    parity_fields = {
        "canonicalContentSha256", "targets", "parityPassed", "driftIds",
        "evidenceRefs", "counterevidenceRefs",
    }
    target_fields = {
        "harness", "path", "contentIdentitySha256", "frontmatterAdapted",
        "metadataPresent", "evidenceRefs",
    }
    targets = parity.get("targets", [])
    canonical_content = parity.get("canonicalContentSha256")
    artifact_by_path = {
        item.get("path"): item
        for item in artifacts
        if isinstance(item, dict)
    }
    expected_roles: dict[Any, str] = {
        "claude": "canonical-skill",
        "codex": "agents-mirror",
        "cursor": "cursor-mirror",
    }
    parity_artifacts_bad = any(
        not isinstance(item, dict)
        or item.get("path") not in artifact_by_path
        or artifact_by_path[item.get("path")].get("role") != expected_roles.get(item.get("harness"))
        or artifact_by_path[item.get("path")].get("contentIdentitySha256")
        != item.get("contentIdentitySha256")
        for item in targets
    ) if isinstance(targets, list) else True
    if (
        set(parity) != parity_fields
        or not is_sha256(canonical_content)
        or not isinstance(targets, list)
        or len(targets) != 3
        or {item.get("harness") for item in targets if isinstance(item, dict)} != HARNESSES
        or any(
            not isinstance(item, dict)
            or set(item) != target_fields
            or not safe_repo_path(item.get("path"))
            or item.get("contentIdentitySha256") != canonical_content
            or not isinstance(item.get("frontmatterAdapted"), bool)
            or item.get("metadataPresent") is not True
            or not isinstance(item.get("evidenceRefs"), list)
            or not item.get("evidenceRefs")
            for item in targets
        )
        or parity.get("parityPassed") is not True
        or parity.get("driftIds") != []
        or not isinstance(parity.get("evidenceRefs"), list)
        or not parity.get("evidenceRefs")
        or parity_artifacts_bad
    ):
        add_issue(faults, "harness_parity_failed", 3,
                  "Claude, Codex, and Cursor surfaces must retain normalized content identity with explicit adaptations and no drift.")

    catalog = observation["catalogContract"]
    catalog_fields = {
        "filesystemAgents", "documentedAgents", "filesystemSkills", "documentedSkills",
        "filesystemCommands", "documentedCommands", "installModuleCount",
        "curatedSkillsReferenced", "intentionallyUnshippedSkills", "catalogCheckPassed",
        "commandRegistryCheckPassed", "manifestValidationPassed", "countsReconciled",
        "evidenceRefs", "counterevidenceRefs",
    }
    count_pairs = (
        ("filesystemAgents", "documentedAgents"),
        ("filesystemSkills", "documentedSkills"),
        ("filesystemCommands", "documentedCommands"),
    )
    counts_valid = all(
        isinstance(catalog.get(left), int)
        and not isinstance(catalog.get(left), bool)
        and catalog.get(left) > 0
        and catalog.get(left) == catalog.get(right)
        for left, right in count_pairs
    )
    skills_valid = all(
        isinstance(catalog.get(key), int) and not isinstance(catalog.get(key), bool)
        for key in ("curatedSkillsReferenced", "intentionallyUnshippedSkills", "filesystemSkills")
    )
    if (
        set(catalog) != catalog_fields
        or not counts_valid
        or not isinstance(catalog.get("installModuleCount"), int)
        or isinstance(catalog.get("installModuleCount"), bool)
        or catalog.get("installModuleCount", 0) <= 0
        or not skills_valid
        or catalog.get("curatedSkillsReferenced", 0) + catalog.get("intentionallyUnshippedSkills", 0) != catalog.get("filesystemSkills")
        or any(catalog.get(key) is not True for key in (
            "catalogCheckPassed", "commandRegistryCheckPassed", "manifestValidationPassed", "countsReconciled"
        ))
        or not isinstance(catalog.get("evidenceRefs"), list)
        or not catalog.get("evidenceRefs")
    ):
        add_issue(faults, "catalog_reconciliation_failed", 3,
                  "Filesystem/documented counts, manifest coverage, intentional exceptions, catalog, and registry checks must reconcile.")

    validation = observation["validationMatrix"]
    validation_fields = {"gateId", "commandArgv", "expectedExit", "observedExit", "evidenceRefs"}
    if (
        len(validation) != 8
        or {item.get("gateId") for item in validation if isinstance(item, dict)} != GATES
        or any(
            not isinstance(item, dict)
            or set(item) != validation_fields
            or not isinstance(item.get("commandArgv"), list)
            or not item.get("commandArgv")
            or not all(isinstance(arg, str) and arg for arg in item.get("commandArgv", []))
            or item.get("expectedExit") != 0
            or item.get("observedExit") != 0
            or not isinstance(item.get("evidenceRefs"), list)
            or not item.get("evidenceRefs")
            for item in validation
        )
    ):
        add_issue(faults, "validation_matrix_failed", 5,
                  "Eight exact argv gates must be recorded green with evidence references.")

    tdd = observation["tddContract"]
    tdd_fields = {
        "redObserved", "failingTestIds", "greenObserved", "refactorObserved",
        "coverageThresholdPercent", "lineCoveragePercent", "functionCoveragePercent",
        "branchCoveragePercent", "statementCoveragePercent", "newBehaviorTestCount",
        "allTestsPass", "evidenceRefs", "counterevidenceRefs",
    }
    coverage_fields = (
        "lineCoveragePercent", "functionCoveragePercent", "branchCoveragePercent",
        "statementCoveragePercent",
    )
    if (
        set(tdd) != tdd_fields
        or any(tdd.get(key) is not True for key in ("redObserved", "greenObserved", "refactorObserved", "allTestsPass"))
        or not isinstance(tdd.get("failingTestIds"), list)
        or not tdd.get("failingTestIds")
        or tdd.get("coverageThresholdPercent") != 80
        or any(not is_finite_number(tdd.get(key)) or tdd.get(key) < 80 for key in coverage_fields)
        or not isinstance(tdd.get("newBehaviorTestCount"), int)
        or isinstance(tdd.get("newBehaviorTestCount"), bool)
        or tdd.get("newBehaviorTestCount", 0) < 3
        or not isinstance(tdd.get("evidenceRefs"), list)
        or not tdd.get("evidenceRefs")
    ):
        add_issue(faults, "tdd_contract_failed", 4,
                  "Observed RED/GREEN/REFACTOR, named failures, passing behavior tests, and at least 80 percent coverage are required.")

    security = observation["securityContract"]
    security_fields = {
        "secretsDetected", "personalPathsDetected", "unsafePermissionsDetected",
        "hookChangesReviewed", "promptInjectionBoundaryReviewed", "supplyChainChangesReviewed",
        "untrustedContentCannotGrantAuthority", "evidenceRefs", "counterevidenceRefs",
    }
    if (
        set(security) != security_fields
        or any(security.get(key) is not False for key in (
            "secretsDetected", "personalPathsDetected", "unsafePermissionsDetected"
        ))
        or any(security.get(key) is not True for key in (
            "hookChangesReviewed", "promptInjectionBoundaryReviewed",
            "supplyChainChangesReviewed", "untrustedContentCannotGrantAuthority"
        ))
        or not isinstance(security.get("evidenceRefs"), list)
        or not security.get("evidenceRefs")
    ):
        add_issue(faults, "security_contract_failed", 6,
                  "Secret, path, permission, hook, prompt-injection, supply-chain, and authority observations are required.")

    budget = observation["budgetContract"]
    budget_fields = {
        "maximumChangedFiles", "observedChangedFiles", "maximumChangedLines",
        "observedChangedLines", "maximumTestRuntimeSeconds", "observedTestRuntimeSeconds",
        "evidenceRefs",
    }
    budget_pairs = (
        ("observedChangedFiles", "maximumChangedFiles"),
        ("observedChangedLines", "maximumChangedLines"),
        ("observedTestRuntimeSeconds", "maximumTestRuntimeSeconds"),
    )
    if (
        set(budget) != budget_fields
        or any(
            not is_finite_number(budget.get(actual))
            or not is_finite_number(budget.get(limit))
            or budget.get(actual) < 0
            or budget.get(actual) > budget.get(limit)
            for actual, limit in budget_pairs
        )
        or not isinstance(budget.get("evidenceRefs"), list)
        or not budget.get("evidenceRefs")
    ):
        add_issue(faults, "change_budget_failed", 6,
                  "Changed-file, changed-line, and test-runtime budgets must be nonnegative and bounded.")

    commit = observation["commitContract"]
    commit_fields = {
        "type", "scope", "subject", "subjectLength", "conventional", "commitCreated",
        "pushPerformed", "pullRequestOpened", "evidenceRefs", "counterevidenceRefs",
    }
    subject = commit.get("subject")
    if (
        set(commit) != commit_fields
        or commit.get("type") not in {"feat", "fix", "refactor", "docs", "test", "chore", "perf", "ci"}
        or commit.get("scope") != "skills"
        or not isinstance(subject, str)
        or not subject
        or commit.get("subjectLength") != len(subject)
        or len(subject) > 72
        or commit.get("conventional") is not True
        or any(commit.get(key) is not False for key in ("commitCreated", "pushPerformed", "pullRequestOpened"))
        or not isinstance(commit.get("evidenceRefs"), list)
        or not commit.get("evidenceRefs")
    ):
        add_issue(faults, "commit_contract_failed", 6,
                  "A concise conventional commit proposal is required; commit, push, and PR effects must remain false.")

    probes = observation["failureProbes"]
    probe_fields = {"probeId", "failureMode", "expectedOutcome", "observedOutcome", "evidenceRefs"}
    if (
        len(probes) != 12
        or {item.get("failureMode") for item in probes if isinstance(item, dict)} != FAILURES
        or len({item.get("probeId") for item in probes if isinstance(item, dict)}) != 12
        or any(
            not isinstance(item, dict)
            or set(item) != probe_fields
            or item.get("expectedOutcome") != FAILURE_OUTCOMES.get(item.get("failureMode"))
            or item.get("observedOutcome") != item.get("expectedOutcome")
            or not isinstance(item.get("evidenceRefs"), list)
            or not item.get("evidenceRefs")
            for item in probes
        )
    ):
        add_issue(faults, "failure_probe_coverage_failed", 5,
                  "All twelve ECC contribution probes must match expected outcomes and cite evidence.")

    checkpoint = observation["checkpointContract"]
    checkpoint_fields = {
        "checkpointSha256", "repoHeadSha256", "policySha256", "lastDecisionId",
        "plannedRunnerCount", "statePathRef", "remainingUnknowns",
    }
    if (
        set(checkpoint) != checkpoint_fields
        or checkpoint.get("checkpointSha256") != repo.get("checkpointSha256")
        or checkpoint.get("repoHeadSha256") != repo.get("headSha256")
        or checkpoint.get("policySha256") != repo.get("skillPolicySha256")
        or not checkpoint.get("lastDecisionId")
        or checkpoint.get("plannedRunnerCount") != 7
        or not isinstance(checkpoint.get("statePathRef"), str)
        or not checkpoint.get("statePathRef", "").startswith(".memory-kit/")
        or not isinstance(checkpoint.get("remainingUnknowns"), list)
        or not checkpoint.get("remainingUnknowns")
    ):
        add_issue(faults, "checkpoint_contract_failed", 5,
                  "Exact repository, policy, checkpoint, runner, state, and unknown identities are required.")

    runners = observation["runnerProposals"]
    runner_fields = {"role", "argv"}
    if (
        len(runners) != 7
        or {item.get("role") for item in runners if isinstance(item, dict)} != RUNNERS
        or any(
            not isinstance(item, dict)
            or set(item) != runner_fields
            or not isinstance(item.get("argv"), list)
            or not item.get("argv")
            or not all(isinstance(arg, str) and arg for arg in item.get("argv", []))
            for item in runners
        )
    ):
        add_issue(faults, "runner_proposals_invalid", 5,
                  "Seven typed non-shell argv proposals are required.")

    forbidden_claims = (
        ("claimsSourceFilesWrittenByController", "file_write_claim_forbidden"),
        ("claimsTestsExecutedByController", "test_execution_claim_forbidden"),
        ("claimsCatalogUpdatedByController", "catalog_write_claim_forbidden"),
        ("claimsCommitCreated", "commit_claim_forbidden"),
        ("claimsPushPerformed", "push_claim_forbidden"),
        ("claimsPullRequestOpened", "pull_request_claim_forbidden"),
    )
    for field, code in forbidden_claims:
        if observation.get(field) is not False:
            contradictions.append({
                "code": code,
                "plane": 2,
                "detail": "The compiler cannot claim repository or external effects.",
            })
    requested_effects = observation["requestedEffects"]
    if set(requested_effects) != EFFECT_FIELDS or any(
        value is not False for value in requested_effects.values()
    ):
        contradictions.append({
            "code": "external_action_requested",
            "plane": 6,
            "detail": "Compilation cannot request source, test, catalog, Git, PR, or memory effects.",
        })
    claimed_authority = observation["claimedAuthority"]
    if set(claimed_authority) != AUTHORITY_FIELDS or any(
        value is not False for value in claimed_authority.values()
    ):
        contradictions.append({
            "code": "unsafe_generated_authority",
            "plane": 6,
            "detail": "Generated authority must remain false.",
        })
    return faults, contradictions


def validate(observation: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Validate an untrusted JSON value without letting malformed shapes crash the CLI."""
    try:
        return _validate(observation)
    except (AttributeError, TypeError, ValueError):
        fault = {
            "code": "observation_shape_invalid",
            "plane": 1,
            "detail": "Observation values must match the documented JSON types.",
        }
        return [fault], []


def compile_contract(
    observation: Any,
    source_path: Path,
    capsule_file_written: bool = False,
) -> dict[str, Any]:
    faults, contradictions = validate(observation)
    reasons = sorted({issue["code"] for issue in faults + contradictions})
    decision = "reject" if contradictions else "require_review"
    outcome = "reject" if decision == "reject" else "review_packet_compiled"
    data = observation if isinstance(observation, dict) else {}

    def mapping(field: str) -> dict[str, Any]:
        value = data.get(field, {})
        return value if isinstance(value, dict) else {}

    def sequence(field: str) -> list[Any]:
        value = data.get(field, [])
        return value if isinstance(value, list) else []

    artifacts = sequence("artifactRecords")
    validation = sequence("validationMatrix")
    change_intent = mapping("changeIntent")
    repo_identity = mapping("repoIdentity")
    checkpoint = mapping("checkpointContract")
    output_receipt: dict[str, Any] = {
        "sourceFilesWritten": False,
        "capsuleFileWritten": capsule_file_written,
        "testsExecuted": False,
        "catalogUpdated": False,
        "commitCreated": False,
        "pushPerformed": False,
        "pullRequestOpened": False,
        "controlStoreWritten": False,
        "canonicalMemoryWritten": False,
        "semanticCommitted": False,
    }
    artifact: dict[str, Any] = {
        "artifactType": "ecc-cross-harness-contribution-review-packet",
        "schemaVersion": "1.0.0",
        "artifactId": "ecc-contribution-review-packet",
        "generatedAt": data.get("observedAt"),
        "subjectRef": data.get("subjectRef"),
        "planeOwnership": {
            "primary": "meta-control",
            "supporting": [
                "observation-and-data",
                "epistemic-and-lineage",
                "state-and-relationship",
                "cognitive-control",
                "viability-and-policy",
            ],
        },
        "observationEnvelopes": [{
            "sourcePathRef": "observation-envelope",
            "repoIdentity": repo_identity,
            "changeIntent": change_intent,
            "surfaceContract": mapping("surfaceContract"),
        }],
        "authorityEnvelope": {key: False for key in sorted(AUTHORITY_FIELDS)},
        "policyEnvelope": {
            "proposalOnly": True,
            "canonicalFirst": True,
            "generatedRootsExcluded": True,
            "externalEffectsAllowed": False,
            "semanticCommitAllowed": False,
            "importedClaimsIndependentlyVerified": False,
        },
        "controllerDecision": {
            "decision": decision,
            "reasonCodes": reasons or ["imported_observations_require_independent_review"],
        },
        "contradictionScan": "computed",
        "contradictions": contradictions,
        "semanticPageFaults": faults,
        "counterevidence": (
            list(change_intent.get("counterevidenceRefs", []))
            if isinstance(change_intent.get("counterevidenceRefs"), list)
            else []
        ),
        "omissions": [
            "The compiler validates supplied claims but does not inspect the repository or referenced evidence.",
            "The compiler does not execute tests, update catalogs, commit, push, or open a pull request.",
            "A capsule file is written only to a new path explicitly supplied by the caller.",
        ],
        "residualUncertainty": (
            list(checkpoint.get("remainingUnknowns", []))
            if isinstance(checkpoint.get("remainingUnknowns"), list)
            else []
        ),
        "domainPayload": {
            "contributionOutcome": outcome,
            "assessmentBasis": "unverified imported claims; internal consistency only",
            "repoClaims": repo_identity,
            "changeClaims": change_intent,
            "surfaceClaims": mapping("surfaceContract"),
            "artifactClaims": artifacts,
            "harnessParityClaims": mapping("harnessParity"),
            "catalogClaims": mapping("catalogContract"),
            "validationClaims": validation,
            "tddClaims": mapping("tddContract"),
            "securityClaims": mapping("securityContract"),
            "budgetClaims": mapping("budgetContract"),
            "commitClaims": mapping("commitContract"),
            "failureProbeCoverage": {
                item.get("failureMode"): item.get("expectedOutcome") == item.get("observedOutcome")
                for item in sequence("failureProbes")
                if isinstance(item, dict)
            },
            "runnerProposals": [
                {**item, "executed": False, "requiresExternalAuthorization": True}
                for item in sequence("runnerProposals")
                if isinstance(item, dict)
            ],
            "contributionReceiptProposal": {
                "observationImported": True,
                **output_receipt,
            },
        },
        "unverifiedEvidenceClaims": {
            "verified": False,
            "basis": "imported observation envelope",
            "repoHeadSha256": repo_identity.get("headSha256"),
            "artifactPaths": [item.get("path") for item in artifacts if isinstance(item, dict)],
            "artifactSha256": [item.get("sha256") for item in artifacts if isinstance(item, dict)],
            "gateIds": [item.get("gateId") for item in validation if isinstance(item, dict)],
        },
        "epistemicLedger": [
            {"event": "repository_and_change_observation_imported", "status": "observed"},
            {"event": "canonical_surface_parity_catalog_and_tdd_evaluated", "status": "computed_from_claims"},
            {"event": "security_budget_and_commit_contract_evaluated", "status": "computed_from_claims"},
            {"event": "contribution_review_packet_compiled", "status": decision},
        ],
        "pccaPlanes": {
            "observation-and-data": {"artifactCount": len(artifacts)},
            "epistemic-and-lineage": {
                "sha256ShapedArtifactClaims": sum(
                    is_sha256(item.get("sha256")) for item in artifacts if isinstance(item, dict)
                )
            },
            "state-and-relationship": {
                "harnessTargetCount": len(mapping("harnessParity").get("targets", []))
                if isinstance(mapping("harnessParity").get("targets", []), list)
                else 0
            },
            "cognitive-control": {"validationGateCount": len(validation)},
            "meta-control": {"decision": decision},
            "viability-and-policy": {
                "faultCount": len(faults),
                "contradictionCount": len(contradictions),
            },
        },
        "memoryMetabolism": {
            "checkpointSha256": checkpoint.get("checkpointSha256"),
            "repoHeadSha256": repo_identity.get("headSha256"),
            "revalidateOn": [
                "HEAD drift",
                "policy or manifest change",
                "catalog regeneration",
                "harness adapter change",
                "test or coverage drift",
                "security finding",
                "review feedback",
            ],
            "supersessionRequired": True,
        },
        "returnReceipt": output_receipt,
    }
    artifact["semanticChecksum"] = checksum(artifact)
    artifact["returnReceipt"]["semanticChecksum"] = artifact["semanticChecksum"]
    return artifact


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("observation", type=Path, help="JSON observation envelope")
    parser.add_argument("--output", type=Path, help="write the generated capsule to this path")
    args = parser.parse_args()
    if args.output is not None and args.observation.resolve() == args.output.resolve():
        print("error: output path must not overwrite the observation envelope", file=sys.stderr)
        return 2
    try:
        observation = json.loads(
            args.observation.read_text(encoding="utf-8"),
            parse_constant=reject_nonstandard_json_number,
        )
    except (OSError, UnicodeError, ValueError, RecursionError) as error:
        print(f"error: cannot read observation JSON: {error}", file=sys.stderr)
        return 2

    capsule_written = args.output is not None
    try:
        packet = compile_contract(observation, args.observation, capsule_file_written=capsule_written)
        rendered = json.dumps(packet, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        rendered.encode("utf-8")
    except (UnicodeError, ValueError, RecursionError) as error:
        print(f"error: cannot compile observation JSON: {error}", file=sys.stderr)
        return 2
    if args.output is None:
        print(rendered, end="")
    else:
        try:
            with args.output.open("x", encoding="utf-8") as output_file:
                output_file.write(rendered)
        except FileExistsError:
            print("error: output path already exists; refusing to overwrite", file=sys.stderr)
            return 2
        except OSError as error:
            print(f"error: cannot write capsule output: {error}", file=sys.stderr)
            return 2
    return 0 if not packet["semanticPageFaults"] and not packet["contradictions"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
