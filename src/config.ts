import 'dotenv/config';

function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing env var: ${key}`);
  return v;
}

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`Invalid number for ${key}: ${raw}`);
  return n;
}

function intInRange(key: string, fallback: number, min: number, max: number): number {
  const n = num(key, fallback);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${key} must be an integer in [${min}, ${max}], got ${n}`);
  }
  return n;
}

export const config = {
  github: {
    owner: env('GITHUB_OWNER', 'openclaw'),
    repo: env('GITHUB_REPO', 'openclaw'),
    token: process.env.GITHUB_TOKEN || '',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: env('OPENAI_MODEL', 'gpt-4o-mini'),
    // Any OpenAI-compatible /chat/completions endpoint works here — e.g.
    // https://openrouter.ai/api/v1 (OpenRouter model ids are namespaced:
    // "openai/gpt-4o-mini"). Trailing slashes are trimmed so both forms work.
    baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
  },
  server: {
    port: num('PORT', 8787),
  },
  db: {
    path: env('DB_PATH', './data/radar.db'),
  },
  refresh: {
    // Minutes between automatic refreshes. Hard-bounded 1..600 so an env-var typo
    // can't accidentally hammer GitHub / OpenAI every second, and can't silently
    // stop refreshes by being set to 0.
    intervalMinutes: intInRange('REFRESH_MINUTES', 30, 1, 600),
  },
  limits: {
    releases: num('RELEASES_LIMIT', 10),
  },
} as const;
