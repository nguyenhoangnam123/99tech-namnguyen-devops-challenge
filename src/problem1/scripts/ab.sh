#!/usr/bin/env bash
# A/B two commits under the same k6 scenario, each on a fresh stack.
# Usage: scripts/ab.sh <commit-A> <commit-B>   (DURATION=2m by default)
# Destroys local stack data: every side starts from empty volumes.
set -euo pipefail

app=$(cd "$(dirname "$0")/.." && pwd)
repo=$(git -C "$app" rev-parse --show-toplevel)
prefix=$(git -C "$app" rev-parse --show-prefix)
out="$app/reports/ab"
duration=${DURATION:-2m}
mkdir -p "$out"

run_side() {
  local label=$1 ref=$2 sha tree
  sha=$(git -C "$repo" rev-parse --short "$ref")
  tree="$(mktemp -d)/tree"
  git -C "$repo" worktree add --detach "$tree" "$sha" >/dev/null
  cp -R "$app/deploy/.secrets" "$app/deploy/.env" "$tree/$prefix/deploy/"

  echo "== $label = $sha: fresh stack"
  make -C "$app" nuke >/dev/null 2>&1 || true
  IMAGE_TAG="$sha" make -C "$tree/$prefix" up >/dev/null
  # The scenario always comes from this checkout, so only the code differs.
  make -C "$app" perf DURATION="$duration" >/dev/null || true
  cp "$app/reports/perf/summary.json" "$out/$label-$sha.json"
  git -C "$repo" worktree remove --force "$tree"
}

run_side A "$1"
run_side B "$2"
node "$app/scripts/ab-report.mjs" "$out"/A-*.json "$out"/B-*.json | tee "$out/report.md"
