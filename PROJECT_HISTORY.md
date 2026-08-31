# Project history

This is the curated engineering and production history for AI Signal. It records consequential decisions, incidents, verified runtime evidence, unresolved uncertainty, and architectural constraints. It is not a release changelog, commit log, or session transcript.

## 31 August 2026 — daily equal-source edition correction

### Engineering record

- Product behavior was corrected from an AInews-anchored issue plus a separate “Fresh since this edition” display to one ordinary daily edition built for the current Melbourne calendar day. The temporary fresh-signals reader section and its client fetch were removed; the scheduled-heartbeat alert remains.
- `core-ai` v2 places AInews, TLDR AI, and AlphaSignal in one editorial candidate pool with no source seniority. Cloudflare Agents remains a narrow primary-evidence lane. A failed or quiet feed no longer blocks usable candidates from another source.
- The pool prefers candidates published inside 36 hours, rejects anything older than 48 hours, and excludes X/Twitter URLs from publishable cards and corroboration. Ranking combines profile fit, freshness, evidence quality, and capped cross-source coverage. Diversity is only a four-point near-tie ordering safeguard; there are no source quotas or padding.
- Each stored signal retains its own source timestamp while the edition itself is dated to the Melbourne run day. Normal refresh is idempotent for that day. No D1 migration, new service, queue, schedule, or second publication path was introduced.
- The deterministic collector still materialises every story card and permitted URL. Workers AI still writes only the bounded synthesis and presentation copy, and a run with no qualified 48-hour candidates preserves the last good edition.

### Release verification

Pending. Source must pass the repository gates, be pushed to GitHub `main`, then be deployed with Git provenance. The owner has explicitly authorized one ordinary production refresh after deployment; a forced republish is neither required nor intended.

## 31 August 2026 — fresh source signals and scheduled heartbeat visibility

### Engineering record

- When the displayed latest edition and the latest non-failed shadow report share the same AInews issue, the reader now surfaces up to five `wouldAdd` candidates whose source timestamps are newer than the edition publication time. It preserves the collector's existing order and HTTPS source links, clearly labels the section as candidates rather than a newly generated brief, and never shows it on historical editions.
- The implementation reuses `/api/shadow/latest`; it adds no feed, model call, scoring path, D1 table, schedule, or republish behavior. Shadow failure or endpoint absence remains fail-open for the last good edition.
- `/api/status` now separates the latest collector outcome from the latest completed `cron` heartbeat. The heartbeat becomes stale after 26 hours; a recent `skipped` cron run counts as healthy because it proves the scheduler and collector completed normally.

### Verified release evidence

- Git commit `0d51289e4848ae2f7d4af70c078816d5349eaaa9` passed generated Worker types, TypeScript, 67 tests in 11 files, dry-run packaging, JavaScript syntax checks, and diff checks before it was pushed to GitHub `main`.
- The pre-release rollback point was deployment `e2eec775-48b1-4710-b7c8-9f78935d4474`, version 37 `5fba0bbb-98ab-45eb-891b-f9d64c4ba29b`.
- Cloudflare deployment `6ac23f04-037f-4602-9b8a-4f475be2f7e6` now sends 100% of traffic to version 38 `34a255d0-b6ab-4a50-9f32-d81f69cdec3a`, created at `2026-08-30T23:41:33.698499Z`. Its tag is `git-0d51289`, and its message records the full Git SHA and both enhancements.
- Public health, status, latest-edition, profile, shadow, and deployed-asset checks returned HTTP 200. `/api/status` reports the `2026-08-30T22:15:19.201Z` cron skip as a healthy scheduled heartbeat with a 26-hour threshold. The matching healthy shadow report exposes five newer candidates, and the reader renders all five as “Fresh since this edition.”
- Desktop and 390 px browser checks of the deployed assets and public responses showed the two-column/one-column layouts respectively, no horizontal overflow, no page error, and no browser warning or error. The current healthy heartbeat correctly produces no stale alert.
- D1 still has no pending migrations and no manual republish claims. Read-only queries reported zero rows written; the latest edition remains ID `19126c44-1dab-445c-9ab2-9fd32a56ab92`, issue `2026-08-26`, published at `2026-08-27T23:39:14.782Z`. Deployment did not trigger generation or republishing.
- The live AInews RSS item remains “not much happened today,” published 26 August. The fresh supplemental section is therefore additive source visibility, not evidence of a new model-generated edition; a successful post-repair production generation remains pending a genuinely newer AInews anchor.

