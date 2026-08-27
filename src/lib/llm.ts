import { config } from '../config';
import type { GhComment, GhIssue } from './github';
import { applyLabelOverrides } from './labelOverrides';

// 7-dimension issue classification taxonomy.
export type Sentiment = 'negative' | 'positive' | 'neutral';
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Scope = 'broad' | 'moderate' | 'niche';
export type Functionality = 'core' | 'integration' | 'provider' | 'docs';
export type AffectedUsers = 'many' | 'some' | 'few' | 'unknown';
export type WorkaroundStatus = 'none' | 'partial' | 'confirmed' | 'unknown';

export interface IssueClassification {
  sentiment: Sentiment;
  severity: Severity;
  scope: Scope;
  functionality: Functionality;
  affectedUsers: AffectedUsers;
  workaroundStatus: WorkaroundStatus;
  duplicateCluster: string | null; // short label like "ollama-timeout" — same label across dupes
  affectsVersion: string | null;   // explicit release tag this issue affects, or null if not stated
  confidence: number;              // 0..1
  rationale: string;               // kept for DB compat, no longer generated
}

// Bumped whenever SYSTEM_PROMPT (or extraction logic) changes shape. Stored alongside each
// classification — refresh.ts re-classifies anything written under an older version, so a
// prompt fix automatically reshapes the whole dataset on the next cron tick.
export const PROMPT_VERSION = 6;

