# Repository agent guide

## Purpose

This repository is the durable source of truth for AI Signal. A fresh agent should be able to understand the project, its current constraints, and the safe way to work from the checked-out repository alone.

Treat chat history, handoffs, summaries, and agent memory as disposable hints until they are verified against the repository and, when relevant, current GitHub and Cloudflare evidence. Use repository-relative paths; never assume a particular local checkout path.

## Required cold boot

Before proposing or changing anything:

1. Confirm the repository root and read `README.md`, `PROJECT_HISTORY.md`, `package.json`, and `wrangler.jsonc`.
2. Inspect the source state with:

   ```bash
   git status --short --branch
   git branch --show-current
   git rev-parse HEAD
   git rev-parse origin/main
   git log --oneline --decorate -8
   ```

   Fetch `origin` first when network access is available. If it is not, say that the remote reference may be stale.
3. Preserve dirty or user-owned changes. Never clean, reset, or overwrite them automatically.
4. For production or current-state questions, use relevant read-only evidence rather than relying on documentation alone. Typical checks are:

   ```bash
   npx wrangler deployments list --json
   npx wrangler d1 migrations list ai-signal --remote
   curl https://signal.tamirlevin.dev/api/health
   curl https://signal.tamirlevin.dev/api/status
   curl https://signal.tamirlevin.dev/api/editions/latest
   curl https://signal.tamirlevin.dev/api/shadow/latest
   ```

   Run narrowly scoped read-only D1 queries only when they are needed to establish live state.
5. Before editing, state the confirmed branch and SHA, any drift or dirty state, the live evidence used, remaining unknowns, and a concise plan.

## Source hierarchy

When sources disagree, use this order and preserve the disagreement explicitly:

1. The current user request and its authorization boundaries.
2. Current repository code, tests, and configuration for intended behavior.
3. The fetched GitHub branch and commit for canonical source state.
4. Cloudflare deployment metadata, D1, and public endpoints for deployed and live behavior.
5. `README.md` and `PROJECT_HISTORY.md` for operating guidance, decisions, incidents, and known uncertainty.
6. Chat history, handoffs, and agent memory only as leads to verify.

Do not smooth over conflicting evidence or convert an unverified inference into a fact.

## Working rules

- Inspect the complete relevant files before changing them. Do not implement from a handoff or diff alone.
- Prefer the smallest viable change within the existing architecture. Avoid parallel systems, speculative abstractions, and duplicate documentation.
- Keep secrets out of Git. `wrangler.jsonc` is the source of truth for non-secret runtime configuration.
- Do not deploy, mutate D1, apply a remote migration, force a republish, change a schedule or monitor, change secrets, or perform destructive Git operations unless the current user request explicitly authorizes it.
- Read-only remote verification is appropriate when it is relevant and available.
- Preserve the architectural guardrails in `PROJECT_HISTORY.md`, especially deterministic story inventory, source-bound URLs, AInews fail-open behavior, no weak padding, preservation of the last good edition, and owner-only guarded republishing.
- Do not create session transcripts, routine progress logs, or another project-memory file in the repository.

## Verification and release

For code or configuration changes, run:

```bash
npm run check
npm run dry-run
git diff --check
```

For documentation-only changes, inspect the complete diff, confirm all linked files exist, and run `git diff --check`. Run code tests only if executable behavior or configuration changed.

For an authorized production release:

1. Start from a clean, understood tree and run the required checks.
2. Commit and push the reviewed source to `main` before deployment.
3. Record the current deployment for rollback.
4. Deploy with strict configuration and Git provenance, for example:

   ```bash
   npx wrangler deploy --strict --tag git-<short-sha> --message "Git <full-sha>; <summary>"
   ```

5. Verify the resulting deployment and version metadata, public endpoints, and relevant D1 state.
6. Record consequential verified evidence and any pending verification in `PROJECT_HISTORY.md`, then commit and push that record.

Never force a production republish merely to close a verification checklist without explicit authorization.

## Durable documentation

- `README.md` describes the current architecture and operating model.
- `PROJECT_HISTORY.md` records consequential decisions, incidents, exact deployment evidence, guardrails, and unresolved verification.
- `AGENTS.md` defines the stable cold-boot and working contract.

Update these files when their facts or operating rules materially change. Keep transient session details out of them, and preserve uncertainty until live evidence resolves it.

For an agent that does not automatically load this file, use this boot prompt:

> Read `AGENTS.md`, cold-boot from the repository, verify Git and any relevant live state, then propose a plan before changing anything.
