import { Router } from 'express';
import { config } from '../config';
import { getCached, setCached } from '../lib/cache';
import {
  getRelease,
  getRefreshState,
  isOpenFeltSeriousIssue,
  issuesForVersion,
  listReleasesDb,
  openedDuringReign,
} from '../lib/refresh';
import { listAdvisories, rawIssueCountForVersion, rawIssuesForVersion, type AdvisoryRow, type IssueRow } from '../lib/db';
import { matchesRange, firstPatchedVersion, stableDistance } from '../lib/versionMatch';
import { bandFor, type InstallStatus } from '../lib/score';
import { surfaceOf } from '../lib/surfaces';
import { applyLabelOverrides, applyTitleFunctionalityHint } from '../lib/labelOverrides';
import { SCORE_HISTORY_CHART_LIMIT } from '../lib/historyWindow';
import type { IssueClassification } from '../lib/llm';

export const api = Router();

// How many stables after a version we still count its CVEs for the BADGE. 0 =
// only CVEs patched in the very next stable — i.e. "this version's own disclosed
// vulnerabilities". This deliberately differs from the cumulative `< X` match:
// GitHub ranges have no lower bound, so the raw count grows with age (the oldest
// release showed "42 CVE", which looks alarming and falsely flatters the newest).
// The windowed count is age-fair (reflects how leaky THIS version was, not how old
// it is) and matches what the decayed score actually weighs. NOTE: this is display
// only — the skip-cve STATUS still trips on ANY medium+ match (security ≠ decay).
const CVE_BADGE_WINDOW = 0;

// Cross-reference each release tag against cached advisories. `affected` = CVEs in
// this version's own window (see CVE_BADGE_WINDOW); `patched` = CVEs whose fix first
// shipped in this exact release. A release that's merely "newer than the patch" is
// NOT credited as patching.
function advisoryStatusFor(tag: string, all: AdvisoryRow[], stableTags: string[]) {
  const norm = tag.replace(/^v/i, '');
  const affected: AdvisoryRow[] = [];
  const patched: AdvisoryRow[] = [];
  for (const a of all) {
    if (
      matchesRange(tag, a.vulnerable_version_range) &&
      stableDistance(tag, a.patched_versions, stableTags) <= CVE_BADGE_WINDOW
    ) {
      affected.push(a);
    }
    const first = firstPatchedVersion(a.patched_versions);
    if (first && (first === tag || first.replace(/^v/i, '') === norm)) patched.push(a);
  }
  return { affected, patched };
}