## 30 August 2026 — source-aware collection, guarded republishing, and model-output recovery

### Engineering record

- Source collection became source-aware and reusable through the code-defined `core-ai` source pack v1. It keeps source roles, URLs, lookback windows, enrichment limits, and shadow caps together while retaining AInews as the base inventory and complete fail-open fallback.
- Story provenance now records distinct editorial coverage separately from primary evidence. Independent editorial corroboration contributes 4 ranking points per source, capped at 8; agreement is context, not proof.
- The Cloudflare Agents lane was corrected to remain narrow primary evidence. An unexpected off-host item may support an existing cluster, but cannot count as editorial corroboration or lead a novel discovery-only story. Validation now cross-checks coverage counts against provenance and evidence.
- Normal refresh remains idempotent. The owner-only manual path can republish an already-published issue once per successful `Australia/Melbourne` calendar day. Migration `0005_manual_republish_guard.sql` introduced the atomic daily claim; failed attempts release it and successful replacement consumes it.
- GitHub `main` at `adbb5ff0904336dcaf6f0a9df6f53e200c674a16` adds one primary-model repair attempt before fallback, preserves the three-call ceiling, applies low reasoning effort to prompt-only GLM requests, accepts the known Workers AI response shapes, emits safe output diagnostics, and classifies future missing or malformed model JSON as `MODEL_JSON_INVALID`.
- The repository became the cross-agent continuity layer through a root `AGENTS.md`. Fresh sessions must verify Git and any relevant live state before acting; chat history, handoffs, and agent memory remain disposable, non-authoritative context.

### Verified production evidence

Read-only checks on 30 August 2026 established the following:

| Evidence | Verified state |
| --- | --- |
| GitHub release source | Commit `cb194ce589ace189bf59aa480da265204586a79e` was pushed to `main` before deployment. Its runtime files match `adbb5ff0904336dcaf6f0a9df6f53e200c674a16`; the exact tree passes generated Worker types, TypeScript, 60 tests in 10 files, and `wrangler deploy --dry-run`. |
| Source-aware rollout | Cloudflare lists deployment `ccbf9846-183e-44cb-b267-67a4db959018`, serving Worker version 30 `cf012af4-64de-4215-8fc5-1cec5851ff5a` from 28 August 07:10 UTC. Current public profile and shadow data independently confirm `core-ai` v1 is live. |
| Republish migration | On D1 database `ai-signal` (`376a852a-26db-4d2d-983c-b872b3361372`), migration 5, `0005_manual_republish_guard.sql`, was applied at `2026-08-29 00:05:11` UTC. Cloudflare lists the immediately following deployment `4444f2f6-57af-453c-8023-c5a025dac01a`, version 32 `bccf8e19-096a-408f-9574-6cc79fe8b864`. |
| Worker at initial verification | Deployment `5d4c5cb5-387f-4718-a140-b97bb50c48ae` sent 100% of traffic to version 36 `96c78f75-2e47-4677-af25-96e41f1a18e3`, created at `2026-08-29T07:21:40.608876Z`. |
| Verified repair deployment | Deployment `e2eec775-48b1-4710-b7c8-9f78935d4474` sends 100% of traffic to version 37 `5fba0bbb-98ab-45eb-891b-f9d64c4ba29b`, created at `2026-08-30T01:10:03.477455Z`. The version is tagged `git-cb194ce`; its message records full Git commit `cb194ce589ace189bf59aa480da265204586a79e` and runtime source `adbb5ff`. |
| Commit-to-version mapping | Earlier Wrangler versions have no Git SHA, so their exact commit mapping remains unproven. Version 37 closes that gap with explicit Git metadata recorded during deployment. |

