#!/usr/bin/env bash
# Submit dsh-va-studio to awesome-dsh-plugin.
# Requires: gh authenticated, curl, git. Run after the GitHub repo is at least 1 day old.
set -euo pipefail

OWNER_REPO="ygunoil/dsh-va-studio"
UPSTREAM="awesome-dsh-plugin/awesome-dsh-plugin"
ENTRY="data/plugins/ygunoil__dsh-va-studio.yml"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="add-ygunoil-dsh-va-studio"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is not installed. Install it first: brew install gh" >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

created=$(curl -fsS "https://api.github.com/repos/${OWNER_REPO}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["created_at"])')
age=$(( $(date -u +%s) - $(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$created" +%s 2>/dev/null || date -u -d "$created" +%s) ))
if [ "$age" -lt 86400 ]; then
  left=$(( 86400 - age ))
  echo "Repository ${OWNER_REPO} is only ${age}s old; the community CI requires 1 day. Retry in about $((left / 3600))h $((left % 3600 / 60))m." >&2
  exit 2
fi

user=$(gh api user --jq .login)
echo "Using GitHub account: ${user}"

if ! gh repo view "${user}/awesome-dsh-plugin" >/dev/null 2>&1; then
  gh repo fork "${UPSTREAM}" --clone=false
  for _ in $(seq 1 20); do gh repo view "${user}/awesome-dsh-plugin" >/dev/null 2>&1 && break; sleep 2; done
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git clone --depth 1 "https://github.com/${user}/awesome-dsh-plugin.git" "$tmp/repo"
cd "$tmp/repo"
git checkout -B "$BRANCH"
cp "${HERE}/docs/awesome-listing/ygunoil__dsh-va-studio.yml" "$ENTRY"
git add "$ENTRY"
git commit -m "Add ygunoil/dsh-va-studio"
git push -u origin "$BRANCH" --force

existing=$(gh pr list --repo "${UPSTREAM}" --head "${user}:${BRANCH}" --json number --jq '.[0].number // empty')
if [ -n "$existing" ]; then
  echo "PR already open: https://github.com/${UPSTREAM}/pull/${existing}"
  exit 0
fi
gh pr create --repo "${UPSTREAM}" \
  --head "${user}:${BRANCH}" \
  --title "Add ygunoil/dsh-va-studio" \
  --body-file "${HERE}/docs/publish-pr-body.md"