// Attribution philosophy:
// - The LLM is asked to identify the affected release ONLY when the issue explicitly
//   mentions one, or it's obvious from a stack trace / log / "I'm running vX.Y.Z" line.
// - When unclear, return null. Unattributed issues are intentionally ignored by scoring
//   so that long-running open bugs don't drag down every release.
//
// Bias correction (v3): gpt-4o-mini still leaned hard on high+broad+core after v2
// (~55% of negatives ended up high+core, ~30% as broad). The model treats any bug
// touching a familiar word ("session", "gateway", "exec") as core, and any bug
// mentioning more than one platform name as broad. v3 adds explicit anti-inflation
// EXAMPLES with the correct labels — concrete patterns beat abstract anchors for
// small models. Also tightens the lead-in: "conservative by default, top rungs are RARE".
const SYSTEM_PROMPT = `You classify GitHub issues for the OpenClaw open-source project to estimate release stability.
Return ONLY a JSON object with these exact keys (no extra fields, no markdown):

{
  "sentiment":       "negative" | "positive" | "neutral",
  "severity":        "critical" | "high" | "medium" | "low",
  "scope":           "broad" | "moderate" | "niche",
  "functionality":   "core" | "integration" | "provider" | "docs",
  "affected_users":  "many" | "some" | "few" | "unknown",
  "workaroundStatus": "none" | "partial" | "confirmed" | "unknown",
  "duplicateCluster": "<kebab-slug>" | null,
  "affectsVersion":  "<exact-tag-from-known-list>" | null,
  "confidence":      0.0..1.0
}

BE CONSERVATIVE. When in doubt, pick the MIDDLE of each scale. The top rungs
(critical, high, broad, core, many) are RARE — they describe genuine showstoppers,
not "this looks bad." Most real-world bugs are medium/moderate/integration/some.

Triage labels alone (P1, impact:*, clawsweeper:*) are NOT evidence — they are
routing tags maintainers attach to almost every new bug, often before reproduction.
Look at the body and comments to judge the real impact.

SEVERITY anchors:
- "critical": confirmed data loss, security CVE, total outage of the gateway/CLI for
  users on default config. Do NOT use just because the title says "crash" — most crashes
  are condition-specific.
- "high": main flow broken under a common configuration; user-visible regression with
  no workaround. Default for confirmed bugs touching install/auth/chat/exec.
- "medium": bug under a specific setup, cosmetic regression, broken edge case, or
  any bug where a workaround is documented. THIS IS THE DEFAULT for routine bug reports.
- "low": typo, doc nit, log noise, very-niche edge case.

SCOPE anchors:
- "broad": affects users across multiple OSes / multiple providers / both CLI and UI.
- "moderate": affects one OS family, one major provider, or one surface (CLI-only,
  UI-only, gateway-only). DEFAULT for most bugs.
- "niche": one provider + one OS + one config combination, or behind a non-default flag.

FUNCTIONALITY anchors:
- "core": install, gateway boot, chat send/receive, session storage, auth, exec approval,
  the doctor command. The things that break "OpenClaw" itself.
- "integration": third-party surfaces — Telegram, Feishu, WebChat, Slack, IDE plugins,
  control UI. The chat works locally but a delivery channel is broken.
- "provider": specific model providers — Ollama, OpenAI, Anthropic, Codex, embeddings.
  The gateway works but one provider misbehaves.
- "docs": only documentation or examples.

AFFECTED_USERS anchors:
- "many": clearly reported by multiple distinct users in comments, OR default config on
  the most common platforms (macOS + Linux + Windows out of the box).
- "some": one OS family, one provider, one common config. DEFAULT when the reporter
  describes a real bug but you can't tell how widespread.
- "few": specific hardware, specific corporate proxy, specific exotic config.
- "unknown": no signal at all (issue is one line, no setup info, no comments).

SENTIMENT rules:
- Bug reports describing breakage → "negative".
- Feature requests, enhancements, "would be nice if…" → "neutral", EVEN IF the title
  says "[Bug]". Read the body. \`enhancement\` label or "Proposed solution" / "Alternatives
  considered" sections are strong signals of a feature request.
- Questions, support requests, "how do I…" → "neutral".
- Users explicitly saying something works well or thanking maintainers → "positive".

WORKAROUND:
- "confirmed": explicit working workaround or merged fix mentioned in the thread.
- "partial": workaround exists but is fragile, manual, or only works sometimes.
- "none": comments explicitly say no workaround is known.
- "unknown": no discussion of workaround either way. Use this freely.

duplicateCluster: short kebab-case tag for the underlying bug (e.g. "ollama-proxy-loopback").
Use the SAME tag for clearly duplicate issues. null if unique.

affectsVersion: set when the issue body, title, or comments mention a specific release
version. The mention can be in ANY of these forms — treat them all as equivalent:
  * "v2026.5.18", "2026.5.18", "OpenClaw 2026.5.18", "version 2026.5.18"
  * stack traces with the version
  * "Observed on X.Y.Z", "running X.Y.Z", "since X.Y.Z", "in X.Y.Z-beta.N"
Return the value as it appears in the known-tags list (e.g. always with the "v" prefix
if the canonical tag uses one). If the version mentioned doesn't match ANY known tag,
pick the closest one only if you're highly confident — otherwise return null.
Return null when no version is mentioned at all (e.g. "X is broken" with no version
context). Unattributed issues are dropped from scoring rather than dumped on the latest
release, so it's safe to be aggressive about matching when a version IS mentioned.

ANTI-INFLATION EXAMPLES (study these — they describe patterns small models get wrong):

1. "Discord / Telegram / Feishu / Slack / Mattermost / WhatsApp / iMessage X is broken"
   → functionality="integration" (NOT core), scope="moderate" at most (often "niche"
   if it's also platform- or config-specific). A channel adapter failing does NOT
   break OpenClaw's core gateway/CLI.

2. "Ollama / OpenAI / Anthropic / DeepSeek / MiniMax / xAI / Bedrock X returns Y"
   → functionality="provider" (NOT core), scope="moderate". One provider
   misbehaving doesn't break the gateway itself.

3. "Bug on macOS only" (or Windows-only, or Ubuntu-only) with no confirmation that
   other OSes are affected → scope="moderate" (NOT broad). "broad" requires
   EXPLICIT evidence of multi-OS or multi-provider impact in the body/comments.

4. "Happens with --experimental-X flag" / "when foo.bar=true" / "after running the
   alpha build" / "only in container with custom seccomp" → scope="niche" by
   definition. Non-default configurations are niche.

5. "Race condition / timing-dependent / intermittent / reproduces 1 in 20" →
   severity="medium" at most. Genuinely critical issues reproduce reliably.

6. "TypeScript type error in module X" / "ESLint warning" / "wrong return type
   in JSDoc" → severity="low", functionality usually "docs" or "integration".

7. "[Bug]: <feature title>" with body that has "Proposed solution" / "Alternatives
   considered" / "Why" sections → sentiment="neutral" (feature request mislabeled).
   Trust the BODY over the title prefix.

8. A single user describing a single setup, no "+1" or "me too" comments →
   affected_users="some" (NOT many). "many" requires multiple distinct reporters
   OR the breakage being in default config of macOS/Linux/Windows simultaneously.

9. "openclaw update / install / auth / gateway boot / chat send / session storage
   / exec approval is broken on default config" with reproducible steps and no
   workaround → THIS is the kind of bug that warrants high+core+broad. Not "Discord
   notifications duplicate". The former is a showstopper; the latter is annoying.

10. Bug that has a documented workaround in comments → workaroundStatus="confirmed",
    AND drop severity by one rung (a critical bug with workaround is at most high;
    a high bug with workaround is at most medium).

LABEL GUIDE — labels carry DIFFERENT KINDS of signal. Do NOT conflate them.

The openclaw repo uses an automation bot (ClawSweeper) that keyword-stamps
"impact:*" labels onto almost every issue based on whether the body mentions
"session", "message", "auth", "crash", etc. THESE LABELS ARE CATEGORIZATION,
NOT SEVERITY. A bug labelled "impact:session-state" tells you the bug TOUCHES
session handling, not that the bug is severe. Read the body and judge severity
from THERE.

CATEGORIZATION-SIGNAL labels — TRUST LEVELS DIFFER:

Trusted (event-based, set by maintainers OR triggered by rare specific keywords):
- impact:data-loss      → functionality "core" (data persistence event).
- impact:message-loss   → functionality "integration" (channel delivery).
- impact:auth-provider  → functionality "provider" (auth/model providers).

UNTRUSTED for functionality (keyword-stamped on ANY mention of the word —
massively over-applied; observed on ~60% of all issues including routine
UI nits that mention "session" or "crash"). Treat as NO signal — pick
functionality from the BODY anchors above, ignore these labels:
- impact:session-state  → IGNORE for functionality
- impact:crash-loop     → IGNORE for functionality
- impact:security       → IGNORE for functionality (BUT: if body actually
   describes a CVE, vulnerability, or auth-bypass, set functionality core
   on the BODY's evidence, not on this label)

Other label families (judge from body, but useful confirmation):
- "channel: telegram/feishu/discord/slack/whatsapp-web/..." → integration.
- "extensions: ollama/openai/anthropic/deepseek/..." → provider.
- "gateway" / "cli" / "commands" / "agents" → core.
- "docs" / "tui" alone → docs/integration.

For severity — ALWAYS judge from BODY regardless of impact:* labels:
critical only on confirmed showstopper, high on common-config break,
medium for routine bugs, low for edge cases.

SEVERITY-SIGNAL labels (rare, explicit human-set or fact-based — DO trust):
- impact:data-loss → severity "critical" (event: data has been/can be lost).
- P0               → severity "critical" (maintainer-declared emergency).
- beta-blocker     → severity "critical" (release-blocker).
- regression       → bump severity one rung (something that worked is broken).

SENTIMENT-SIGNAL labels (trust over title prefix):
- enhancement                       → sentiment "neutral" (feature request).
- bug / bug:behavior / bug:crash    → sentiment "negative" if body confirms.
- stale                             → sentiment "neutral" (stale).
- clawsweeper:not-repro-on-main     → sentiment "neutral" (bug gone on main).

CONFIDENCE-SIGNAL labels (verification status):
- clawsweeper:source-repro / clawsweeper:current-main-repro → confidence ≥ 0.9.
- clawsweeper:needs-info / clawsweeper:needs-live-repro     → confidence ≤ 0.5.

PURE NOISE (workflow routing, NO impact on classification):
- P1, P2, P3 (priority, attached automatically — DO NOT inflate severity).
- clawsweeper:no-new-fix-pr / :needs-maintainer-review / :needs-product-decision
  / :fix-shape-clear / :linked-pr-open / :queueable-fix / :automerge / :autofix.
- issue-rating: 🦞 / 🐚 / 🦀 / 🧂 / 🦐 / 🦪 / 🌊 (maintainer-internal quality).
- merge-risk:*, triage:*, status:*, size:*, proof:*, mantis:*, rating:* — these
  apply to PRs, not issues.

DEFAULTS WHEN GENUINELY UNCERTAIN (no clear signal in body/comments):
- severity: "medium"
- scope: "moderate"
- functionality: "integration" (unless the issue is explicitly about install / auth /
  gateway / chat / exec / session / doctor — those are core)
- affected_users: "some"
- workaroundStatus: "unknown"
- confidence: ≤ 0.6

confidence: lower (≤0.6) when the issue body is empty/one-liner, when labels and body
disagree, or when you had to guess scope/users from setup hints. Higher (≥0.8) only when
the body unambiguously describes impact, surface, and reproduction.`;

