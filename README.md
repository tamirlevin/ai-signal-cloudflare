# AI Signal on Cloudflare Workers

A standalone Cloudflare Worker and D1-backed reader for AI Signal. It presents a static, wide desktop-first reader at `/`, a distinct `/history` route, an unlinked owner surface at `/admin`, and keeps editorial data as one JSON edition instead of generating HTML per issue.

Live reader: [ai-signal-cloudflare.tamirlevin.workers.dev](https://ai-signal-cloudflare.tamirlevin.workers.dev/)

The compatibility date is pinned to `2026-08-11`. Move it forward with a tested Wrangler/workerd update.

## What it does

- Fetches only the newest item in `https://news.smol.ai/rss.xml` for a standard run.
- Decodes the issue HTML, captures its exact direct `href` values, and gives those links to one structured Workers AI synthesis call.
- Rejects an edition if any story or source URL was not supplied by AInews. The RSS issue URL and publication date are source-derived.
- Compacts each long issue into an 18-block, profile-aware candidate inventory, retaining priority material plus a diversity sample.
- Builds Hot Topics and individual signal cards deterministically from that inventory, so one candidate becomes at most one source-bound card. Workers AI writes only the cross-story synthesis.
- Uses `@cf/openai/gpt-oss-120b` normally and switches once to `@cf/zai-org/glm-4.7-flash` only when the primary model times out.
- Ships with AI Signal Profile v2 as its empty-database default: up to 14 qualified candidates without padding, seven stories shown by default, category weights, watched topics, and rare exceptional-story override. Saved D1 profiles advance independently.
- Stores a validated edition JSON plus its profile snapshot in D1. The last 15 successfully published editions are retained; failed runs only create a run record and cannot replace the last good edition.
- Persists sparse personal overrides in the viewer's browser only and applies them to current and historical editions. No name, email, click history, or account is stored.
- Supports portable tuning links in the URL fragment. Imported settings remain a preview until the recipient explicitly accepts them.
- Keeps global profile updates and manual refresh under `/admin`; both mutations still require the owner token, which is used for one request and never persisted by the browser.

## Personal and global controls

`Personalise` changes only the current browser. It can save, reset, or copy a tuning link; none of those actions call the profile-write API. Each stored edition retains the global profile that generated it. The latest reader applies the active global profile to that stored candidate inventory, while historical edition links retain their original profile snapshot. Synthesis remains the shared editorial view while Hot Topics and All Signals can be personally re-ranked.

`/admin` is deliberately absent from public navigation. Knowing its URL does not grant authority: `PUT /api/profile` and `POST /api/refresh` require `ADMIN_TOKEN`. A saved global profile is used by future generation runs; it does not rewrite stored editions.

The reader shows the latest collector check, the brief generation time, and the daily scheduled check time. `GET /api/status` exposes only that non-sensitive operational summary.

## Local setup

```bash
npm install
npm run types
cp .dev.vars.example .dev.vars
npm run dev
```

Create `.dev.vars` locally (it is ignored by Git):

```text
ADMIN_TOKEN=choose-a-long-random-value
```

Create and apply the local D1 schema:

```bash
npx wrangler d1 create ai-signal
# Put the returned database_id into wrangler.jsonc.
npx wrangler d1 migrations apply ai-signal --local
```

`AI_MODEL` defaults to `@cf/openai/gpt-oss-120b`, with `@cf/zai-org/glm-4.7-flash` as a one-time timeout fallback. Before inference, the collector deterministically ranks and compacts the issue to 18 profile-aware candidates while retaining exact source links. It also materializes the story inventory itself; the model receives the ranked candidates only to produce synthesis and presentation copy. Output is capped at 3,200 tokens. GPT-OSS uses Workers AI structured JSON mode; GLM receives the same strict JSON contract in the prompt. Set `AI_GATEWAY_ID` to an existing gateway ID to route the Workers AI binding through that gateway; leave it empty to call the binding directly. No provider API key is used or stored.

## Deploy runbook

1. Confirm the `ai-signal` D1 binding and database ID in `wrangler.jsonc` are the intended production database.
2. Apply the migration remotely: `npx wrangler d1 migrations apply ai-signal --remote`.
3. Set the secret: `npx wrangler secret put ADMIN_TOKEN`.
4. Optionally set non-secret `AI_GATEWAY_ID` and `AI_MODEL` in the dashboard or config.
5. Verify configuration with `npm run types`, `npm run typecheck`, `npm test`, and `npm run dry-run`.
6. Deploy only after review: `npx wrangler deploy`.

The project deliberately has no automatic resource provisioning or deployment command in this repository.

## Schedule and DST

The configured Cloudflare cron is `15 22 * * *` (UTC). It fires at 08:15 in Melbourne during AEST (UTC+10), and at 09:15 during AEDT (UTC+11). Cloudflare cron has no Melbourne timezone setting. D1 idempotency means a manually triggered or repeated run for the same AInews issue is safely skipped.

The scheduled handler directly awaits generation. In non-production local development only, `/__scheduled` is protected by `ADMIN_TOKEN`; production returns 404 for that route.

## API

Public same-origin endpoints:

- `GET /api/health`
- `GET /api/editions`
- `GET /api/editions/latest`
- `GET /api/editions/:YYYY-MM-DD`
- `GET /api/profile`

Owner-only endpoints (use `Authorization: Bearer <ADMIN_TOKEN>`):

- `POST /api/refresh`
- `PUT /api/profile`

All API responses use security headers and do not set cross-origin CORS permissions. The admin token is never returned or persisted by the UI. The public tuning workflow never sends personal preferences to the Worker.

## Tests

`npm test` covers structured-edition validation, trusted-link enforcement, duplicate-link rejection, first-item RSS parsing, API authentication, and production scheduled-route blocking. `npm run types` generates the Worker binding type definition from `wrangler.jsonc`; do not hand-write `Env`.
