import { config } from '../config';
import { invalidateCache } from './cache';
import {
  GhIssue,
  listIssueComments,
  listReleases,
  listSecurityAdvisories,
  paginateIssues,
} from './github';
import { classifyIssue, type IssueClassification, PROMPT_VERSION } from './llm';
import { applyLabelOverrides, applyTitleFunctionalityHint } from './labelOverrides';
import {
  computeAggregateBreaking,
  computeBetaCount,
  computeHoursToNextRelease,
  computeHoursToNextStable,
  hasHotfixSuccessor,
  parseReleaseNotes,
} from './releaseNotes';
import { matchesRange, stableDistance } from './versionMatch';
import { topBrokenSurfaces } from './surfaces';

// Limited concurrency for LLM classification — keeps wall time tractable on cold-cache
// back-fill (≈1400 issues at ~1s each serially → ~25 min; 5-wide pool → ~5 min) while
// staying well under GitHub's secondary rate limit and OpenAI's per-minute token caps.
const CLASSIFY_CONCURRENCY = 5;

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const pool = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      await worker(items[idx]);
    }
  });
  await Promise.all(pool);
}
import { cveDecayLoad, feltLoad, installConfidence, pickRecommended, type InstallInput } from './score';
import {
  closedDuringReign,
  countStaleClassifications,
  deleteStaleClassifications,
  detectBot,
  getClassification,
  getLastScoredAt,
  getMeta,
  getRelease,
  issuesForVersion,
  listAdvisories,
  listReleasesDb,
  openedDuringReign,
  setMeta,
  updateReleaseDerivedStats,
  updateReleaseScore,
  upsertAdvisory,
  upsertClassification,
  upsertIssue,
  upsertRelease,
} from './db';

const BACKFILL_FLAG = 'backfill_completed_at';

let refreshing = false;
// Seed from DB so "Not yet refreshed" doesn't show after a restart.
let lastRefreshAt: string | null = getLastScoredAt();
let lastError: string | null = null;
// Outcome of the classification pass of the last completed refresh. Per-issue
// classify failures are deliberately non-fatal (one bad issue must not kill a
// refresh), but when EVERY call fails (dead LLM key, exhausted credits) the
// refresh still "succeeds" and the dashboard keeps serving evidence frozen at
// the last classified issue. Exposing the counts lets /api/status and the UI
// say "issue analysis is degraded" instead of silently looking healthy.
let lastClassification: {
  classified: number;
  failed: number;
  lastFailure: string | null;
} | null = null;

export function getRefreshState() {
  return { refreshing, lastRefreshAt, lastError, classification: lastClassification };
}

