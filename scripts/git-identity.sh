#!/usr/bin/env bash
# Git identity for this repository, per machine. Read-only by default; --apply sets the
# repository-local git identity and nothing else. It never pushes, never rewrites history,
# and never touches commits that already exist.
#
# Why this exists: the GitHub account and the Cloudflare account use different email
# addresses, and GitHub attributes a commit from the commit's author email, not from
# whichever account you happen to be logged in as. Commits made with the Cloudflare
# email do not link to the account on GitHub. See "Git identity and the two logins" in
# AGENTS.md. Run this on every machine before its first commit in a new checkout.
set -u

REPO_SLUG="tamirlevin/ai-signal-cloudflare"
GITHUB_EMAIL="tamirlevin@yahoo.com"      # the GitHub account email: commits authored with this link to the account
CLOUDFLARE_EMAIL="tamirlevin@gmail.com"  # the Cloudflare/Wrangler login: unrelated to git authorship
# The GitHub noreply address also links to the account and is unaffected by any future
# email change, so it is an acceptable alternative to GITHUB_EMAIL on any machine.

apply=0
for arg in "$@"; do
  case "$arg" in
    --apply) apply=1 ;;
    *) echo "usage: $0 [--apply]   (default: report only)" >&2; exit 2 ;;
  esac
done

arch="$(uname -sm)"
# macOS `hostname` is unreliable: it reports HostName when one is set and otherwise the
# default "Mac.localname", while `scutil --get LocalHostName` reports the Bonjour name
# stably. A VPN client or network change can set and unset HostName mid-session, so
# prefer LocalHostName on Darwin and `hostname` elsewhere.
if [ "$(uname -s)" = "Darwin" ]; then
  host="$(scutil --get LocalHostName 2>/dev/null || hostname)"
else
  host="$(hostname)"
fi
case "$arch" in
  "Darwin x86_64") label="intel-mac"; name="Tamir Levin (intel-mac)" ;;
  "Darwin arm64")  label="m2-mac";   name="Tamir Levin (m2-mac)" ;;
  *)
    case "$host" in
      omarchy-mbp) label="omarchy"; name="Tamir Levin (omarchy)" ;;
      *) echo "Unknown machine ($arch, host $host). Do not guess a label: ask the owner, then add it to AGENTS.md." >&2; exit 1 ;;
    esac ;;
esac

echo "machine: $label ($arch, host $host)"
# One arm64 Mac exists today. A second one would fall into the m2-mac branch above, so its
# hostname is printed and this check fails loudly rather than committing under the wrong label.
if [ "$label" = "m2-mac" ] && [ "$host" != "DFP-MAC-TAMIR" ]; then
  echo "note: this arm64 Mac's computer name is '$host', not 'DFP-MAC-TAMIR'. If this is a"
  echo "      second arm64 Mac, stop and add it to the AGENTS.md machine table before committing."
fi
echo
echo "current repository-local identity:"
echo "  user.name  = $(git config --local user.name  || echo '(unset)')"
echo "  user.email = $(git config --local user.email || echo '(unset)')"
echo "current global identity (used when the repository-local value is unset):"
echo "  user.name  = $(git config --global user.name  || echo '(unset)')"
echo "  user.email = $(git config --global user.email || echo '(unset)')"
echo
echo "target repository-local identity:"
echo "  user.name  = $name"
echo "  user.email = $GITHUB_EMAIL"
echo

if [ "$(git config --local user.email || true)" != "$GITHUB_EMAIL" ] || [ "$(git config --local user.name || true)" != "$name" ]; then
  echo "This checkout's identity is NOT the target. Commits it makes will not be attributed"
  echo "to the GitHub account if the email differs from $GITHUB_EMAIL."
else
  echo "This checkout's identity already matches the target."
fi
echo

if [ "$apply" -eq 1 ]; then
  git config --local user.name "$name"
  git config --local user.email "$GITHUB_EMAIL"
  echo "Applied to the repository-local config. Nothing was committed, pushed, or rewritten."
  echo
else
  echo "Report only. Run with --apply to set the repository-local identity."
  echo
fi

echo "recent commits and whether GitHub links them to the account:"
if command -v gh >/dev/null 2>&1; then
  git log --format='%H %ae %s' -5 | while read -r sha author_email subject; do
    login="$(gh api "repos/$REPO_SLUG/commits/$sha" --jq 'if .author then .author.login else "NOT LINKED" end' 2>/dev/null || echo "unknown")"
    printf '  %s  %-30s %s\n' "${sha:0:7}" "$author_email" "$login"
  done
  echo
  echo "NOT LINKED means GitHub cannot attribute that commit from its author email. Those commits"
  echo "stay as they are: rewriting pushed history is a blocked action, and the content is correct."
  echo
  echo "After applying, the next commit links. Confirm it with:"
  echo "  gh api repos/$REPO_SLUG/commits/HEAD --jq '.author.login'"
else
  echo "  (gh is not installed here, so linkage cannot be checked from this machine)"
fi
exit 0
