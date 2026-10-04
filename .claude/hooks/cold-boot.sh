#!/usr/bin/env bash
# Prints the cold-boot facts AGENTS.md asks for, so a session starts from evidence.
# Read-only, no network. It never fetches, so remote references may be stale.
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
arch="$(uname -sm)"
host="$(hostname)"
case "$arch:$host" in
  "Darwin x86_64:"*) machine="intel-mac" ;;
  "Darwin arm64:"*) machine="m2-mac" ;;
  "Linux aarch64:omarchy-mbp") machine="omarchy" ;;
  *) machine="unknown: ask the owner and do not use a label" ;;
esac
echo "AGENTS.md cold boot (read-only snapshot; origin was not fetched)"
echo "machine: $machine ($arch, host $host)"
echo "branch: $(git branch --show-current 2>/dev/null)   HEAD: $(git rev-parse HEAD 2>/dev/null)"
git status --short --branch 2>/dev/null
echo "recent commits:"
git log --oneline -3 2>/dev/null
exit 0