export async function refresh(): Promise<{
  classifiedCount: number;
  releaseCount: number;
  durationMs: number;
}> {
  if (refreshing) throw new Error('refresh already running');
  refreshing = true;
  lastError = null;
  const t0 = Date.now();

  try {
    // 1. Pull releases. We over-fetch (×6) because openclaw's prerelease:stable
    // ratio is ~3:1; from this wider window we keep ALL entries for derived-stat
    // computation (betaCount, hoursToNextRelease, aggregate breaking) but only
    // score the latest `releases` stable ones. Prereleases are not scored — they
    // signal shake-out time around the stable that ships next.
    //
    // The ×6 multiplier also bounds how far back `computeAggregateBreaking` can
    // look: a stable's beta chain must be inside this fetched window for its
    // breaking bullets to be counted. At openclaw's 3:1 beta:stable ratio,
    // ×6 → ~10 stables of headroom past the monitored count. If that ratio ever
    // inverts (more betas per stable), bump the multiplier.
    // Monitor only the latest `config.limits.releases` (default 10). This is the
    // expensive window: it drives the issue-classification cutoff (oldestMonitoredMs
    // below) and thus how many LLM calls a back-fill / prompt-sweep costs. The score
    // chart renders up to SCORE_HISTORY_CHART_LIMIT (20) points, but there's no sense
    // running the long classification pass that wide — the focus is the recent 10.
    // Chart points 11–20 are intentionally frozen rows already scored in past runs
    // (served straight from the DB), kept purely as comparative trend context.
    const monitoredReleaseCount = config.limits.releases;
    const fetched = await listReleases(monitoredReleaseCount * 6);
    const releases = fetched.filter((r) => !r.prerelease).slice(0, monitoredReleaseCount);
    for (const r of releases) {
      upsertRelease({
        tag: r.tag_name,
        name: r.name,
        published_at: r.published_at,
        html_url: r.html_url,
        prerelease: r.prerelease,
        body: r.body ?? null,
      });
    }
    const tags = releases.map((r) => r.tag_name);

    // Derived stats per stable: parse maintainer-signal counts from the body,
    // count preceding prereleases and time-to-next-release. No new API calls —
    // all data comes from `fetched`. Failure here is a code bug, not a network
    // issue, so we don't try/catch — let it surface during dev.
    //
    // releasesForCalc carries `breakingCount` from each fetched body (including
    // prereleases) so `computeAggregateBreaking` can roll a stable's preceding
    // beta chain into its stored `breaking_count`. Without this, a `### Breaking`
    // bullet that only appears in a beta body (and is not repeated in the stable
    // body at promotion time) would be invisible — see comment on
    // computeAggregateBreaking in releaseNotes.ts.
    const releasesForCalc = fetched.map((r) => ({
      tag: r.tag_name,
      published_at: r.published_at,
      prerelease: r.prerelease,
      breakingCount: parseReleaseNotes(r.body).breakingCount,
    }));
    for (const r of releases) {
      const stats = parseReleaseNotes(r.body);
      updateReleaseDerivedStats({
        tag: r.tag_name,
        // Aggregated: own + breaking bullets from each preceding beta until the
        // previous stable. Other counts (fixes/changes/highlights) are NOT
        // aggregated — the changelog generator re-lists them in the stable body
        // at promotion time, so they're already counted once.
        breaking_count: computeAggregateBreaking(releasesForCalc, r.tag_name),
        fixes_count: stats.fixesCount,
        changes_count: stats.changesCount,
        highlights_count: stats.highlightsCount,
        pr_refs_count: stats.prRefsCount,
        beta_count: computeBetaCount(releasesForCalc, r.tag_name),
        hours_to_next_release: computeHoursToNextRelease(releasesForCalc, r.tag_name),
        hours_to_next_stable: computeHoursToNextStable(releasesForCalc, r.tag_name),
      });
    }

    // 1b. Pull all security advisories for the repo. One cheap call, backfills
    // historical CVEs automatically. Failure here must not abort the whole
    // refresh — security data is additive; if the endpoint is down or the repo
    // has none, we still want issue/release data to update.
    try {
      const advisories = await listSecurityAdvisories();
      for (const adv of advisories) {
        // Take the first vulnerability entry referring to this repo's package.
        // openclaw advisories all have exactly one; if a future one had multiple,
        // we'd pick the one matching ecosystem === 'npm' (or fallback).
        const v = adv.vulnerabilities[0];
        upsertAdvisory({
          ghsa_id: adv.ghsa_id,
          cve_id: adv.cve_id,
          summary: adv.summary,
          severity: adv.severity,
          html_url: adv.html_url,
          published_at: adv.published_at,
          vulnerable_version_range: v?.vulnerable_version_range ?? null,
          patched_versions: v?.patched_versions ?? null,
        });
      }
    } catch (e) {
      console.warn(`[advisories] fetch failed (continuing): ${(e as Error).message}`);
    }

    // 2. Stream issues sorted by updated_at desc, paginating until we either:
    //    (a) see a full page where every issue is already classified at its current
    //        updated_at and prompt version — nothing newer below this point;
    //    (b) cross the published_at of the oldest monitored release — anything older
    //        can't affect a release we display on the dashboard;
    //    (c) hit MAX_PAGES as a safety belt against pathological data.
    //
    // First run (no backfill flag yet) IGNORES condition (a). Otherwise a fresh deploy
    // on top of an existing DB stops on page 1 the moment every visible issue is "known
    // unchanged" — never reaching the older issues that older releases need. Once we've
    // crossed the oldest release published_at at least once, the flag is set and future
    // runs use the cheap (a)+(b)+(c) stop logic. No tokens are spent re-classifying
    // unchanged issues — only fetched + upserted.
    const publishedAts = releases
      .map((r) => r.published_at)
      .filter((p): p is string => !!p)
      .map((p) => Date.parse(p))
      .filter((ms) => Number.isFinite(ms));
    const oldestMonitoredMs = publishedAts.length > 0 ? Math.min(...publishedAts) : -Infinity;
    const backfillDone = getMeta(BACKFILL_FLAG) !== null;

    // After a PROMPT_VERSION bump, rows written under the old prompt are stale but
    // sit behind the oldest-monitored cutoff — the normal early-stop would skip
    // them forever. Detect this once and do a full sweep this run so the bump
    // actually propagates. Worst case: ~25 pages (~$1) once per prompt change.
    const staleRows = countStaleClassifications(PROMPT_VERSION);
    const promptSweep = backfillDone && staleRows > 0;
    if (promptSweep) {
      console.log(`[refresh] prompt-sweep: ${staleRows} stale classifications, ignoring early-stop this run`);
    }

    const MAX_PAGES = 50; // 50 × 100 raw items ≈ several months of openclaw history
    let pagesFetched = 0;
    let classifiedCount = 0;
    let classifyFailedCount = 0;
    let lastClassifyFailure: string | null = null;
    let crossedOldestEver = false;

    paginate: for await (const page of paginateIssues(100)) {
      pagesFetched++;

      // Page can be empty after PR filtering — keep going until we hit a real signal
      // or run out of pages.
      let allUnchanged = page.length > 0;
      let crossedOldest = false;
      const toClassify: GhIssue[] = [];

      // Pass 1: upsert + decide what needs LLM. SQLite writes are cheap and sequential.
      for (const issue of page) {
        const author = issue.user?.login ?? null;
        const labelsJson = JSON.stringify(issue.labels.map((l) => l.name));
        upsertIssue({
          number: issue.number,
          state: issue.state,
          title: issue.title,
          author,
          html_url: issue.html_url,
          created_at: issue.created_at,
          updated_at: issue.updated_at,
          closed_at: issue.closed_at,
          comments: issue.comments,
          labels: labelsJson,
          is_bot: detectBot(author, labelsJson) ? 1 : 0,
        });

        if (Date.parse(issue.updated_at) < oldestMonitoredMs) crossedOldest = true;

        const existing = getClassification(issue.number);
        const skip = existing && (
          // Back-fill mode: preserve tokens — anything already classified is left as-is,
          // even if updated_at moved on or prompt_version is stale. The next normal run
          // (once the back-fill flag is set) will pick up those rows incrementally.
          !backfillDone ||
          // Normal mode: only skip when the row is fully current.
          (existing.classified_updated_at === issue.updated_at && existing.prompt_version === PROMPT_VERSION)
        );
        if (skip) continue;
        allUnchanged = false;
        toClassify.push(issue);
      }

      // Pass 2: classify pending issues in parallel. Per-issue failures are isolated
      // — one issue erroring out doesn't kill the rest of the page or the back-fill.
      await runWithConcurrency(toClassify, CLASSIFY_CONCURRENCY, async (issue) => {
        try {
          const comments = issue.comments > 0 ? await listIssueComments(issue.number) : [];
          const cls: IssueClassification = await classifyIssue(issue, comments, tags);
          upsertClassification(issue.number, cls, issue.updated_at, PROMPT_VERSION);
          classifiedCount++;
        } catch (e) {
          classifyFailedCount++;
          // Keep the first line only — OpenAI errors embed a multi-line JSON body.
          lastClassifyFailure = (e as Error).message.split('\n')[0].slice(0, 300);
          console.error(`[classify] issue #${issue.number} failed:`, (e as Error).message);
        }
      });

      if (crossedOldest) crossedOldestEver = true;

      // During the initial back-fill (or after a PROMPT_VERSION bump that left
      // stale rows behind the oldest-monitored cutoff) we ignore the early-stop
      // shortcuts and walk the full pagination up to MAX_PAGES, so we actually
      // reach older issues that would otherwise stay frozen on the old prompt.
      const canEarlyStop = backfillDone && !promptSweep && allUnchanged;
      const canCrossedOldestStop = !promptSweep && crossedOldest;
      if (canEarlyStop || canCrossedOldestStop) break paginate;
      if (pagesFetched >= MAX_PAGES) break paginate;
    }

    // Mark back-fill complete the first time we actually paginated past the oldest
    // monitored release (or hit MAX_PAGES). After this, the "all unchanged" early
    // stop kicks in on subsequent runs.
    if (!backfillDone && (crossedOldestEver || pagesFetched >= MAX_PAGES)) {
      setMeta(BACKFILL_FLAG, new Date().toISOString());
    }

    // After a prompt-sweep that walked the full pagination: if any rows are
    // STILL on the old prompt version, they're issues whose updated_at is too
    // old for GitHub pagination to reach within MAX_PAGES — they will keep
    // forcing the (expensive) sweep on every refresh forever. Drop them. If
    // GitHub ever surfaces those issues again (new comment), refresh will
    // re-classify them fresh on the next pass.
    if (promptSweep) {
      const leftover = countStaleClassifications(PROMPT_VERSION);
      if (leftover > 0) {
        const dropped = deleteStaleClassifications(PROMPT_VERSION);
        console.log(`[refresh] dropped ${dropped} unreachable stale rows after sweep`);
      }
    }

    // 4. Score every monitored release with the Install Confidence model — a single
    //    pass answering "should I install this stable?" from age/cadence-invariant
    //    signals (CVE, settle age, hotfix succession, stable-to-stable survival, beta
    //    shakeout, serious-regression balance). No peer median, no carry-forward
    //    attribution in the score itself. See lib/score.ts for the full rationale.
    const allReleases = listReleasesDb(monitoredReleaseCount);
    const allFetchedTags = fetched.map((r) => r.tag_name);

    // CVE exposure per tag. `affected` (medium+ advisory matches) drives the
    // skip-cve STATUS (never recommended); `load` is the DECAYED severity-weighted
    // penalty on the score — see cveDecayLoad. Distance is measured over all fetched
    // stables (newest first), so it can see releases between a version and a far patch.
    const advisories = listAdvisories();
    const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
    const stableTagsNewestFirst = fetched.filter((r) => !r.prerelease).map((r) => r.tag_name);
    const cveFor = (tag: string): { affected: boolean; load: number } => {
      const matching = advisories.filter((a) => matchesRange(tag, a.vulnerable_version_range));
      const affected = matching.some((a) => (SEV_RANK[a.severity] ?? 0) >= 2); // medium+ gates
      // Score load = severity of this version's OWN CVEs (patched in the next stable,
      // distance ≤ 0) — the same set the badge shows. Distant CVEs still trip the
      // skip-cve STATUS via `affected`, but don't inflate the severity number.
      const load = cveDecayLoad(
        matching
          .map((a) => ({
            severity: a.severity,
            distance: stableDistance(tag, a.patched_versions, stableTagsNewestFirst),
          }))
          .filter((x) => x.distance <= 0),
      );
      return { affected, load };
    };

    // Post-override classification for an attributed/reign issue row.
    const classify = classifyIssueRow;
    const isCoreSerious = (c: IssueClassification): boolean =>
      c.sentiment === 'negative' &&
      c.functionality === 'core' &&
      (c.severity === 'critical' || c.severity === 'high');
    const countCoreSerious = (rows: ReturnType<typeof issuesForVersion>): number =>
      rows.reduce((n, r) => (isCoreSerious(classify(r)) ? n + 1 : n), 0);
    const scored = allReleases.map((rel, idx) => {
      // negative/positive counts are display-only context (not part of the score).
      let neg = 0;
      let pos = 0;
      for (const r of issuesForVersion(rel.tag)) {
        const s = classify(r).sentiment;
        if (s === 'negative') neg++;
        else if (s === 'positive') pos++;
      }
      const openedReign = openedDuringReign(rel.tag);
      const closedReign = closedDuringReign(rel.tag);
      // core-serious counts: kept for the informational API/DB stats.
      const openedSerious = countCoreSerious(openedReign);
      const closedSerious = countCoreSerious(closedReign);
      // visible-bug ("felt") reach-weighted load drives the score's regression term.
      const feltOpenedWeight = feltLoad(openedReign.map(classify));
      const feltClosedWeight = feltLoad(closedReign.map(classify));
      // WHAT it breaks: still-open visible regressions introduced during the reign,
      // grouped by named surface (Discord, Ollama, …) for the UI.
      const brokenSurfaces = JSON.stringify(
        topBrokenSurfaces(
          openedReign.filter(isOpenFeltSeriousIssue).map((r) => r.title),
        ),
      );
      const cve = cveFor(rel.tag);
      const input: InstallInput = {
        publishedAt: rel.published_at,
        isLatest: idx === 0, // listReleasesDb returns newest-first
        hoursToNextStable: rel.hours_to_next_stable,
        hasHotfixSuccessor: hasHotfixSuccessor(allFetchedTags, rel.tag),
        betaCount: rel.beta_count,
        breakingCount: rel.breaking_count,
        feltOpenedWeight,
        feltClosedWeight,
        cveAffected: cve.affected,
        cveLoad: cve.load,
      };
      return { rel, conf: installConfidence(input), neg, pos, openedSerious, closedSerious, brokenSurfaces };
    });

    // Recommended install: newest release that passed all gates and scores ≥ threshold.
    const recommendedTag = pickRecommended(
      scored.map((s) => ({ tag: s.rel.tag, status: s.conf.status, score: s.conf.score })),
    );

    for (const s of scored) {
      updateReleaseScore({
        tag: s.rel.tag,
        final_score: s.conf.score,
        negative_issues: s.neg,
        positive_issues: s.pos,
        state: s.conf.status,
        recommended: s.rel.tag === recommendedTag ? 1 : 0,
        score_reason: s.conf.reason,
        broken_surfaces: s.brokenSurfaces,
        closed_serious_fixed: s.closedSerious,
        opened_serious_during_reign: s.openedSerious,
      });
    }

    lastRefreshAt = new Date().toISOString();
    lastClassification = {
      classified: classifiedCount,
      failed: classifyFailedCount,
      lastFailure: lastClassifyFailure,
    };
    invalidateCache();
    return {
      classifiedCount,
      releaseCount: allReleases.length,
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    lastError = (e as Error).message;
    throw e;
  } finally {
    refreshing = false;
  }
}

function safeParseLabels(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function rowToClassification(row: {
  sentiment: string;
  severity: string;
  scope: string;
  functionality: string;
  affected_users: string;
  has_workaround: number;
  workaround_status: string;
  duplicate_cluster: string | null;
  affects_version: string | null;
  confidence: number;
  rationale: string | null;
}): IssueClassification {
  // workaround_status was added later; rows written by old code have the default 'unknown',
  // but be defensive: if it's an unexpected value, fall back to deriving from has_workaround.
  const wsAllowed = ['none', 'partial', 'confirmed', 'unknown'] as const;
  const ws = wsAllowed.includes(row.workaround_status as (typeof wsAllowed)[number])
    ? (row.workaround_status as IssueClassification['workaroundStatus'])
    : row.has_workaround === 1
      ? 'confirmed'
      : 'unknown';
  return {
    sentiment: row.sentiment as IssueClassification['sentiment'],
    severity: row.severity as IssueClassification['severity'],
    scope: row.scope as IssueClassification['scope'],
    functionality: row.functionality as IssueClassification['functionality'],
    affectedUsers: row.affected_users as IssueClassification['affectedUsers'],
    workaroundStatus: ws,
    duplicateCluster: row.duplicate_cluster,
    affectsVersion: row.affects_version,
    confidence: row.confidence,
    rationale: row.rationale ?? '',
  };
}

// re-export for routes

export function classifyIssueRow(row: ReturnType<typeof issuesForVersion>[number]): IssueClassification {
  return applyLabelOverrides(
    applyTitleFunctionalityHint(rowToClassification(row), row.title),
    safeParseLabels(row.labels),
  );
}

export function isOpenFeltSeriousIssue(row: ReturnType<typeof issuesForVersion>[number]): boolean {
  const c = classifyIssueRow(row);
  return row.state === 'open'
    && c.sentiment === 'negative'
    && (c.functionality === 'core' || c.functionality === 'integration' || c.functionality === 'provider')
    && (c.severity === 'critical' || c.severity === 'high');
}

export { getRelease, issuesForVersion, listReleasesDb, openedDuringReign };
