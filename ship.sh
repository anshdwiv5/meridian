#!/usr/bin/env bash
# Meridian — commit, push to GitHub, and deploy to Cloudflare in one shot.
# Usage:  ./ship.sh "what changed"
set -e
MSG="${1:-update meridian}"
git add -A
if git diff --cached --quiet; then
  echo "No code changes to commit — deploying current state."
else
  git commit -m "$MSG"
  git push
fi
npx wrangler deploy
echo "✅ Done — pushed to GitHub and deployed to Cloudflare."