interface OpenAIResp {
  choices: { message: { content: string } }[];
}

function buildUserMessage(
  issue: GhIssue,
  comments: GhComment[],
  knownTags: string[],
): string {
  const body = (issue.body ?? '').slice(0, 3000);
  const recentComments = comments
    .slice(-10)
    .map((c) => `@${c.user?.login ?? 'unknown'}: ${(c.body ?? '').slice(0, 800)}`)
    .join('\n---\n');
  return [
    `Known release tags (most recent first): ${knownTags.slice(0, 15).join(', ') || '(none)'}`,
    '',
    `Issue #${issue.number} (${issue.state})`,
    `Title: ${issue.title}`,
    `Author: @${issue.user?.login ?? 'unknown'}`,
    `Created: ${issue.created_at}`,
    `Comments count: ${issue.comments}`,
    `Labels: ${issue.labels.map((l) => l.name).join(', ') || '(none)'}`,
    '',
    'BODY:',
    body || '(empty)',
    '',
    'RECENT COMMENTS:',
    recentComments || '(none)',
  ].join('\n');
}

// Map an LLM-returned version reference to a canonical known tag.
// LLMs sometimes drop the "v" prefix or vice versa; we accept both forms so a
// mention of "2026.5.7" still matches the canonical tag "v2026.5.7".
function resolveAffectsVersion(
  raw: string | null | undefined,
  knownTags: string[],
): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const candidate = raw.trim();
  if (!candidate) return null;
  if (knownTags.includes(candidate)) return candidate;
  const stripped = candidate.startsWith('v') ? candidate.slice(1) : candidate;
  for (const tag of knownTags) {
    const tagStripped = tag.startsWith('v') ? tag.slice(1) : tag;
    if (tagStripped === stripped) return tag; // return canonical form
  }
  return null;
}

