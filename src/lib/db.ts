import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config';
import type { IssueClassification } from './llm';

// node:sqlite is built into Node ≥ 22.5 (stable since 24). No native build, no prebuilds.

mkdirSync(dirname(config.db.path), { recursive: true });

export const db = new DatabaseSync(config.db.path);
// WAL improves concurrent reads but isn't supported on every mount (FUSE, some NFS).
// Fall back to the default rollback journal if it fails.
try {
  db.exec('PRAGMA journal_mode = WAL');
} catch (e) {
  console.warn('[db] WAL not supported on this filesystem, falling back to default journal:', (e as Error).message);
}
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS releases (
  tag TEXT PRIMARY KEY,
  name TEXT,
  published_at TEXT,
  html_url TEXT,
  prerelease INTEGER NOT NULL DEFAULT 0,
  final_score REAL,
  risk_index REAL,
  negative_issues INTEGER,
  positive_issues INTEGER,
  scored_at TEXT,
  state TEXT,
  closed_serious_fixed INTEGER NOT NULL DEFAULT 0,
  fix_bonus REAL NOT NULL DEFAULT 0,
  opened_serious_during_reign INTEGER NOT NULL DEFAULT 0,
  -- Raw release-notes body. Stored verbatim so we can re-mine if the parser grows new signals.
  body TEXT,
  -- Maintainer-signal counts parsed from body by lib/releaseNotes.ts.
  -- breaking_count: bullets under "### Breaking" — explicit API/config breakage.
  -- fixes_count:    bullets under "### Fixes" — bugs the team owned and closed.
  -- changes_count:  bullets under "### Changes" — features/refactors shipped.
  -- highlights_count: bullets under "### Highlights" — items the team called out.
  -- pr_refs_count:  distinct #NNNNN PR refs across the entire body.
  -- beta_count:     prereleases between this stable and the previous stable (shake-out depth).
  -- hours_to_next_release: hours until the next release of ANY kind (incl. betas).
  -- hours_to_next_stable:  hours until the next STABLE — the install-relevant "how long
  --                        did this stay the current version" signal (betas ignored).
  -- recommended:    1 for the single release the Install Confidence model recommends.
  breaking_count INTEGER NOT NULL DEFAULT 0,
  fixes_count INTEGER NOT NULL DEFAULT 0,
  changes_count INTEGER NOT NULL DEFAULT 0,
  highlights_count INTEGER NOT NULL DEFAULT 0,
  pr_refs_count INTEGER NOT NULL DEFAULT 0,
  beta_count INTEGER NOT NULL DEFAULT 0,
  hours_to_next_release REAL,
  hours_to_next_stable REAL,
  recommended INTEGER NOT NULL DEFAULT 0,
  -- Short human explanation of the Install Confidence verdict, from lib/score.ts.
  score_reason TEXT,
  -- JSON array of the top product surfaces this release breaks (visible regressions),
  -- e.g. [{"label":"Discord","icon":"discord","count":11}]. See lib/surfaces.ts.
  broken_surfaces TEXT
);