### 29 August republish incident

D1 records three manual attempts for the 26 August issue, not one. All failed at the model-output boundary with GLM as the final model, `GENERATION_FAILED`, and `Model did not return a JSON edition`:

- `00:06:19Z` to `00:08:51Z` — 152,384 ms.
- `00:26:22Z` to `00:29:24Z` — 181,776 ms.
- `07:22:10Z` to `07:24:52Z` — 161,894 ms.

The existing edition was preserved, and `manual_republish_days` contains no active or completed claim, confirming the failed daily claims were released. Historical failed rows remain unchanged as audit evidence; their generic error code reflects the old classification behavior.

The third failure began after version 36 was created and still used the old generic error code and undiagnosed message. That established that timestamp proximity alone could not prove the `adbb5ff` behavior was deployed.

On 30 August, the exact reviewed GitHub tree at `cb194ce`—whose only changes after `adbb5ff` are `README.md` and this history file—was deployed as version 37 with explicit Git metadata. Public health, status, latest-edition, and shadow endpoints remained healthy. D1 still showed the scheduled skip as its latest run, zero republish-claim rows, and applied migration 5, confirming deployment did not trigger generation or consume a daily claim. The repair is now verified as deployed; a successful post-fix production generation remains **pending**. Do not consume a manual republish merely to close this verification gap without owner approval.

### 30 August scheduled state

The 08:15 AEST cron completed its check normally and skipped generation because the 26 August AInews issue was already published. D1 and `/api/status` agree on `2026-08-29T22:15:02.552Z`, status `skipped`, duration 499 ms. This is operational success, not proof of model generation.

The follow-on shadow run was healthy in 1,557 ms using `core-ai` v1. TLDR AI, AlphaSignal, and Cloudflare Agents all completed without source errors; the report contained 18 AInews candidates, 23 supplemental candidates, 14 novel qualified candidates, and 5 potential additions. The public edition remains issue `2026-08-26`, ID `19126c44-1dab-445c-9ab2-9fd32a56ab92`, published at `2026-08-27T23:39:14.782Z`. It predates the corrected collection metadata and is valid under backward compatibility.

### Deferred ideas, ranked

1. Add a parser-drift canary to the existing source report using yield history and initially informational thresholds.
2. Add an immutable R2 run archive and replay corpus containing deterministic inputs, profile/source-pack versions, source reports, model metadata, validated outputs, and outcomes.
3. Anchor synthesis sections to validated candidate IDs and derive their source links server-side.
4. Revisit fallback structured-output support only if the new diagnostics show another real GLM output failure; preserve model-family diversity unless evidence justifies changing it.
5. Optionally correct the Melbourne summer-time shift with two UTC schedules plus an in-handler local-time gate; leave it alone if 09:15 AEDT is acceptable.

### Architectural guardrails

- The deterministic collector, not the model, materialises the story inventory.
- The model cannot introduce stories or source URLs.
- Editorial corroboration is never described as proof.
- AInews, TLDR AI, and AlphaSignal enter one equal editorial pool; no source receives seniority.
- One failed or quiet source does not block a usable pool from the others.
- Prefer the first 36 hours and reject candidates older than 48 hours.
- X/Twitter is background noise and cannot become a published card or corroborating source.
- Quiet days remain quiet; do not pad to a story target.
- Failed runs cannot replace the last good edition.
- Normal refresh remains idempotent.
- Forced republishing remains owner-only and once per successful Melbourne day.
- `/admin` remains absent from public navigation.
- Historical failed-run rows remain immutable audit evidence.