export async function classifyIssue(
  issue: GhIssue,
  comments: GhComment[],
  knownTags: string[],
): Promise<IssueClassification> {
  if (!config.openai.apiKey) throw new Error('OPENAI_API_KEY is not set');

  const res = await fetch(`${config.openai.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openai.apiKey}`,
      // Ignored by OpenAI; OpenRouter uses them for its app attribution.
      'HTTP-Referer': 'https://isitstable.iclaw.digital',
      'X-Title': 'IsItStable',
    },
    body: JSON.stringify({
      model: config.openai.model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage(issue, comments, knownTags) },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as OpenAIResp;
  // Gateways (OpenRouter) can answer 200 with an upstream error and no choices.
  // Falling back to '{}' here would write a fully-default classification to the DB
  // as if it were real analysis — fail loudly instead so it counts as a failure.
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) {
    throw new Error(`LLM returned no content: ${JSON.stringify(data).slice(0, 300)}`);
  }
  let parsed: Partial<IssueClassification>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`LLM returned non-JSON: ${raw.slice(0, 200)}`);
  }

  const normalized = normalize(parsed);
  normalized.affectsVersion = resolveAffectsVersion(normalized.affectsVersion, knownTags);
  // Deterministic safety net on top of LLM output — maintainers' impact:* labels
  // and explicit signals (regression, P0, enhancement, stale, ClawSweeper repro
  // verdicts) override what the LLM came up with. See lib/labelOverrides.ts.
  const labelNames = issue.labels.map((l) => l.name);
  return applyLabelOverrides(normalized, labelNames);
}