// Parse the stored broken-surfaces JSON (see lib/surfaces.ts) defensively.
function parseBrokenSurfaces(json: string | null): Array<{ label: string; icon: string; count: number }> {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function summarizeAdvisories(list: AdvisoryRow[]) {
  const by = { critical: 0, high: 0, medium: 0, low: 0 } as Record<string, number>;
  for (const a of list) by[a.severity] = (by[a.severity] ?? 0) + 1;
  return {
    total: list.length,
    bySeverity: by,
    items: list.map((a) => ({
      ghsaId: a.ghsa_id,
      cveId: a.cve_id,
      severity: a.severity,
      summary: a.summary,
      url: a.html_url,
      patchedVersion: firstPatchedVersion(a.patched_versions),
    })),
  };
}

api.get('/health', (_req, res) => {
  res.json({ ok: true, repo: `${config.github.owner}/${config.github.repo}` });
});

// UI config — lets the frontend respect server-side limits without hardcoding.
api.get('/config', (_req, res) => {
  res.json({
    releases: config.limits.releases,
    refreshMinutes: config.refresh.intervalMinutes,
  });
});

api.get('/status', (_req, res) => {
  res.json(getRefreshState());
});

// Maintainer-signal counts mined from the release-notes body + neighbouring releases.
// See lib/releaseNotes.ts. These are exposed for the UI to render without further
// computation, but the UI is intentionally NOT consuming them yet — we want to watch
// the numbers settle across a few refresh cycles before deciding how to surface them.
//
// `breakingCount` semantics: for a stable release, this is the AGGREGATE of its
// own `### Breaking` bullets plus those in every beta in the chain back to the
// previous stable. The maintainer typically lists a breaking change in the beta
// that introduced it and does NOT repeat the bullet when the stable promotes —
// so the stable's own body alone undercounts breakage that ships in it. See
// `computeAggregateBreaking` in lib/releaseNotes.ts. `fixesCount` / `changesCount`
// stay own-only because changelog generators DO re-list those at promotion.
function maintainerSignals(r: {
  breaking_count: number;
  fixes_count: number;
  changes_count: number;
  highlights_count: number;
  pr_refs_count: number;
  beta_count: number;
  hours_to_next_release: number | null;
  hours_to_next_stable: number | null;
}) {
  return {
    breakingCount:      r.breaking_count,
    fixesCount:         r.fixes_count,
    changesCount:       r.changes_count,
    highlightsCount:    r.highlights_count,
    prRefsCount:        r.pr_refs_count,
    betaCount:          r.beta_count,
    hoursToNextRelease: r.hours_to_next_release,
    hoursToNextStable:  r.hours_to_next_stable,
  };
}

api.get('/releases', (_req, res) => {
  const rows = listReleasesDb(config.limits.releases);
  const advisories = listAdvisories();
  const stableTags = rows.map((r) => r.tag); // newest-first; used for CVE recency window
  res.json(
    rows.map((r) => {
      const status = advisoryStatusFor(r.tag, advisories, stableTags);
      return {
        tag: r.tag,
        name: r.name,
        publishedAt: r.published_at,
        htmlUrl: r.html_url,
        finalScore: r.final_score,                 // Install Confidence 0–10 (null when 'wait')
        band: bandFor(r.final_score, (r.state ?? 'eligible') as InstallStatus),
        status: r.state,                           // wait | skip-cve | skip-hotfix | eligible
        recommended: r.recommended === 1,
        reason: r.score_reason,
        brokenSurfaces: parseBrokenSurfaces(r.broken_surfaces),
        negativeIssues: r.negative_issues,
        positiveIssues: r.positive_issues,
        closedSeriousFixed: r.closed_serious_fixed,
        openedSeriousDuringReign: r.opened_serious_during_reign,
        scoredAt: r.scored_at,
        advisories: {
          affected: summarizeAdvisories(status.affected),
          patched: summarizeAdvisories(status.patched),
        },
        maintainerSignals: maintainerSignals(r),
      };
    }),
  );
});

api.get('/releases/history', (_req, res) => {
  const rows = listReleasesDb(SCORE_HISTORY_CHART_LIMIT);
  res.json(
    rows.map((r) => ({
      tag: r.tag,
      publishedAt: r.published_at,
      finalScore: r.final_score,
    })),
  );
});

// ── Public API ────────────────────────────────────────────────────────────────
// Single endpoint answering "which stable should I install right now?".
//
// score:       Install Confidence 0–10 (higher = safer to install). null when 'wait'.
// band:        solid | ok | caution | weak | skip | wait
// status:      eligible | skip-cve | skip-hotfix | wait
// recommended: true for the single newest release that passed all gates and scores
//              at or above the recommendation threshold.
// reason:      short human explanation of the verdict.
// sentiment / severity / scope / hasWorkaround / confidence: per-issue LLM context.
//
// The score is NOT issue-volume based (that is confounded by how long/popular a
// release was). It comes from age/cadence-invariant signals: known CVEs, settle
// age, hotfix succession, stable-to-stable survival, beta shakeout depth, and the
// serious-bug close/open balance during the release's reign. See lib/score.ts.
//
// Data refreshes on a configurable interval (REFRESH_MINUTES). scoredAt = last time
// the score was computed for this specific release.

// Under window-based attribution one issue often affects multiple releases, so
// returning every attributed issue per release inflates the payload (we observed
// 5 MB for openclaw with ~1100 negs × 10 releases). For the public-API surface
// we cap to the most relevant issues per release: negatives first, sorted by
// severity, then positives.
const PUBLIC_ISSUES_PER_RELEASE = 25;
const UPGRADE_PATH_ITEMS_PER_BUCKET = 25;
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SENTIMENT_RANK: Record<string, number> = { negative: 0, positive: 1, neutral: 2 };

type PublicIssueRow = ReturnType<typeof issuesForVersion>[number];
type UpgradeIssueRow = PublicIssueRow;

function parseIssueLabels(labels: string): string[] {
  try {
    const parsed = JSON.parse(labels);
    return Array.isArray(parsed)
      ? parsed.map((label) => String(label)).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function baselineRawClassification(issue: IssueRow, labels: string[]): IssueClassification {
  const title = issue.title.toLowerCase();
  const isNeutral = labels.includes('enhancement')
    || labels.includes('stale')
    || labels.includes('clawsweeper:not-repro-on-main')
    || title.includes('feature request')
    || title.includes('[feature]');
  let severity: IssueClassification['severity'] = 'medium';
  if (labels.includes('P0') || labels.includes('beta-blocker') || labels.includes('impact:data-loss')) {
    severity = 'critical';
  } else if (labels.includes('P1') || labels.includes('regression') || /\bcrash|panic|data loss|message loss|auth\b/i.test(issue.title)) {
    severity = 'high';
  } else if (labels.includes('P3')) {
    severity = 'low';
  }
  return {
    sentiment: isNeutral ? 'neutral' : 'negative',
    severity,
    scope: 'moderate',
    functionality: 'core',
    affectedUsers: 'unknown',
    workaroundStatus: 'unknown',
    duplicateCluster: null,
    affectsVersion: null,
    confidence: 0.45,
    rationale: 'Raw unclassified issue row; timing and surface inferred from title/labels.',
  };
}

function rawIssueForUpgrade(issue: IssueRow): UpgradeIssueRow {
  const labels = parseIssueLabels(issue.labels);
  const base = baselineRawClassification(issue, labels);
  const classification = applyTitleFunctionalityHint(applyLabelOverrides(base, labels), issue.title);
  return {
    ...issue,
    issue_number: issue.number,
    sentiment: classification.sentiment,
    severity: classification.severity,
    scope: classification.scope,
    functionality: classification.functionality,
    affected_users: classification.affectedUsers,
    has_workaround: classification.workaroundStatus === 'confirmed' ? 1 : 0,
    workaround_status: classification.workaroundStatus,
    duplicate_cluster: classification.duplicateCluster,
    affects_version: classification.affectsVersion,
    confidence: classification.confidence,
    rationale: classification.rationale,
    classified_at: '',
    classified_updated_at: issue.updated_at,
    prompt_version: 0,
  };
}

function issueSummary(i: UpgradeIssueRow) {
  const surface = surfaceOf(i.title);
  return {
    number:        i.number,
    title:         i.title,
    url:           i.html_url,
    state:         i.state,
    createdAt:     i.created_at,
    closedAt:      i.closed_at,
    surface:       surface ? { label: surface.label, icon: surface.icon } : null,
    sentiment:     i.sentiment,
    severity:      i.severity,
    scope:         i.scope,
    hasWorkaround: i.has_workaround === 1,
    confidence:    i.confidence,
    rationale:     i.rationale,
  };
}

function sortIssueRows(rows: UpgradeIssueRow[]) {
  return [...rows].sort((a, b) => {
    const s = (SENTIMENT_RANK[a.sentiment] ?? 9) - (SENTIMENT_RANK[b.sentiment] ?? 9);
    if (s !== 0) return s;
    return (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
  });
}

function issueIdentity(issue: UpgradeIssueRow) {
  return `#${issue.number}`;
}

function issueSurfaceLabel(issue: UpgradeIssueRow): string {
  return surfaceOf(issue.title)?.label.trim() ?? '';
}

function parseProfileSurfaces(value: unknown): Set<string> {
  if (typeof value !== 'string') return new Set();
  return new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
}

function upgradeIssueRelevant(issue: UpgradeIssueRow, selectedSurfaces: Set<string>): boolean {
  if (issue.sentiment === 'positive' || issue.sentiment === 'neutral') return false;
  const surface = issueSurfaceLabel(issue);
  if (!selectedSurfaces.size) return true;
  return !surface || selectedSurfaces.has(surface);
}

function bucketItems(rows: UpgradeIssueRow[]) {
  const sorted = sortIssueRows(rows);
  return {
    total: sorted.length,
    items: sorted.slice(0, UPGRADE_PATH_ITEMS_PER_BUCKET).map(issueSummary),
  };
}

function buildPublicPayload() {
  const { lastRefreshAt } = getRefreshState();
  // Only the focused window (config.limits.releases, default 10) carries full
  // evidence + My-install scoring. The chart still plots SCORE_HISTORY_CHART_LIMIT
  // (20) points, but releases 11–20 are frozen rows from past runs: on the client
  // they have no /public detail, so My-install falls back to their stored global
  // score — comparative trend context only, not re-filtered per profile.
  const allReleases = listReleasesDb(config.limits.releases);

  const releases = allReleases.map((r) => {
    const all = issuesForVersion(r.tag);
    const sorted = sortIssueRows(all);
    const topIssues = sorted.slice(0, PUBLIC_ISSUES_PER_RELEASE).map(issueSummary);
    const watchIssues = openedDuringReign(r.tag)
      .filter(isOpenFeltSeriousIssue)
      .map(issueSummary);

    return {
      tag:               r.tag,
      publishedAt:       r.published_at,
      url:               r.html_url,
      score:             r.final_score,
      band:              bandFor(r.final_score, (r.state ?? 'eligible') as InstallStatus),
      status:            r.state,
      recommended:       r.recommended === 1,
      reason:            r.score_reason,
      negativeIssues:    r.negative_issues ?? 0,
      positiveIssues:    r.positive_issues ?? 0,
      scoredAt:          r.scored_at,
      totalAttributedIssues: all.length,
      issues:            topIssues,
      watchIssues,
    };
  });

  return {
    repo:      `${config.github.owner}/${config.github.repo}`,
    updatedAt: lastRefreshAt,
    releases,
  };
}

api.get('/public', (_req, res) => {
  const hit = getCached();
  if (hit) { res.json(hit); return; }
  const data = buildPublicPayload();
  setCached(data);
  res.json(data);
});

api.get('/upgrade-path', (req, res) => {
  const currentTag = typeof req.query.current === 'string' ? req.query.current : '';
  const targetTag = typeof req.query.target === 'string' ? req.query.target : '';
  if (!currentTag || !targetTag) {
    res.status(400).json({ error: 'current and target query parameters are required' });
    return;
  }

  const current = getRelease(currentTag);
  const target = getRelease(targetTag);
  if (!current || !target) {
    res.status(404).json({ error: 'current or target release not found' });
    return;
  }
  if (current.tag === target.tag) {
    res.json({ state: 'same', current: current.tag, target: target.tag });
    return;
  }

  const currentPublished = Date.parse(current.published_at ?? '');
  const targetPublished = Date.parse(target.published_at ?? '');
  if (!Number.isFinite(currentPublished) || !Number.isFinite(targetPublished)) {
    res.json({ state: 'unclear-dates', current: current.tag, target: target.tag });
    return;
  }
  if (targetPublished <= currentPublished) {
    res.json({ state: 'not-newer', current: current.tag, target: target.tag });
    return;
  }

  const selectedSurfaces = parseProfileSurfaces(req.query.surfaces);
  const currentRawIssueCount = rawIssueCountForVersion(current.tag);
  const targetRawIssueCount = rawIssueCountForVersion(target.tag);
  const currentClassifiedIssues = issuesForVersion(current.tag);
  const targetClassifiedIssues = issuesForVersion(target.tag);
  const classifiedCoverageLimited = currentClassifiedIssues.length < currentRawIssueCount
    || targetClassifiedIssues.length < targetRawIssueCount;
  const useRawFallback = classifiedCoverageLimited
    && currentClassifiedIssues.length === 0
    && targetClassifiedIssues.length === 0
    && (currentRawIssueCount > 0 || targetRawIssueCount > 0);
  const currentAllIssues = useRawFallback
    ? rawIssuesForVersion(current.tag).map(rawIssueForUpgrade)
    : currentClassifiedIssues;
  const targetAllIssues = useRawFallback
    ? rawIssuesForVersion(target.tag).map(rawIssueForUpgrade)
    : targetClassifiedIssues;
  const currentIssues = currentAllIssues.filter((i) => upgradeIssueRelevant(i, selectedSurfaces));
  const targetIssues = targetAllIssues.filter((i) => upgradeIssueRelevant(i, selectedSurfaces));
  const currentById = new Map(currentIssues.map((issue) => [issueIdentity(issue), issue]));
  const targetById = new Map(targetIssues.map((issue) => [issueIdentity(issue), issue]));

  const newRisks: PublicIssueRow[] = [];
  const fixedByUpgrade: PublicIssueRow[] = [];
  const stillPresent: PublicIssueRow[] = [];
  const possibleFixes: PublicIssueRow[] = [];
  const unclear: PublicIssueRow[] = [];

  for (const issue of targetIssues) {
    const id = issueIdentity(issue);
    if (currentById.has(id)) {
      stillPresent.push(issue);
      continue;
    }
    const created = Date.parse(issue.created_at);
    if (!Number.isFinite(created) || created >= currentPublished) newRisks.push(issue);
    else unclear.push(issue);
  }

  for (const issue of currentIssues) {
    const id = issueIdentity(issue);
    if (targetById.has(id)) continue;
    const closed = Date.parse(issue.closed_at ?? '');
    if (Number.isFinite(closed) && closed <= targetPublished) fixedByUpgrade.push(issue);
    else if (issue.state === 'closed') possibleFixes.push(issue);
    else unclear.push(issue);
  }

  res.json({
    state: 'ready',
    source: useRawFallback ? 'raw-unclassified-attribution' : 'server-classified-attribution',
    current: {
      tag: current.tag,
      publishedAt: current.published_at,
      relevantIssueCount: currentIssues.length,
      classifiedIssueCount: currentClassifiedIssues.length,
      rawIssueCount: currentRawIssueCount,
    },
    target: {
      tag: target.tag,
      publishedAt: target.published_at,
      relevantIssueCount: targetIssues.length,
      classifiedIssueCount: targetClassifiedIssues.length,
      rawIssueCount: targetRawIssueCount,
    },
    selectedSurfaces: [...selectedSurfaces],
    itemLimit: UPGRADE_PATH_ITEMS_PER_BUCKET,
    evidenceLimited: classifiedCoverageLimited,
    buckets: {
      newRisks: bucketItems(newRisks),
      fixedByUpgrade: bucketItems(fixedByUpgrade),
      possibleFixes: bucketItems(possibleFixes),
      stillPresent: bucketItems(stillPresent),
      unclear: bucketItems(unclear),
    },
  });
});
