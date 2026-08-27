import { Router } from 'express';
import { config } from '../config';
import { getCached, setCached } from '../lib/cache';
import {
  getRefreshState,
  isOpenFeltSeriousIssue,
  issuesForVersion,
  listReleasesDb,
  openedDuringReign,
} from '../lib/refresh';
import { listAdvisories, type AdvisoryRow } from '../lib/db';
import { matchesRange, firstPatchedVersion, stableDistance } from '../lib/versionMatch';
import { bandFor, type InstallStatus } from '../lib/score';
import { surfaceOf } from '../lib/surfaces';
import { SCORE_HISTORY_CHART_LIMIT } from '../lib/historyWindow';

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
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SENTIMENT_RANK: Record<string, number> = { negative: 0, positive: 1, neutral: 2 };

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
    const sorted = [...all].sort((a, b) => {
      const s = (SENTIMENT_RANK[a.sentiment] ?? 9) - (SENTIMENT_RANK[b.sentiment] ?? 9);
      if (s !== 0) return s;
      return (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    });
    const issueSummary = (i: typeof sorted[number]) => ({
      number:        i.number,
      title:         i.title,
      url:           i.html_url,
      state:         i.state,
      closedAt:      i.closed_at,
      surface:       ((surface) => surface ? { label: surface.label, icon: surface.icon } : null)(surfaceOf(i.title)),
      sentiment:     i.sentiment,
      severity:      i.severity,
      scope:         i.scope,
      hasWorkaround: i.has_workaround === 1,
      confidence:    i.confidence,
      rationale:     i.rationale,
    });
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
  // Documented as a public API (README) — allow cross-origin reads.
  res.set('Access-Control-Allow-Origin', '*');
  const hit = getCached();
  if (hit) { res.json(hit); return; }
  const data = buildPublicPayload();
  setCached(data);
  res.json(data);
});

// Unknown /api/* paths: JSON 404, not Express's default HTML page.
api.use((_req, res) => {
  res.status(404).json({ error: 'not found' });
});
