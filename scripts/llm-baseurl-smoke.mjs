// Smoke test for OPENAI_BASE_URL routing: stands up a fake OpenAI-compatible
// endpoint, points the classifier at it, and asserts (a) the request lands on the
// configured base URL, (b) a normal choices[] response classifies, (c) a 200 with
// an upstream error and no choices throws instead of writing a default row.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const PORT = 8799;
let lastPath = null;
let lastAuth = null;
let mode = 'ok';

const server = createServer((req, res) => {
  lastPath = req.url;
  lastAuth = req.headers.authorization;
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'ok') {
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          sentiment: 'negative', severity: 'high', scope: 'moderate',
          functionality: 'integration', affected_users: 'some',
          workaroundStatus: 'none', duplicateCluster: null,
          affectsVersion: null, confidence: 0.8,
        }) } }],
      }));
    } else if (mode === 'no-choices') {
      // OpenRouter shape when the upstream provider fails but the gateway 200s.
      res.end(JSON.stringify({ error: { message: 'upstream provider error', code: 502 } }));
    } else {
      res.statusCode = 429;
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    }
  });
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

process.env.OPENAI_BASE_URL = `http://127.0.0.1:${PORT}/api/v1/`; // trailing slash on purpose
process.env.OPENAI_API_KEY = 'sk-or-v1-test';
process.env.OPENAI_MODEL = 'openai/gpt-4o-mini';
process.env.GITHUB_OWNER = 'openclaw';
process.env.GITHUB_REPO = 'openclaw';
process.env.DB_PATH = './data/smoke-llm.db';

const { classifyIssue } = await import('../dist/lib/llm.js');

const issue = {
  number: 1, title: '[Bug]: gateway drops Telegram replies', body: 'happens every run',
  state: 'open', labels: [], user: { login: 'someone' }, comments: 0,
  created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
  closed_at: null, html_url: 'https://github.com/openclaw/openclaw/issues/1',
};

// (a) + (b) happy path through the configured base URL
const cls = await classifyIssue(issue, [], ['v2026.6.34']);
assert.equal(lastPath, '/api/v1/chat/completions', 'must hit configured base URL, slash-normalized');
assert.equal(lastAuth, 'Bearer sk-or-v1-test');
assert.equal(cls.sentiment, 'negative');
assert.equal(cls.severity, 'high');

// (c) 200-with-error-and-no-choices must throw, not silently default
mode = 'no-choices';
await assert.rejects(
  () => classifyIssue(issue, [], ['v2026.6.34']),
  /LLM returned no content/,
  'a gateway 200 with no choices must fail loudly, not write a default classification',
);

// (d) non-2xx surfaces the status
mode = 'http-error';
await assert.rejects(() => classifyIssue(issue, [], ['v2026.6.34']), /LLM 429/);

server.close();
console.log('llm base-url smoke: OK (routing, auth, happy path, no-choices guard, http error)');
