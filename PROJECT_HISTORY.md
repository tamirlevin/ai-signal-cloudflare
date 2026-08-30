# Project history

This is the curated engineering and production history for AI Signal. It records consequential decisions, incidents, verified runtime evidence, unresolved uncertainty, and architectural constraints. It is not a release changelog, commit log, or session transcript.

## 30 August 2026 — source-aware collection, guarded republishing, and model-output recovery

### Engineering record

- Source collection became source-aware and reusable through the code-defined `core-ai` source pack v1. It keeps source roles, URLs, lookback windows, enrichment limits, and shadow caps together while retaining AInews as the base inventory and complete fail-open fallback.
- Story provenance now records distinct editorial coverage separately from primary evidence. Independent editorial corroboration contributes 4 ranking points per source, capped at 8; agreement is context, not proof.
- The Cloudflare Agents lane was corrected to remain narrow primary evidence. An unexpected off-host item may support an existing cluster, but cannot count as editorial corroboration or lead a novel discovery-only story. Validation now cross-checks coverage counts against provenance and evidence.
- Normal refresh remains idempotent. The owner-only manual path can republish an already-published issue once per successful `Australia/Melbourne` calendar day. Migration `0005_manual_republish_guard.sql` introduced the atomic daily claim; failed attempts release it and successful replacement consumes it.
- GitHub `main` at `adbb5ff0904336dcaf6f0a9df6f53e200c674a16` adds one primary-model repair attempt before fallback, preserves the three-call ceiling, applies low reasoning effort to prompt-only GLM requests, accepts the known Workers AI response shapes, emits safe output diagnostics, and classifies future missing or malformed model JSON as `MODEL_JSON_INVALID`.

### Verified production evidence

Read-only checks on 30 August 2026 established the following:

| Evidence | Verified state |
| --- | --- |
| GitHub | `origin/main` resolves to `adbb5ff0904336dcaf6f0a9df6f53e200c674a16`. The exact tree passes generated Worker types, TypeScript, 60 tests in 10 files, and `wrangler deploy --dry-run`. |
| Source-aware rollout | Cloudflare lists deployment `ccbf9846-183e-44cb-b267-67a4db959018`, serving Worker version 30 `cf012af4-64de-4215-8fc5-1cec5851ff5a` from 28 August 07:10 UTC. Current public profile and shadow data independently confirm `core-ai` v1 is live. |
| Republish migration | On D1 database `ai-signal` (`376a852a-26db-4d2d-983c-b872b3361372`), migration 5, `0005_manual_republish_guard.sql`, was applied at `2026-08-29 00:05:11` UTC. Cloudflare lists the immediately following deployment `4444f2f6-57af-453c-8023-c5a025dac01a`, version 32 `bccf8e19-096a-408f-9574-6cc79fe8b864`. |
| Current Worker | Deployment `5d4c5cb5-387f-4718-a140-b97bb50c48ae` sends 100% of traffic to version 36 `96c78f75-2e47-4677-af25-96e41f1a18e3`, created at `2026-08-29T07:21:40.608876Z`. |
| Commit-to-version mapping | Wrangler exposes deployment/version metadata but no Git commit SHA. The identifiers above are verified; a specific version-to-commit mapping is not independently proven from timestamps alone. |

### 29 August republish incident

D1 records three manual attempts for the 26 August issue, not one. All failed at the model-output boundary with GLM as the final model, `GENERATION_FAILED`, and `Model did not return a JSON edition`:

- `00:06:19Z` to `00:08:51Z` — 152,384 ms.
- `00:26:22Z` to `00:29:24Z` — 181,776 ms.
- `07:22:10Z` to `07:24:52Z` — 161,894 ms.

The existing edition was preserved, and `manual_republish_days` contains no active or completed claim, confirming the failed daily claims were released. Historical failed rows remain unchanged as audit evidence; their generic error code reflects the old classification behavior.

The third failure began after the currently deployed Worker version was created and still used the old generic error code and undiagnosed message. Because Cloudflare does not expose a Git SHA for that version, this is evidence that the `adbb5ff` behavior is not proven in production and may not be present in the deployed bundle. A successful post-fix production generation is **pending**. Do not consume a manual republish merely to close this verification gap without owner approval.

### 30 August scheduled state

The 08:15 AEST cron completed its check normally and skipped generation because the 26 August AInews issue was already published. D1 and `/api/status` agree on `2026-08-29T22:15:02.552Z`, status `skipped`, duration 499 ms. This is operational success, not proof of model generation.

The follow-on shadow run was healthy in 1,557 ms using `core-ai` v1. TLDR AI, AlphaSignal, and Cloudflare Agents all completed without source errors; the report contained 18 AInews candidates, 23 supplemental candidates, 14 novel qualified candidates, and 5 potential additions. The public edition remains issue `2026-08-26`, ID `19126c44-1dab-445c-9ab2-9fd32a56ab92`, published at `2026-08-27T23:39:14.782Z`. It predates the corrected collection metadata and is valid under backward compatibility.

### Deferred ideas, ranked

1. Add a stale-run alert based on the absence of a completed scheduled heartbeat for roughly 26 hours; a legitimate already-published skip must count as healthy.
2. Add a parser-drift canary to the existing source report using yield history and initially informational thresholds.
3. Add an immutable R2 run archive and replay corpus containing deterministic inputs, profile/source-pack versions, source reports, model metadata, validated outputs, and outcomes.
4. Anchor synthesis sections to validated candidate IDs and derive their source links server-side.
5. Revisit fallback structured-output support only if the new diagnostics show another real GLM output failure; preserve model-family diversity unless evidence justifies changing it.
6. Optionally correct the Melbourne summer-time shift with two UTC schedules plus an in-handler local-time gate; leave it alone if 09:15 AEDT is acceptable.

### Architectural guardrails

- The deterministic collector, not the model, materialises the story inventory.
- The model cannot introduce stories or source URLs.
- Editorial corroboration is never described as proof.
- AInews remains the base and complete fail-open fallback.
- Supplemental failure does not block a usable base edition.
- Quiet days remain quiet; do not pad to a story target.
- Failed runs cannot replace the last good edition.
- Normal refresh remains idempotent.
- Forced republishing remains owner-only and once per successful Melbourne day.
- `/admin` remains absent from public navigation.
- Historical failed-run rows remain immutable audit evidence.
