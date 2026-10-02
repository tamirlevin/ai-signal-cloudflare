# Repository agent guide

## Purpose

This repository is the durable source of truth for AI Signal. A fresh agent should be able to understand the project, its current constraints, and the safe way to work from the checked-out repository alone.

Treat chat history, handoffs, summaries, and agent memory as disposable hints until they are verified against the repository and, when relevant, current GitHub and Cloudflare evidence. Use repository-relative paths; never assume a particular local checkout path.

## Branches and environments

- `main` is production. It deploys to `signal.tamirlevin.dev` and is the stable baseline; experiment work does not change it, and anything reaches it only by merging under the release rules below.
- `feature/mts-lane` is an experiment, deployed only to staging (`testsignal.tamirlevin.dev`). It tests whether introducing a judge (Jev and the Workers AI reranker) into candidate selection helps at all compared with the deterministic rules; a null or negative result is a valid outcome. It also carries the unmerged MTS Situations and AI Brief source lanes and the candidate-coverage gate that came with that work.

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
   uname -sm
   ```

   Fetch `origin` first when network access is available. If it is not, say that the remote reference may be stale. `uname -sm` identifies the working machine; see Working machines below.
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
5. Before editing, state the confirmed branch and SHA, the working machine, any drift or dirty state, the live evidence used, remaining unknowns, and a concise plan.

## Working machines

Until the owner says otherwise, this repository is run from the **Intel Mac** (`Darwin x86_64`). The owner also uses an **M2 Mac** (`Darwin arm64`), normally on Tuesdays and Wednesdays in the office. Use the lowercase labels `intel-mac` and `m2-mac` wherever a machine is recorded. A cloud agent session (`Linux`) is neither and cannot tell which Mac the owner is typing on: ask rather than assume. Cloudflare actions are unavailable there unless credentials were supplied for that session.

**Session types.** A desktop (local) session needs a folder the owner chooses (use the non-synced clone) and may use a git worktree under `.claude/worktrees/`. A cloud session works from a fresh clone of GitHub, so push first; it has no Wrangler login. The Cloudflare connector, when enabled, gives read-only inspection of D1 through `d1_database_query` (SELECT only, never a write) of staging `ai-signal-staging` (`d1d32bf8-9edf-463a-b151-8ea54abc2e4d`) and production `ai-signal` (`376a852a-26db-4d2d-983c-b872b3361372`), plus Cloudflare documentation search; it has no deploy tool. Public endpoints and some documentation hosts may be blocked by the environment's network allowlist. Deploys, migrations, and secrets are the owner's steps from the Intel Mac.

In a local session, identify the machine with `uname -sm` and state it with the branch and SHA. A terminal running under Rosetta on the M2 reports `x86_64`; if in doubt, run `sysctl -n machdep.cpu.brand_string`. If the machine is not the Intel Mac, tell the owner what changes before editing or deploying:

- **Hand-over.** The other machine's latest work is present only if it was committed and pushed; compare `HEAD` with the fetched remote branch. Uncommitted or unpushed work on the other Mac is invisible from here, so do not assume it is absent.
- **Dependencies.** Run `npm ci` in this checkout, then `npm run check`. Never copy or sync `node_modules` or `.wrangler` between machines. Keep the checkout outside Dropbox and other synced folders: GitHub is the only bridge between machines.
- **Local-only state.** `.dev.vars` is gitignored and exists only where it was created. `/admin` takes the admin token for the environment in use (staging and production differ), and the browser never stores it.
- **Cloudflare login.** `wrangler login` is per machine. Run `npx wrangler whoami` and confirm the intended account before any remote read or write.
- **Deploying.** `wrangler deploy` ships the working tree, not GitHub, so deploy only from a clean tree at a pushed SHA. Deploys originate from the Intel Mac unless the owner authorizes otherwise; the M2 Mac is for reading, `/admin` labelling, and code that is committed and pushed.
- **Identity.** Give each machine its own git author name (`Tamir Levin (intel-mac)`, `Tamir Levin (m2-mac)`) with the same `user.email`, so `git log` shows where a commit was made.
- **Provenance.** Put the machine label in every deploy `--message` and release record. Cloudflare version metadata is the record of which machine deployed last; do not keep a "last machine" file, which would be a progress log that goes stale.

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
- When access is missing (a login, a network allowlist entry, a connector, a token), say exactly what is missing and ask the owner to supply it; do not work around it. A cloud session's allowlist, connectors, and secrets are set by its environment and apply to new sessions.
- Preserve the architectural guardrails in `PROJECT_HISTORY.md`, especially the deterministic daily story inventory, equal-source candidate pool, 36-hour preference/48-hour normal window with a 72-hour fallback below 10 qualified candidates, no X-only cards, source-bound URLs, no weak padding, preservation of the last good edition, and owner-only guarded republishing.
- Keep Jev, Clef, and reranker judgments advisory and shadow-only. Admin review labels, ranks, question-set versions, the Jev judgments ledger, and run snapshots are research data; they do not automatically change the selection or publication path.
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
   npx wrangler deploy --strict --tag git-<short-sha> --message "Git <full-sha>; <summary>; machine <intel-mac|m2-mac>"
   ```

For experiment branches, deploy to staging instead (same checks first; a plain `wrangler deploy` targets production):

```bash
npx wrangler deploy --env staging --tag git-<short-sha>-staging --message "Git <full-sha>; <summary>; machine <intel-mac|m2-mac>"
```

Staging (`testsignal.tamirlevin.dev`, D1 `ai-signal-staging`) runs an 8-hour test schedule instead of the daily production cron and never shares production data or secrets. Verify staging at its own endpoints; promote to production only via `main`.

5. Verify the resulting deployment and version metadata, public endpoints, and relevant D1 state.
6. Record consequential verified evidence, the deploying machine, and any pending verification in `PROJECT_HISTORY.md`, then commit and push that record.

Never force a production republish merely to close a verification checklist without explicit authorization.

## Closing a session

Before ending any session that changed something, in this order:

1. Run the checks for what changed (see above).
2. Commit. `git status --short` must show nothing, and no stash or worktree may hold work.
3. Push to the designated branch. `git status --short --branch` must show it neither ahead of nor behind its remote. Unpushed work is lost with a cloud container and stranded on one Mac.
4. Only if authorized, deploy the pushed SHA and verify it. Then record the evidence and the deploying machine in `PROJECT_HISTORY.md`, and commit and push that record. A deploy without a pushed record is an unfinished release.
5. Write each pending verification into `PROJECT_HISTORY.md`, with what to look for and when. Do not leave it in chat.
6. Tell the owner what is done, what is pending, and what the next session should do first.

## Durable documentation

- `README.md` describes the current architecture and operating model.
- `PROJECT_HISTORY.md` records consequential decisions, incidents, exact deployment evidence, guardrails, and unresolved verification.
- `AGENTS.md` defines the stable cold-boot and working contract.

Update these files when their facts or operating rules materially change. Keep transient session details out of them, and preserve uncertainty until live evidence resolves it.

For an agent that does not automatically load this file, use this boot prompt:

> Read `AGENTS.md`, cold-boot from the repository, verify Git and any relevant live state, then propose a plan before changing anything.
