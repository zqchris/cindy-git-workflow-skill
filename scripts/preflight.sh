#!/usr/bin/env bash
# Read-only gate before an agent edits files in a Git repository.
set -euo pipefail

root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "FAIL: not inside a Git repository"
  exit 2
}

branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)
if [[ -z "$branch" ]]; then
  echo "FAIL: detached HEAD; create or switch to a task branch before editing"
  exit 2
fi

main_root=$(git -C "$root" worktree list --porcelain | awk '$1 == "worktree" { print $2; exit }')
default_branch=$(git -C "$root" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)
[[ -n "$default_branch" ]] || default_branch=main

if [[ "$root" == "$main_root" && "$branch" == "$default_branch" ]]; then
  echo "FAIL: main checkout is on the default branch ($default_branch)"
  echo "ACTION: run git-start.sh <task-slug> to create an isolated worktree"
  exit 2
fi

status=$(git -C "$root" status --porcelain=v1)
if [[ -n "$status" ]]; then
  echo "WARN: working tree already contains changes"
  printf '%s\n' "$status" | awk 'NR <= 10 { print }'
  echo "ACTION: continue only if every existing change belongs to the current task"
  exit 0
fi

echo "PASS: branch=$branch root=$root"
