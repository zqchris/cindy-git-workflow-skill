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

main_root=$(git -C "$root" worktree list --porcelain | sed -n '1s/^worktree //p')
if [[ "$root" == "$main_root" ]]; then
  echo "FAIL: primary checkout is reserved; current branch=$branch"
  echo "ACTION: run git-start.sh <task-slug> to create an isolated worktree"
  exit 2
fi

# This gate is deliberately offline. The caller still verifies the current
# upstream and task ownership; local refs are not proof of a fresh base.
while IFS= read -r remote; do
  default_ref=$(git -C "$root" symbolic-ref --quiet "refs/remotes/$remote/HEAD" 2>/dev/null || true)
  if [[ -n "$default_ref" && "$branch" == "${default_ref#refs/remotes/$remote/}" ]]; then
    echo "FAIL: task worktree is on the known default branch ($branch)"
    exit 2
  fi
done < <(git -C "$root" remote)

status=$(git -C "$root" status --porcelain=v1)
if [[ -n "$status" ]]; then
  echo "WARN: working tree already contains changes"
  printf '%s\n' "$status" | awk 'NR <= 10 { print }'
  echo "ACTION: continue only if every existing change belongs to the current task"
  exit 0
fi

echo "PASS: branch=$branch root=$root"
