#!/usr/bin/env node
/**
 * Audit recently closed issues whose closing rationale cites a PR that was
 * never actually merged.
 *
 * Motivated by #3223: an issue closed as "fixed in #N" while #N was closed
 * without merging leaves a completion claim that does not hold up. This audit
 * runs weekly from .github/workflows/maintenance.yml, scans issue bodies and
 * in-window comments for PR references, verifies each cited PR's merge state,
 * and reports findings to the workflow step summary.
 *
 * Read-only by design: findings are advisory, the script never comments on or
 * closes anything, and always exits 0 so the scheduled run never breaks.
 */

'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

const DEFAULT_WINDOW_DAYS = 30;

const REFERENCE_PATTERN =
  /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|address(?:es|ed)?|tracked|shipped|landed|delivered)\s+(?:by|in|via|with(?:in)?)\s+#(\d+)\b/gi;

function runGh(args, env) {
  return execFileSync('gh', args, { encoding: 'utf8', env, timeout: 60000 });
}

// Pure: PR numbers referenced by delivery claims in the given text.
function extractReferencedPrs(text) {
  const found = new Set();
  if (!text) return [];
  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    found.add(Number(match[1]));
  }
  return [...found];
}

// Pure: issues closed within the look-back window; PRs are not issues.
function selectRecentClosedIssues(issues, nowMs, windowDays) {
  const cutoff = nowMs - windowDays * 24 * 60 * 60 * 1000;
  return issues.filter(
    (issue) =>
      issue.state === 'closed' &&
      !issue.pull_request &&
      typeof issue.closed_at === 'string' &&
      Date.parse(issue.closed_at) >= cutoff
  );
}

// Pure: every comment body that belongs to the issue and falls inside the
// window. Non-string or foreign entries are skipped defensively.
function selectWindowComments(comments, issueClosedAt, windowDays, nowMs) {
  const cutoff = nowMs - windowDays * 24 * 60 * 60 * 1000;
  return comments
    .filter((comment) => typeof comment.body === 'string')
    .filter((comment) => Date.parse(comment.created_at) >= Math.max(cutoff, Date.parse(issueClosedAt) - 60_000))
    .map((comment) => comment.body);
}

// Pure: one verdict row per (issue, cited PR). merged===true passes; false or
// unknown (null) both fail, because an unverifiable claim is the failure mode.
function buildVerdicts(entries, prMergedById) {
  const rows = [];
  for (const entry of entries) {
    for (const pr of entry.referencedPrs) {
      const merged = prMergedById.get(pr);
      rows.push({ issue: entry.issue, pr, merged, ok: merged === true });
    }
  }
  return rows;
}

// Pure: markdown lines for the step summary.
function buildSummary(verdicts) {
  const lines = ['## Closed-issue reference audit', ''];
  if (!verdicts.length) {
    lines.push('No PR references found in recently closed issues.');
    return lines;
  }
  const unmerged = verdicts.filter((v) => !v.ok);
  lines.push(`${verdicts.length} delivery reference(s) checked; ${unmerged.length} cite an unmerged PR.`);
  lines.push('');
  for (const v of unmerged) {
    lines.push(`- #${v.issue} cites #${v.pr}: not merged (merge state: ${v.merged === false ? 'closed without merging' : 'unverifiable'})`);
  }
  if (!unmerged.length) lines.push('All cited PRs are merged.');
  return lines;
}

// Collect issues + their references. Comment API calls are capped by the
// window filter so a quiet month stays cheap.
function collectEntries(fetchIssues, fetchComments, nowMs, windowDays) {
  const recent = selectRecentClosedIssues(fetchIssues(), nowMs, windowDays);
  const entries = [];
  for (const issue of recent) {
    const texts = [issue.title, issue.body].filter(Boolean);
    const comments = fetchComments(issue.number, issue.closed_at);
    texts.push(...selectWindowComments(comments, issue.closed_at, windowDays, nowMs));
    entries.push({ issue: issue.number, referencedPrs: extractReferencedPrs(texts.join('\n')) });
  }
  return entries.filter((entry) => entry.referencedPrs.length);
}

function uniquePrNumbers(entries) {
  return [...new Set(entries.flatMap((entry) => entry.referencedPrs))];
}

function fetchMergedFlags(env, prNumbers) {
  const merged = new Map();
  for (const number of prNumbers) {
    try {
      const pr = JSON.parse(runGh(['api', `repos/${env.GITHUB_REPOSITORY}/pulls/${number}`], env));
      merged.set(number, pr.merged === true);
    } catch {
      merged.set(number, null); // nonexistent, moved, or API failure: unverifiable
    }
  }
  return merged;
}

function main() {
  const env = process.env;
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_STEP_SUMMARY) {
    console.error('audit-closed-references: requires GITHUB_REPOSITORY and GITHUB_STEP_SUMMARY');
    process.exitCode = 1;
    return;
  }
  const fetchIssues = () => JSON.parse(runGh(['api', `repos/${env.GITHUB_REPOSITORY}/issues?state=closed&sort=updated&direction=desc&per_page=100`], env));
  const fetchComments = (number, closedAt) => {
    try {
      return JSON.parse(runGh(['api', `repos/${env.GITHUB_REPOSITORY}/issues/${number}/comments?per_page=100`], env));
    } catch {
      return []; // comment fetch failure must not sink the audit
    }
  };
  const entries = collectEntries(fetchIssues, fetchComments, Date.now(), DEFAULT_WINDOW_DAYS);
  const merged = fetchMergedFlags(env, uniquePrNumbers(entries));
  const verdicts = buildVerdicts(entries, merged);
  const report = buildSummary(verdicts).join('\n');
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, report + '\n');
  console.log(report);
  // Advisory by design: findings land in the summary; the run stays green so
  // the weekly audit is never the thing that fails.
}

module.exports = {
  DEFAULT_WINDOW_DAYS,
  REFERENCE_PATTERN,
  extractReferencedPrs,
  selectRecentClosedIssues,
  selectWindowComments,
  buildVerdicts,
  buildSummary,
  collectEntries,
  uniquePrNumbers,
};

if (require.main === module) main();
