import fs from 'node:fs';
import assert from 'node:assert/strict';

const htmlPath = new URL('../public/index.html', import.meta.url);
const fixturePath = new URL('../fixtures/public-api-live-sample.json', import.meta.url);
const html = fs.readFileSync(htmlPath, 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
if (!script) throw new Error('Could not find inline app script in public/index.html');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

const harness = `
const fixture = ${JSON.stringify(fixture)};
publicReleaseDetails = new Map((fixture.releases ?? []).map((r) => [r.tag, r]));
allReleases = (fixture.releases ?? []).map((r) => ({
  tag: r.tag,
  publishedAt: r.publishedAt,
  finalScore: r.score,
  status: r.status,
  recommended: r.recommended,
  reason: r.reason,
  brokenSurfaces: r.brokenSurfaces ?? [],
}));
chartReleases = allReleases.map((r) => ({ tag: r.tag, publishedAt: r.publishedAt, score: r.finalScore, status: r.status }));

function bucketFor(currentTag, targetTag, selected = ['Linux', 'Discord', 'OpenAI']) {
  selectedCurrentTag = currentTag;
  selectedProfileSurfaces = new Set(selected);
  const target = allReleases.find((r) => r.tag === targetTag);
  if (!target) throw new Error('Missing target ' + targetTag);
  const buckets = upgradePathBuckets(target);
  return {
    state: buckets.state,
    evidenceLimited: buckets.evidenceLimited,
    newRisks: buckets.newRisks?.map((i) => i.number) ?? [],
    fixedByUpgrade: buckets.fixedByUpgrade?.map((i) => i.number) ?? [],
    possibleFixes: buckets.possibleFixes?.map((i) => i.number) ?? [],
    stillPresent: buckets.stillPresent?.map((i) => i.number) ?? [],
    unclear: buckets.unclear?.map((i) => i.number) ?? [],
    currentRows: buckets.currentDetailState?.issueCount ?? null,
    targetRows: buckets.targetDetailState?.issueCount ?? null,
    summary: upgradePathSummaryText(buckets, target),
    html: upgradePathHtml(target),
  };
}

function releaseIssues(tag) {
  return (fixture.releases ?? []).find((r) => r.tag === tag)?.issues ?? [];
}

function seedServerUpgrade(currentTag, targetTag) {
  selectedCurrentTag = currentTag;
  selectedProfileSurfaces = new Set(['Linux', 'Discord', 'OpenAI']);
  const currentIssues = releaseIssues(currentTag);
  const targetIssues = releaseIssues(targetTag);
  upgradePathDetails.set(upgradePathCacheKey(currentTag, targetTag), {
    state: 'ready',
    source: 'server-classified-attribution',
    current: { tag: currentTag, relevantIssueCount: 123, classifiedIssueCount: 123, rawIssueCount: 123 },
    target: { tag: targetTag, relevantIssueCount: 456, classifiedIssueCount: 456, rawIssueCount: 456 },
    itemLimit: 25,
    evidenceLimited: false,
    buckets: {
      newRisks: {
        total: 13,
        quality: { confirmed: 10, unverified: 3, riskUnits: 8.4 },
        items: targetIssues.slice(0, 3),
      },
      fixedByUpgrade: {
        total: 3,
        quality: { confirmed: 3, unverified: 0, riskUnits: 2.8 },
        items: currentIssues.slice(0, 2).map((i, idx) => ({
          ...i,
          state: 'closed',
          closedAt: idx === 0 ? '2026-05-29T12:00:00Z' : '2026-05-30T12:00:00Z',
        })),
      },
      possibleFixes: { total: 0, quality: { confirmed: 0, unverified: 0, riskUnits: 0 }, items: [] },
      stillPresent: {
        total: 2,
        quality: { confirmed: 2, unverified: 0, riskUnits: 1.8 },
        items: targetIssues.slice(3, 5),
      },
      unclear: {
        total: 1,
        quality: { confirmed: 0, unverified: 1, riskUnits: 0.3 },
        items: targetIssues.slice(5, 6),
      },
    },
  });
}

seedServerUpgrade('v2026.5.19', 'v2026.5.28');
const near = bucketFor('v2026.5.27', 'v2026.5.28');
upgradePathDetails.set(upgradePathCacheKey('v2026.5.18', 'v2026.5.28'), {
  state: 'ready',
  source: 'server-classified-attribution',
  current: { tag: 'v2026.5.18', relevantIssueCount: 10, classifiedIssueCount: 10, rawIssueCount: 20 },
  target: { tag: 'v2026.5.28', relevantIssueCount: 11, classifiedIssueCount: 11, rawIssueCount: 30 },
  itemLimit: 25,
  evidenceLimited: true,
  buckets: {
    newRisks: { total: 1, items: releaseIssues('v2026.5.28').slice(0, 1) },
    fixedByUpgrade: { total: 0, items: [] },
    possibleFixes: { total: 0, items: [] },
    stillPresent: { total: 0, items: [] },
    unclear: { total: 0, items: [] },
  },
});
upgradePathDetails.set(upgradePathCacheKey('v2026.5.27', 'v2026.5.28'), {
  state: 'ready',
  source: 'raw-unclassified-attribution',
  current: { tag: 'v2026.5.27', relevantIssueCount: 64, classifiedIssueCount: 0, rawIssueCount: 324 },
  target: { tag: 'v2026.5.28', relevantIssueCount: 144, classifiedIssueCount: 0, rawIssueCount: 407 },
  itemLimit: 25,
  evidenceLimited: true,
  buckets: {
    newRisks: { total: 80, items: releaseIssues('v2026.5.28').slice(0, 3) },
    fixedByUpgrade: { total: 0, items: [] },
    possibleFixes: { total: 0, items: [] },
    stillPresent: { total: 64, items: releaseIssues('v2026.5.27').slice(0, 3) },
    unclear: { total: 0, items: [] },
  },
});
globalThis.__upgradeSmoke = {
  tags: allReleases.map((r) => r.tag),
  recommendationMargin: {
    wideDelta: pickGeneralRecommendedRelease([
      { tag: 'newer-but-weaker', status: 'eligible', finalScore: 5.8, recommended: true, advisories: { affected: { total: 0 } } },
      { tag: 'older-but-much-stronger', status: 'eligible', finalScore: 8.1, recommended: false, advisories: { affected: { total: 0 } } },
    ])?.tag,
    closeDelta: pickGeneralRecommendedRelease([
      { tag: 'newer-close-enough', status: 'eligible', finalScore: 7.4, recommended: true, advisories: { affected: { total: 0 } } },
      { tag: 'older-slightly-stronger', status: 'eligible', finalScore: 8.1, recommended: false, advisories: { affected: { total: 0 } } },
    ])?.tag,
  },
  modern: bucketFor('v2026.5.19', 'v2026.5.28'),
  near,
  partial: bucketFor('v2026.5.18', 'v2026.5.28'),
  raw: bucketFor('v2026.5.27', 'v2026.5.28'),
  same: bucketFor('v2026.5.28', 'v2026.5.28'),
};
`;

const store = {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.document = { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null };
globalThis.window = { addEventListener: () => {}, scrollTo: () => {} };
globalThis.location = { hash: '#/openclaw' };
globalThis.setInterval = () => {};
globalThis.fetch = () => new Promise(() => {});

(0, eval)(`${script}\n${harness}`);
const result = globalThis.__upgradeSmoke;

assert.equal(result.recommendationMargin.wideDelta, 'older-but-much-stronger');
assert.equal(result.recommendationMargin.closeDelta, 'newer-close-enough');
assert.equal(result.modern.state, 'ready');
assert.equal(result.modern.evidenceLimited, false);
assert.equal(result.modern.currentRows, 123);
assert.equal(result.modern.targetRows, 456);
assert.ok(result.modern.newRisks.length > 0, 'expected new risks for v2026.5.19 → v2026.5.28');
assert.equal(result.modern.fixedByUpgrade.length, 2, 'expected server-backed fixed issue rows');
assert.ok(result.modern.stillPresent.length > 0, 'expected at least one already-exposed issue');
assert.match(result.modern.summary, /10 confirmed risks/);
assert.match(result.modern.summary, /3 unverified reports/);
assert.doesNotMatch(result.modern.summary, /timestamp-confirmed/);
assert.match(result.modern.summary, /3 closed before target publish/);
assert.doesNotMatch(result.modern.summary, /limited|coverage|proof|classified attribution/i);
assert.match(result.modern.html, /Risks newly seen in target evidence/);
assert.match(result.modern.html, /Fixed/);
assert.doesNotMatch(result.modern.html, /Evidence source|Evidence coverage|not proof|limited evidence|limited coverage/i);
assert.match(result.modern.html, /Known risks still present/);
assert.doesNotMatch(result.near.summary, /missing rows|not proof|limited|coverage/i);
assert.equal(result.partial.evidenceLimited, true);
assert.doesNotMatch(result.partial.summary, /classification coverage|empty buckets|not proof|limited/i);
assert.doesNotMatch(result.partial.summary, /limited for ,/);
assert.equal(result.raw.evidenceLimited, true);
assert.match(result.raw.summary, /no confirmed risks/);
assert.doesNotMatch(result.raw.summary, /many/);
assert.match(result.raw.summary, /80 unverified reports/);
assert.match(result.raw.summary, /0 closed before target publish/);
assert.doesNotMatch(result.raw.summary, /limited raw triage evidence|not proof|coverage/i);
assert.doesNotMatch(result.raw.summary, /limited for ,/);
assert.doesNotMatch(result.raw.html, /raw timing rows shown/);
assert.doesNotMatch(result.raw.html, /Raw issue rows are bucketed by timing|Evidence coverage|not proof/i);
assert.equal(result.same.state, 'same');
assert.match(result.same.summary, /selected current version/);
assert.equal((html.match(/Evidence is best available, not exhaustive/g) || []).length, 1);
assert.doesNotMatch(html, /Related issues|related issues|Reported affected areas:/);
assert.match(html, /Relevant issues|Relevant watch areas/);

console.log(JSON.stringify({
  fixture: fixture._fixture,
  modern: { ...result.modern, html: undefined },
  near: { ...result.near, html: undefined },
  partial: { ...result.partial, html: undefined },
  same: result.same,
}, null, 2));
