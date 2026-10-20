#!/usr/bin/env bash
# Create the public GitHub repository, push main, set the community topic and
# publish the v0.2.0 release with the prebuilt tarball.
set -euo pipefail

REPO="ygunoil/dsh-va-studio"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GH="${GH_BIN:-$HOME/.local/bin/gh}"

command -v "$GH" >/dev/null 2>&1 || GH="$(command -v gh)"
"$GH" auth status >/dev/null 2>&1 || { echo "gh is not authenticated. Run: gh auth login" >&2; exit 1; }

cd "$HERE"

if ! "$GH" repo view "$REPO" >/dev/null 2>&1; then
  "$GH" repo create "$REPO" --public --source . --remote origin --push
else
  if git remote get-url origin >/dev/null 2>&1; then
    git push -u origin main
  else
    "$GH" repo set-default "$REPO" >/dev/null 2>&1 || true
    git remote add origin "https://github.com/${REPO}.git"
    git push -u origin main
  fi
fi

"$GH" repo edit "$REPO" \
  --description "DeepSeek Harness plugin for VA Studio: generate short dramas, images, videos, novels and screenplays, and reverse-engineer prompts." \
  --add-topic dsh-plugin

if ! "$GH" release view v0.2.0 --repo "$REPO" >/dev/null 2>&1; then
  "$GH" release create v0.2.0 dist/dsh-va-studio-0.2.0.tgz \
    --repo "$REPO" \
    --title "v0.2.0" \
    --notes "Adds image generation (text-to-image and image-to-image). Ten VA Studio tools, a settings page, and two skills."
fi

echo
echo "Repository: https://github.com/${REPO}"
"$GH" repo view "$REPO" --json url,description,repositoryTopics --jq '{url, description, topics: [.repositoryTopics[].name]}'
echo
echo "Release asset:"
"$GH" release view v0.2.0 --repo "$REPO" --json url,assets --jq '{url, assets: [.assets[].name]}'