CREATE TABLE IF NOT EXISTS issues (
  number INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  html_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  comments INTEGER NOT NULL,
  labels TEXT NOT NULL DEFAULT '[]',
  is_bot INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS classifications (
  issue_number INTEGER PRIMARY KEY,
  sentiment TEXT NOT NULL,
  severity TEXT NOT NULL,
  scope TEXT NOT NULL,
  functionality TEXT NOT NULL,
  affected_users TEXT NOT NULL,
  has_workaround INTEGER NOT NULL,
  workaround_status TEXT NOT NULL DEFAULT 'unknown',
  duplicate_cluster TEXT,
  affects_version TEXT,
  confidence REAL NOT NULL,
  rationale TEXT,
  classified_at TEXT NOT NULL,
  classified_updated_at TEXT NOT NULL,
  prompt_version INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (issue_number) REFERENCES issues(number) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_classifications_version ON classifications(affects_version);
CREATE INDEX IF NOT EXISTS idx_issues_updated ON issues(updated_at);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- GitHub Security Advisories cached for the repo. Refreshed on each cycle.
-- vulnerable_version_range / patched_versions are stored verbatim as GitHub
-- returns them; the matching logic lives in lib/versionMatch.ts.
CREATE TABLE IF NOT EXISTS advisories (
  ghsa_id TEXT PRIMARY KEY,
  cve_id TEXT,
  summary TEXT NOT NULL,
  severity TEXT NOT NULL,
  html_url TEXT NOT NULL,
  published_at TEXT,
  vulnerable_version_range TEXT,
  patched_versions TEXT,
  fetched_at TEXT NOT NULL
);
`);

// Idempotent migrations for existing DBs. ALTER TABLE ADD COLUMN errors if the
// column already exists, so we swallow the error rather than guard it.
for (const sql of [
  `ALTER TABLE issues ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE classifications ADD COLUMN workaround_status TEXT NOT NULL DEFAULT 'unknown'`,
  `ALTER TABLE classifications ADD COLUMN prompt_version INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE releases ADD COLUMN state TEXT`,
  `ALTER TABLE releases ADD COLUMN closed_serious_fixed INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE releases ADD COLUMN fix_bonus REAL NOT NULL DEFAULT 0`,
  `ALTER TABLE releases ADD COLUMN opened_serious_during_reign INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE releases ADD COLUMN body TEXT`,
  `ALTER TABLE releases ADD COLUMN breaking_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE releases ADD COLUMN fixes_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE releases ADD COLUMN changes_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE releases ADD COLUMN highlights_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE releases ADD COLUMN pr_refs_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE releases ADD COLUMN beta_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE releases ADD COLUMN hours_to_next_release REAL`,
  `ALTER TABLE releases ADD COLUMN hours_to_next_stable REAL`,
  `ALTER TABLE releases ADD COLUMN recommended INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE releases ADD COLUMN score_reason TEXT`,
  `ALTER TABLE releases ADD COLUMN broken_surfaces TEXT`,
]) {
  try { db.exec(sql); } catch { /* column already exists */ }
}

// Bot detection. Cheap, deterministic, no extra LLM tokens.
// Markers we consider bot-generated:
//   - login ends with [bot] (GitHub's convention for app installations)
//   - login matches a known automation pattern (dependabot, renovate, …)
// Maintainer triage tools (e.g. `clawsweeper:*` labels) describe workflow stage on issues
// filed by real humans — they MUST NOT trigger bot detection. Earlier the regex looked at
// labels and treated `clawsweeper:needs-live-repro` as evidence of bot authorship, which
// dampened 91% of real bug reports and made every release look stable-by-mistake.
// Marked issues are NOT excluded from scoring — they're down-weighted in score.ts.
const BOT_AUTHOR_RE = /\[bot\]$|^(github-actions|dependabot|renovate(-bot)?|mergify|stale)$/i;

export function detectBot(author: string | null, _labelsJson: string): boolean {
  if (author && BOT_AUTHOR_RE.test(author)) return true;
  return false;
}

// ---------- releases ----------
export interface ReleaseRow {
  tag: string;
  name: string | null;
  published_at: string | null;
  html_url: string;
  prerelease: number;
  final_score: number | null;
  risk_index: number | null;
  negative_issues: number | null;
  positive_issues: number | null;
  scored_at: string | null;
  // 'analyzing' (<3h grace), 'insufficient' (no negative signal), 'rated', or null
  // for pre-migration rows that haven't been re-scored yet.
  state: string | null;
  // Core-serious bugs closed during this release's reign — the "fixes credit".
  closed_serious_fixed: number;
  // Score points added by those fixes (already included in final_score).
  fix_bonus: number;
  // Core-serious bugs OPENED during this release's reign — informational only,
  // surfaces "this release shipped fixes but also brought regressions" without
  // penalising the score (would create a fight with the recommendation block).
  opened_serious_during_reign: number;
  // Raw release-notes body (markdown). Kept so we can re-mine if the parser
  // grows new signals without re-fetching from GitHub.
  body: string | null;
  // Maintainer-signal counts. See db.ts CREATE TABLE comment block for what
  // each one means.
  breaking_count: number;
  fixes_count: number;
  changes_count: number;
  highlights_count: number;
  pr_refs_count: number;
  beta_count: number;
  hours_to_next_release: number | null;
  hours_to_next_stable: number | null;
  recommended: number;
  score_reason: string | null;
  broken_surfaces: string | null;
}

const upsertReleaseStmt = db.prepare(`
INSERT INTO releases (tag, name, published_at, html_url, prerelease, body)
VALUES (:tag, :name, :published_at, :html_url, :prerelease, :body)
ON CONFLICT(tag) DO UPDATE SET
  name=excluded.name,
  published_at=excluded.published_at,
  html_url=excluded.html_url,
  prerelease=excluded.prerelease,
  body=excluded.body
`);

export function upsertRelease(r: {
  tag: string;
  name: string | null;
  published_at: string | null;
  html_url: string;
  prerelease: boolean;
  body: string | null;
}): void {
  upsertReleaseStmt.run({ ...r, prerelease: r.prerelease ? 1 : 0 });
}

const updateReleaseDerivedStatsStmt = db.prepare(`
UPDATE releases SET
  breaking_count=:breaking_count,
  fixes_count=:fixes_count,
  changes_count=:changes_count,
  highlights_count=:highlights_count,
  pr_refs_count=:pr_refs_count,
  beta_count=:beta_count,
  hours_to_next_release=:hours_to_next_release,
  hours_to_next_stable=:hours_to_next_stable
WHERE tag=:tag
`);

export function updateReleaseDerivedStats(args: {
  tag: string;
  breaking_count: number;
  fixes_count: number;
  changes_count: number;
  highlights_count: number;
  pr_refs_count: number;
  beta_count: number;
  hours_to_next_release: number | null;
  hours_to_next_stable: number | null;
}): void {
  updateReleaseDerivedStatsStmt.run(args);
}

// Install Confidence score writer. final_score is the 0–10 IC (NULL when 'wait').
// `state` carries the install status: 'wait' | 'skip-cve' | 'skip-hotfix' | 'eligible'.
// risk_index / fix_bonus are legacy columns from the old model — left untouched here.
const updateScoreStmt = db.prepare(`
UPDATE releases SET final_score=:final_score,
  negative_issues=:negative_issues, positive_issues=:positive_issues,
  state=:state, recommended=:recommended, score_reason=:score_reason,
  broken_surfaces=:broken_surfaces,
  closed_serious_fixed=:closed_serious_fixed,
  opened_serious_during_reign=:opened_serious_during_reign,
  scored_at=:scored_at
WHERE tag=:tag
`);

export function updateReleaseScore(args: {
  tag: string;
  final_score: number | null;
  negative_issues: number;
  positive_issues: number;
  state: string;
  recommended: number;
  score_reason: string;
  broken_surfaces: string;
  closed_serious_fixed: number;
  opened_serious_during_reign: number;
}): void {
  updateScoreStmt.run({ ...args, scored_at: new Date().toISOString() });
}

// Stable-only view. Prereleases live in the DB for derived-stat computation
// (beta_count, hours_to_next_release) but are not surfaced to scoring or the
// API — the UI is "should I install this stable release?", betas don't get
// installed individually by end users.
const listReleasesStmt = db.prepare(`
SELECT * FROM releases WHERE prerelease = 0 ORDER BY published_at IS NULL, published_at DESC LIMIT ?
`);

export function listReleasesDb(limit = 20): ReleaseRow[] {
  return listReleasesStmt.all(limit) as unknown as ReleaseRow[];
}

const getReleaseStmt = db.prepare(`SELECT * FROM releases WHERE tag=?`);
export function getRelease(tag: string): ReleaseRow | undefined {
  return getReleaseStmt.get(tag) as ReleaseRow | undefined;
}

const lastScoredAtStmt = db.prepare(`SELECT MAX(scored_at) AS ts FROM releases`);
export function getLastScoredAt(): string | null {
  const row = lastScoredAtStmt.get() as { ts: string | null };
  return row?.ts ?? null;
}

// ---------- issues ----------
export interface IssueRow {
  number: number;
  state: string;
  title: string;
  author: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: number;
  labels: string;
  is_bot: number; // 0/1; computed at write time via detectBot()
}

const upsertIssueStmt = db.prepare(`
INSERT INTO issues (number, state, title, author, html_url, created_at, updated_at, closed_at, comments, labels, is_bot)
VALUES (:number, :state, :title, :author, :html_url, :created_at, :updated_at, :closed_at, :comments, :labels, :is_bot)
ON CONFLICT(number) DO UPDATE SET
  state=excluded.state,
  title=excluded.title,
  author=excluded.author,
  html_url=excluded.html_url,
  created_at=excluded.created_at,
  updated_at=excluded.updated_at,
  closed_at=excluded.closed_at,
  comments=excluded.comments,
  labels=excluded.labels,
  is_bot=excluded.is_bot
`);

export function upsertIssue(i: IssueRow): void {
  upsertIssueStmt.run(i as unknown as Record<string, string | number | null>);
}

const getIssueStmt = db.prepare(`SELECT * FROM issues WHERE number=?`);
export function getIssue(number: number): IssueRow | undefined {
  return getIssueStmt.get(number) as IssueRow | undefined;
}

// ---------- classifications ----------
// `has_workaround` is the legacy boolean — we keep writing it for back-compat with old
// rows, but new scoring code only reads `workaround_status`.
const upsertClassificationStmt = db.prepare(`
INSERT INTO classifications (issue_number, sentiment, severity, scope, functionality, affected_users,
  has_workaround, workaround_status, duplicate_cluster, affects_version, confidence, rationale,
  classified_at, classified_updated_at, prompt_version)
VALUES (:issue_number, :sentiment, :severity, :scope, :functionality, :affected_users,
  :has_workaround, :workaround_status, :duplicate_cluster, :affects_version, :confidence, :rationale,
  :classified_at, :classified_updated_at, :prompt_version)
ON CONFLICT(issue_number) DO UPDATE SET
  sentiment=excluded.sentiment,
  severity=excluded.severity,
  scope=excluded.scope,
  functionality=excluded.functionality,
  affected_users=excluded.affected_users,
  has_workaround=excluded.has_workaround,
  workaround_status=excluded.workaround_status,
  duplicate_cluster=excluded.duplicate_cluster,
  affects_version=excluded.affects_version,
  confidence=excluded.confidence,
  rationale=excluded.rationale,
  classified_at=excluded.classified_at,
  classified_updated_at=excluded.classified_updated_at,
  prompt_version=excluded.prompt_version
`);

export function upsertClassification(
  issueNumber: number,
  c: IssueClassification,
  issueUpdatedAt: string,
  promptVersion: number,
): void {
  upsertClassificationStmt.run({
    issue_number: issueNumber,
    sentiment: c.sentiment,
    severity: c.severity,
    scope: c.scope,
    functionality: c.functionality,
    affected_users: c.affectedUsers,
    has_workaround: c.workaroundStatus === 'confirmed' ? 1 : 0,
    workaround_status: c.workaroundStatus,
    duplicate_cluster: c.duplicateCluster,
    affects_version: c.affectsVersion,
    confidence: c.confidence,
    rationale: c.rationale,
    classified_at: new Date().toISOString(),
    classified_updated_at: issueUpdatedAt,
    prompt_version: promptVersion,
  });
}

export interface ClassificationRow {
  issue_number: number;
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
  classified_at: string;
  classified_updated_at: string;
  prompt_version: number;
}

const getClassificationStmt = db.prepare(`SELECT * FROM classifications WHERE issue_number=?`);
export function getClassification(issueNumber: number): ClassificationRow | undefined {
  return getClassificationStmt.get(issueNumber) as ClassificationRow | undefined;
}

// Joined view for scoring + UI
export interface JoinedIssue extends IssueRow, ClassificationRow {}

// Window-based attribution (carry-forward model).
//
// An issue affects release R if its existence window overlaps R's reign:
//   - R reigns from R.published_at until the NEXT release is published
//     (or forever, if R is the latest).
//   - The issue exists from issue.created_at until issue.closed_at
//     (or forever, if still open).
// These two windows must overlap.
//
// Why this model, not the previous LLM-mention-only approach:
//   * A bug filed during v5.4's reign and still open today AFFECTS v5.20 too —
//     it's not been fixed. The old model attributed it to v5.4 only (via the
//     LLM's explicit mention) or dropped it (no mention). Either way, v5.20
//     missed a real bug that exists in it.
//   * A bug closed before R was even published does NOT affect R — the fix
//     was already in by R's release date.
//   * A bug filed during R's reign and closed during R's reign DOES affect R
//     (someone hit it before it was fixed) — overlap captures this naturally.
//
// Properties:
//   - latest release accumulates EVERY currently-open bug from project history.
//     This is structurally correct: those bugs DO exist in latest. The release
//     will look worst-by-construction because it has the longest open-bug
//     debt. The dashboard layer (recommendation view) handles this via
//     age-normalised comparison.
//   - As bugs get closed over time, historical release scores improve —
//     stored data tells a more honest story of which past releases were
//     actually solid.
//
// LLM's `affects_version` is no longer used for attribution. It's kept in the
// row for display purposes only (UI can show "user explicitly said v5.18").
const issuesForVersionStmt = db.prepare(`
SELECT i.*,
       c.sentiment, c.severity, c.scope, c.functionality, c.affected_users,
       c.has_workaround, c.workaround_status, c.duplicate_cluster, c.affects_version,
       c.confidence, c.rationale, c.classified_at, c.classified_updated_at
FROM issues i
JOIN classifications c ON c.issue_number = i.number
JOIN releases target ON target.tag = ?
WHERE
  target.published_at IS NOT NULL
  -- Issue was filed before target's reign ended (next release published).
  -- For the latest release there is no "next", so we use a sentinel far future.
  AND i.created_at < COALESCE(
        (SELECT MIN(next.published_at) FROM releases next
         WHERE next.published_at > target.published_at),
        '9999-12-31T23:59:59Z'
      )
  -- Issue was not closed before target's reign started — i.e., the bug was
  -- still live when the user installed target, or was filed during R's reign.
  AND (i.closed_at IS NULL OR i.closed_at > target.published_at)
ORDER BY i.updated_at DESC
`);

export function issuesForVersion(tag: string): JoinedIssue[] {
  return issuesForVersionStmt.all(tag) as unknown as JoinedIssue[];
}

const rawIssuesForVersionStmt = db.prepare(`
SELECT i.*
FROM issues i
JOIN releases target ON target.tag = ?
WHERE
  target.published_at IS NOT NULL
  AND i.created_at < COALESCE(
        (SELECT MIN(next.published_at) FROM releases next
         WHERE next.published_at > target.published_at),
        '9999-12-31T23:59:59Z'
      )
  AND (i.closed_at IS NULL OR i.closed_at > target.published_at)
ORDER BY i.updated_at DESC
`);

export function rawIssuesForVersion(tag: string): IssueRow[] {
  return rawIssuesForVersionStmt.all(tag) as unknown as IssueRow[];
}

const rawIssueCountForVersionStmt = db.prepare(`
SELECT COUNT(*) AS n
FROM issues i
JOIN releases target ON target.tag = ?
WHERE
  target.published_at IS NOT NULL
  AND i.created_at < COALESCE(
        (SELECT MIN(next.published_at) FROM releases next
         WHERE next.published_at > target.published_at),
        '9999-12-31T23:59:59Z'
      )
  AND (i.closed_at IS NULL OR i.closed_at > target.published_at)
`);

export function rawIssueCountForVersion(tag: string): number {
  const row = rawIssueCountForVersionStmt.get(tag) as { n: number } | undefined;
  return row?.n ?? 0;
}

// Issues CLOSED during a release's reign — the "fixes credit" for that release.
// An issue counts as fixed-by-R if its closed_at falls inside R's reign window
// [R.published_at, next_release.published_at). This is what the release shipped
// in terms of resolved bugs. Used by scoring to give credit for active maintenance:
// a release that closes 100 core-serious issues during its reign should score
// noticeably higher than one that closes zero, even if its inherited debt is similar.
const closedDuringReignStmt = db.prepare(`
SELECT i.*,
       c.sentiment, c.severity, c.scope, c.functionality, c.affected_users,
       c.has_workaround, c.workaround_status, c.duplicate_cluster, c.affects_version,
       c.confidence, c.rationale, c.classified_at, c.classified_updated_at
FROM issues i
JOIN classifications c ON c.issue_number = i.number
JOIN releases target ON target.tag = ?
WHERE
  target.published_at IS NOT NULL
  AND i.closed_at IS NOT NULL
  AND i.closed_at >= target.published_at
  AND i.closed_at < COALESCE(
        (SELECT MIN(next.published_at) FROM releases next
         WHERE next.published_at > target.published_at AND next.prerelease = 0),
        '9999-12-31T23:59:59Z'
      )
ORDER BY i.closed_at DESC
`);

export function closedDuringReign(tag: string): JoinedIssue[] {
  return closedDuringReignStmt.all(tag) as unknown as JoinedIssue[];
}

// Issues OPENED during a release's reign — the "regressions introduced" signal.
// An issue counts as opened-during-R if its created_at falls inside R's reign
// window. Mirror of closedDuringReign. We don't currently penalise the score
// for this (would create new contradictions with the recommendation block),
// but we surface the count so users can see "this release closed 50 critical
// bugs and opened 150 during the same window" and judge for themselves.
const openedDuringReignStmt = db.prepare(`
SELECT i.*,
       c.sentiment, c.severity, c.scope, c.functionality, c.affected_users,
       c.has_workaround, c.workaround_status, c.duplicate_cluster, c.affects_version,
       c.confidence, c.rationale, c.classified_at, c.classified_updated_at
FROM issues i
JOIN classifications c ON c.issue_number = i.number
JOIN releases target ON target.tag = ?
WHERE
  target.published_at IS NOT NULL
  AND i.created_at >= target.published_at
  AND i.created_at < COALESCE(
        (SELECT MIN(next.published_at) FROM releases next
         WHERE next.published_at > target.published_at AND next.prerelease = 0),
        '9999-12-31T23:59:59Z'
      )
ORDER BY i.created_at DESC
`);

export function openedDuringReign(tag: string): JoinedIssue[] {
  return openedDuringReignStmt.all(tag) as unknown as JoinedIssue[];
}

// Count classifications written under a prompt version older than the current one.
// Used by refresh.ts to detect "a prompt bump happened — we have legacy rows that
// the pagination shortcut would skip" and disable the early-stop for one run.
const countStaleClsStmt = db.prepare(
  `SELECT COUNT(*) AS n FROM classifications WHERE prompt_version < ?`,
);
export function countStaleClassifications(currentPromptVersion: number): number {
  const row = countStaleClsStmt.get(currentPromptVersion) as { n: number };
  return row?.n ?? 0;
}

// Drop classification rows older than the current prompt version. Used by
// refresh.ts after a full sweep — issues with updated_at far enough in the
// past that GitHub pagination never returns them will otherwise keep their
// stale prompt_version forever and force the (expensive) prompt-sweep mode
// every refresh. Dropping the row is safe: if the issue ever resurfaces in
// pagination (e.g. a new comment lands), it will be re-classified fresh.
const deleteStaleClsStmt = db.prepare(
  `DELETE FROM classifications WHERE prompt_version < ?`,
);
export function deleteStaleClassifications(currentPromptVersion: number): number {
  const res = deleteStaleClsStmt.run(currentPromptVersion);
  return Number(res.changes ?? 0);
}

// ---------- advisories ----------
export interface AdvisoryRow {
  ghsa_id: string;
  cve_id: string | null;
  summary: string;
  severity: string;
  html_url: string;
  published_at: string | null;
  vulnerable_version_range: string | null;
  patched_versions: string | null;
  fetched_at: string;
}

const upsertAdvisoryStmt = db.prepare(`
INSERT INTO advisories (ghsa_id, cve_id, summary, severity, html_url, published_at,
  vulnerable_version_range, patched_versions, fetched_at)
VALUES (:ghsa_id, :cve_id, :summary, :severity, :html_url, :published_at,
  :vulnerable_version_range, :patched_versions, :fetched_at)
ON CONFLICT(ghsa_id) DO UPDATE SET
  cve_id=excluded.cve_id,
  summary=excluded.summary,
  severity=excluded.severity,
  html_url=excluded.html_url,
  published_at=excluded.published_at,
  vulnerable_version_range=excluded.vulnerable_version_range,
  patched_versions=excluded.patched_versions,
  fetched_at=excluded.fetched_at
`);

export function upsertAdvisory(a: Omit<AdvisoryRow, 'fetched_at'>): void {
  upsertAdvisoryStmt.run({ ...a, fetched_at: new Date().toISOString() });
}

const listAdvisoriesStmt = db.prepare(`SELECT * FROM advisories ORDER BY published_at DESC NULLS LAST`);
export function listAdvisories(): AdvisoryRow[] {
  return listAdvisoriesStmt.all() as unknown as AdvisoryRow[];
}

// ---------- meta ----------
// Key/value scratchpad for one-shot flags (e.g. "have we done the full back-fill yet").
const getMetaStmt = db.prepare(`SELECT value FROM meta WHERE key = ?`);
const setMetaStmt = db.prepare(
  `INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
);

export function getMeta(key: string): string | null {
  const row = getMetaStmt.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  setMetaStmt.run(key, value);
}
