# AI Signal on Cloudflare Workers

AI Signal is a D1-backed daily AI briefing and reader deployed as one Cloudflare Worker. It serves the latest edition at `/`, history at `/history`, and an unlinked owner surface at `/admin`. Editorial data is stored as validated JSON rather than generated HTML.

Live reader: [signal.tamirlevin.dev](https://signal.tamirlevin.dev/)

## Repository and deployment flow

The repository is the durable source of truth for code, configuration, operating rules, and consequential history. Commit and push reviewed source before deploying it, then verify the Worker and D1 state against that Git SHA.

```mermaid
flowchart LR
  A[Public feeds + profile] --> B[Deterministic collector] --> C[Ranked daily pool]
  C --> D[git commit] --> E[GitHub main]
  E --> F[Wrangler deploy] --> G[Worker + D1] --> H[Public reader]
```

See [PROJECT_HISTORY.md](PROJECT_HISTORY.md) for decisions, incidents, production evidence, and the ranked enhancement queue. Agent sessions cold-boot from [AGENTS.md](AGENTS.md); chat history, handoffs, and agent memory are hints until verified.

The compatibility date is pinned to `2026-08-11`. Move it forward only with a tested Wrangler/workerd update.

## Daily edition pipeline

Every run targets the current `Australia/Melbourne` calendar day. A normal refresh is idempotent for that date, so a repeated run skips after a successful edition already exists.

The code-defined `core-ai` source pack v9 checks:

- TLDR AI, AlphaSignal, and MTS Situations as equal editorial discovery inputs;
- AI Brief (daily runs API) as an equal discovery input carrying pre-triaged community signal (Hacker News, InfoQ, practitioner blogs);
- Cloudflare Agents as a narrow primary-evidence lane;
- AInews, which stays defined in the pack but is disabled (`enabled: false`) because its feed published nothing after 10 September 2026; flip the flag to test it again; and
- future feeds under the same timestamp, evidence, and ranking rules—never through source seniority.

The collector then:

1. Parses each source independently. One failed or quiet feed does not block usable candidates from another. TLDR recruitment/promotional entries are excluded using headline labels, summary calls to action, and recruitment destinations before ranking; editorial discussion of jobs or hiring remains eligible.
2. Qualifies and deduplicates the normal 48-hour pool. If fewer than 10 candidates qualify, expands once to 72 hours using the same collected inputs and eligibility rules. Items inside 36 hours receive a small freshness preference, tapering to zero at 48 hours; older fallback items receive no freshness boost. Nothing older than 72 hours is eligible.
3. Requires a usable non-social HTTPS evidence URL. X/Twitter is not collected as a source, cannot become a published card, and does not count as corroboration.
4. Merges duplicate URLs, fuzzy-title matches, and product-version matches into one cluster.
5. Ranks clusters by profile fit, freshness, evidence quality, and capped independent editorial corroboration. Agreement is discovery context, never proof.
6. Applies only a gentle diversity tie-break: when adjacent candidates are within four points, a different lead source may move ahead. There are no source quotas or per-feed publication caps.
7. Keeps at most 18 model candidates and publishes at most 14 cards. Weak candidates never fill a target; a quiet day remains quiet.

The deterministic collector creates the story inventory, Hot Topics, source URLs, provenance, and individual signal dates. Workers AI receives only that bounded inventory and writes presentation copy plus cross-story synthesis. The model cannot add stories or URLs. Every generated edition is validated against the collector's permitted URL catalogue before D1 is changed.

AlphaSignal uses its small Google News sitemap rather than its unbounded historical sitemap. The collector reads `news:publication_date` and `news:title`, retains `lastmod` and URL-title parsing only for legacy compatibility, and enriches at most eight recent articles in parallel. Sitemap, parse, and individual enrichment errors are labelled separately; there is no retry on the daily critical path.

MTS Situations uses its public JSON briefing in one bounded request, with no article crawling or extra model call. Only `confirmed`/`developing` stories with a usable non-social evidence link become candidates; X-only stories are excluded under the unchanged no-X-cards rule. Lifecycle, timestamp, and evidence filtering happen before ranking; empty or unrecognized output degrades this source report without blocking other sources.

Immediately before storage, one best-effort editorial QA call reviews the finished draft against the same candidate inventory. It can correct presentation and synthesis only; story cards, ranking, dates, profile, and collection metadata stay unchanged. The review looks for leaked drafting notes, promotional content, contradictions, unsupported claims, and story/citation mismatches. Corrections must pass the existing validation without automatic source substitution. This is an evidence-consistency check, not independent fact verification.

The issue header is the edition date, not a source date. Each signal retains its feed publication date. Historical AInews-base editions remain readable under backward-compatible validation.

## Failure and observability behavior

- A source failure degrades the source report but does not fail a run when other qualified candidates remain.
- If no qualified candidate exists even inside 72 hours, the run fails without publishing an empty or padded edition; the last good edition remains live. Ten is the expansion threshold, not a guaranteed minimum or a new publication cap.
- Editorial generation makes at most one call to each configured model: `@cf/openai/gpt-oss-120b`, then non-reasoning `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, then paid `@cf/moonshotai/kimi-k2.6`. Timeouts, invalid JSON, validation failures, and output-length stops switch models immediately rather than repeating the same request.
- Reasoning models receive a 6,000-token completion allowance; Llama receives a 3,200-token non-reasoning allowance. If all three calls fail, conservative deterministic framing is built from the already validated collector inventory so a healthy source run can still publish without model-authored claims or URLs.
- Each completed run stores a bounded JSON audit of its attempts, including model, outcome, duration, finish reason, completion/reasoning tokens, and response length when available. Output-length exhaustion is classified separately as `MODEL_OUTPUT_TRUNCATED`.
- Editorial QA adds at most one separate call to the configured Llama fallback model, with a 3,200-token allowance and 20-second waiting limit, after either model or deterministic framing succeeds. There are no QA retries. Invalid corrections, provider errors, or timeout publish the original validated draft with a warning; a cheap leaked-note check also flags unresolved internal copy. The waiting limit does not cancel provider inference. Skipped daily runs do not invoke QA.
- QA outcomes (`passed`, `corrected`, or `fallback`), bounded unresolved warnings, model, issue URL, and duration appear in existing Worker logs under `ai-signal editorial QA`, separately from the D1 generation-attempt audit. Card-level concerns are warnings only, never automatic removals. No extra schedule, notification service, or database migration is involved.
- Failed runs are audit records only and cannot replace the last good edition.
- The legacy D1 table `supplemental_shadow_runs` and endpoint `GET /api/shadow/latest` carry the latest source report. `report.mode="daily-pool"` records transport/parser health separately from candidate yield. Each source has a compact accepted → in-window → qualified → selected funnel, with outside-window, missing-evidence, weak-fit, merge, and ranked-out counts. The report also records the actual 48- or 72-hour window, eligible counts, and selected candidates. The edition's coverage label and `collection.maxFreshnessHours` reflect the same window. The reader has no separate fresh-signals section.
- Every selected candidate is accounted before publication: published cards, recorded merges (`duplicate-url`, `duplicate-title`, `duplicate-text`, `product-version` with the surviving target), or invalid rejections with reasons. Any other loss throws a coverage gap that fails the run loudly instead of publishing silently; the decision record is logged per run.
- `TRIAGE_SHADOW_ENABLED=true` adds the advisory reranker judge (full-precision raw scores, weighted maximum over per-interest queries, winning interest logged) without gating anything. `JEV_SHADOW_ENABLED=true` (requires the `TYPESAFE_API_KEY` secret) adds the advisory Jev judge in the same shadow runs: an interest choice over reader interests plus watching topics, pre-today novelty, substantive scoring, and a separate reader-want score. Jev question sets carry a version, an exact prompt snapshot, and a fingerprint that ignores the daily prior-title list, so a reworded question is a new set even if the version string was not bumped.
- Each shadow run also writes every Jev score to the durable `jev_judgments` ledger (one row per story per question fingerprint; first non-null score kept, later sightings refresh the gate outcome and flags, and `ever_published` records whether the story reached that day's live edition). Shadow reports are pruned to 15 rows; the ledger is not. Ledger writes are best-effort and never fail a run.
- `CLEF_SHADOW_ENABLED=true` adds Cloudflare's Clef decision model (`CLEF_SHADOW_MODEL`: `clef`, the default, or `clef-flash`) as a third advisory judge on Workers AI. It follows Jev's System One request shape, so it answers the same versioned question set. Scores go to the durable `clef_judgments` table (migration 0011), one row per story, question fingerprint and model, first score kept; stories already scored are skipped. It runs in the same shadow path as Jev, never fails a run, changes no selection, and needs no outside vendor. The staging-only, owner-token `POST /__clef-backfill?limit=N` scores ledger stories that have no Clef row yet, labelled stories first, so Clef can be compared with Jev on existing labels.
- In `/admin`, **Jev and taste review** compares three judges on your labels: the rules, the free Workers AI reranker, and Jev. Each judge's counterfactual pick is the top K stories by its own score, where K is how many the rules selected; for Jev the score is `reader_wants`, for the reranker the raw relevance. The **paired sample** is mostly the stories where the picks disagree. Within each disagreement side, stories whose `reader_wants` sits clearly away from Jev's cut (the midpoint between its K-th and (K+1)-th score) are drawn first, at random, and near-ties only fill what clear ones cannot; it adds one anchor from each agreement side and up to two repeats of stories you labelled at least three days earlier, which measure your own consistency. The **dropped pool** is up to 40 stories the rules dropped that you have not judged in that mode, and says whether it is a full census. Labels are made blind: the batch API withholds every score, the gate outcome, the judge picks and the sample group until the batch is saved. The two modes are separate frames (in the dropped pool you know the rules rejected every story), so a story is voted once per mode, the two are counted apart and never pooled in one estimate, and a story labelled in one mode can still be offered in the other. Every label records the judge picks and cell computed over its whole run, because shadow reports are pruned. Saves are guarded against double-counting. Ranking your publish choices is a separate optional step.
- **How Jev is doing** reports the bar the owner confirmed on 29 September 2026; your own consistency; Jev versus the rules on paired-sample disagreements, clear (margin 0.08 or more) and all, with "unsure" both excluded and read as "would not add"; the three judges on identical paired-sample stories with an exact sign test on the stories where two judges differ (a judge that never scored a story is left out for that story, not counted as saying no); anchors; what the rules drop, from the dropped pool alone and split by whether Jev would have picked the story; AUC of `reader_wants` and of the reranker's raw score; and rank correlation. The sign test and the AUC hold within the sample, which is drawn from disagreements: use them to compare judges, not as absolute accuracy. Rules-selected stories Jev failed to score are counted, not silently dropped. None of this changes an edition. Under the bar sits **Clef versus Jev**, locked by design: until both labelled frames (paired-sample stories where the rules and Jev disagree, and the dropped pool) hold 40 decided stories under one question set (the active profile's fingerprint; labels made under another are set aside and counted, so a profile change restarts the sample visibly), the API and page show only counts, and nothing derived from a Clef score is computed, so the comparison cannot be tuned while it is read. Once open it reports each judge's dropped-pool separation and who is right where the two differ, against the bar fixed before any Clef score was read (`src/clef-analysis.ts`). It rebuilds each run's pool from the retained shadow report, so labels from pruned runs drop out of it. The earlier binary disagreement queue is retired from the page; its endpoints and rows remain as legacy data.
- `GET /api/status` separates the latest run outcome from the latest completed cron heartbeat. The reader alerts after 26 hours without a completed cron check; a timely idempotent skip is a healthy heartbeat.

`SUPPLEMENTAL_SHADOW_ENABLED=true` keeps the read-only source report refreshed when a same-day edition causes generation to skip. It does not create another publication path.

## Reader, profiles, and privacy

AI Signal ships with Profile v2 as its empty-database default; the active production profile can advance independently in D1. The reader shows seven stories by default and allows up to 14 qualified cards without padding.

Production profile v7 retains v6's 14-story budget and other preferences, with coding craft at 3, new systems at 3, and research at 2. These are ranking weights, not category quotas. Read `/api/profile` for current truth; historical editions retain their own profile snapshot.

`Personalise` stores sparse ranking overrides in the current browser only. Tuning links carry preferences in the URL fragment and remain previews until explicitly accepted. Synthesis stays shared while Hot Topics and All Signals can be re-ranked locally.

`/admin` is absent from public navigation. `PUT /api/profile`, `POST /api/refresh`, and `GET /api/visits` require `ADMIN_TOKEN`. The token is used for one request and is never stored by the browser. The optional `POST /api/refresh?republish=1` replaces today's edition and is limited to one successful owner-initiated republish per Melbourne day; failed attempts release the claim.

The public reader records at most one anonymous browser/day visit in D1 with an opaque key, UTC day, path, timestamp, and Cloudflare-provided coarse location. It does not store raw IP addresses, names, clicks, or reading time. Entries are retained for 30 days.

## Local setup

```bash
npm ci
npm run types
cp .dev.vars.example .dev.vars
npm run dev
```

Run `npm ci` independently in each checkout and on every machine. `node_modules` contains architecture-specific `workerd` and test-runner binaries and is not portable between Intel and Apple Silicon Macs, even when the checkout itself is synchronized through Dropbox. The lockfile keeps package versions reproducible; never sync `node_modules` between machines.

Create the ignored `.dev.vars` with `ADMIN_TOKEN`. For a new local D1 database:

```bash
npx wrangler d1 create ai-signal
npx wrangler d1 migrations apply ai-signal --local
```

No provider API key is stored. `AI_GATEWAY_ID` may name an existing Workers AI gateway; leave it empty to call the binding directly.

## Verification and deployment

Before a code or configuration release:

```bash
npm run check
npm run dry-run
git diff --check
```

Then follow [AGENTS.md](AGENTS.md): push the reviewed commit to `main`, record the current deployment as rollback evidence, deploy with strict configuration and Git provenance, verify public and D1 state, and record consequential evidence in [PROJECT_HISTORY.md](PROJECT_HISTORY.md). No D1 migration is needed for the v9 pool; historical 48-hour and legacy editions remain readable.

The configured cron is `15 22 * * *` UTC: 08:15 Melbourne during AEST and 09:15 during AEDT. Cloudflare cron has no Melbourne timezone setting.

## Staging environment

`env.staging` in `wrangler.jsonc` deploys the same worker to `testsignal.tamirlevin.dev` with its own D1 database (`ai-signal-staging`), its own `ADMIN_TOKEN` secret, and an 8-hour test schedule (`15 */8 * * *` UTC) instead of the daily production cron:

```bash
npx wrangler deploy --env staging --tag git-<short-sha>-staging --message "Git <full-sha>; <summary>"
```

Staging exists so experiment branches run against real Cloudflare egress without touching production data, schedule, or spend: the 8-hour cadence yields same-day idempotent skips plus fresh shadow/funnel reads, and any extra generation is an explicit owner `POST /api/refresh`. `ENVIRONMENT=staging` unlocks the `/__scheduled`, `/__shadow`, `/__jev-probe`, and `/__clef-backfill` test routes. Promote to production only by merging to `main` and following the release rules in [AGENTS.md](AGENTS.md). The owner's Jev labels can be read back against the rules, the reranker, and Jev with the read-only queries in [scripts/label-readout.sql](scripts/label-readout.sql).

## API

Public same-origin endpoints:

- `GET /api/health`
- `GET /api/status`
- `GET /api/editions`
- `GET /api/editions/latest`
- `GET /api/editions/:YYYY-MM-DD`
- `GET /api/profile`
- `GET /api/shadow/latest`

Owner-only endpoints:

- `POST /api/refresh` (normal daily generation; add `?republish=1` only for the guarded replacement path)
- `PUT /api/profile`
- `GET /api/visits?limit=50`
- `GET /api/jev-disagreements` (open Jev/gate disagreements from the latest shadow run)
- `POST /api/jev-verdicts` (`{ story_url, verdict: 1 | -1 }`, snapshotted server-side)
- `GET /api/jev-review-batch?mode=paired|dropped` (admin-only sample from the latest versioned Jev run; optional `run_id` reopens a saved batch; scores, picks, and sample groups are withheld until saved)
- `POST /api/jev-labels` (admin-only publish/reject/unsure labels for a whole batch, appended with the run, question fingerprint, cell sizes, and snapshot)
- `POST /api/jev-labels/ranks` (admin-only ranking of that run's publish choices)
- `GET /api/jev-analysis` (admin-only summary of the labels and the ledger)
- `GET /api/jev-verdicts/stats` (legacy disagreement-set agreement counts; no promotion threshold)

All API responses use security headers and do not enable cross-origin access. The Worker is attached only to `signal.tamirlevin.dev`; `workers.dev` is disabled.

## Tests

`npm test` covers source-pack policy, feed parsers, conditional 48/72-hour windows and their boundaries, source-402 fail-open generation, X exclusion, equal-source clustering, corroboration, gentle diversity, no quotas/no padding, candidate merge-decision accounting and coverage enforcement, AI Brief parsing, Jev and Clef shadow scoring, the locked Clef-versus-Jev comparison, owner-verdict agreement stats, trusted-link validation, daily idempotency, guarded republishing, model repair/fallback, one-pass editorial QA correction and fail-open paths, heartbeat aging, API authentication, visit privacy, and preservation of the last good edition under total source failure.