function normalize(r: Partial<IssueClassification>): IssueClassification {
  const sentiments: Sentiment[] = ['negative', 'positive', 'neutral'];
  const severities: Severity[] = ['critical', 'high', 'medium', 'low'];
  const scopes: Scope[] = ['broad', 'moderate', 'niche'];
  const funcs: Functionality[] = ['core', 'integration', 'provider', 'docs'];
  const users: AffectedUsers[] = ['many', 'some', 'few', 'unknown'];
  const workarounds: WorkaroundStatus[] = ['none', 'partial', 'confirmed', 'unknown'];

  const oneOf = <T extends string>(val: unknown, allowed: T[], fallback: T): T =>
    allowed.includes(val as T) ? (val as T) : fallback;

  // Back-compat: older LLM responses might still send `hasWorkaround: true|false`.
  // Map them to the new enum so a re-prompt isn't strictly required.
  const wsRaw = (r as any).workaroundStatus
    ?? (typeof (r as any).hasWorkaround === 'boolean'
      ? ((r as any).hasWorkaround ? 'confirmed' : 'unknown')
      : undefined);

  return {
    sentiment: oneOf(r.sentiment, sentiments, 'neutral'),
    severity: oneOf(r.severity, severities, 'low'),
    scope: oneOf(r.scope, scopes, 'niche'),
    functionality: oneOf(r.functionality, funcs, 'integration'),
    affectedUsers: oneOf((r as any).affected_users ?? r.affectedUsers, users, 'unknown'),
    workaroundStatus: oneOf(wsRaw, workarounds, 'unknown'),
    duplicateCluster: normalizeCluster(r.duplicateCluster),
    affectsVersion:
      typeof r.affectsVersion === 'string' && r.affectsVersion.trim()
        ? r.affectsVersion.trim()
        : null,
    confidence: clamp01(typeof r.confidence === 'number' ? r.confidence : 0.5),
    rationale: typeof r.rationale === 'string' ? r.rationale.slice(0, 400) : '',
  };
}

// LLMs sometimes return the *word* "none" / "null" / "unique" instead of an
// actual JSON null when an issue has no duplicate cluster. The previous
// normaliser preserved those as valid cluster IDs, causing all such issues
// to be grouped into a fake "none" cluster and silently inflate via the
// duplicate boost. Treat these placeholders as null.
const CLUSTER_PLACEHOLDERS = new Set([
  'none', 'null', 'n/a', 'na', 'unique', 'no-cluster', 'no cluster',
  'no-duplicate', 'no duplicate', 'undefined', 'unknown',
]);

function normalizeCluster(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned) return null;
  if (CLUSTER_PLACEHOLDERS.has(cleaned)) return null;
  return cleaned;
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0.5;
  return Math.max(0, Math.min(1, x));
}
