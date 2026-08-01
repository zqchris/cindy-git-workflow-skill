#!/usr/bin/env bash
# Create an isolated sibling worktree from a remote default branch.
# Usage: git-start.sh <task-slug> [remote]
set -euo pipefail

slug=${1:?usage: git-start.sh <task-slug> [remote]}
remote=${2:-origin}

[[ "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]] || {
  echo "FAIL: task-slug must contain lowercase letters, digits, and hyphens"
  exit 2
}

root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "FAIL: not inside a Git repository"
  exit 2
}
main_root=$(git -C "$root" worktree list --porcelain | awk '$1 == "worktree" { print $2; exit }')
repo=$(basename "$main_root")

if ! git -C "$main_root" remote get-url "$remote" >/dev/null 2>&1; then
  echo "FAIL: remote '$remote' does not exist"
  exit 2
fi

echo "Fetching $remote ..."
git -C "$main_root" fetch "$remote" --prune

default_branch=$(git -C "$main_root" symbolic-ref --quiet --short "refs/remotes/$remote/HEAD" 2>/dev/null | sed "s#^$remote/##" || true)
[[ -n "$default_branch" ]] || default_branch=main

branch="$slug"
worktree="$(dirname "$main_root")/${repo}-${slug}"

[[ ! -e "$worktree" ]] || {
  echo "FAIL: target path already exists: $worktree"
  exit 2
}
if git -C "$main_root" show-ref --verify --quiet "refs/heads/$branch"; then
  echo "FAIL: local branch already exists: $branch"
  exit 2
fi
if ! git -C "$main_root" show-ref --verify --quiet "refs/remotes/$remote/$default_branch"; then
  echo "FAIL: remote default branch not found: $remote/$default_branch"
  exit 2
fi

git -C "$main_root" worktree add -b "$branch" "$worktree" "$remote/$default_branch"

echo "PASS: worktree=$worktree"
echo "base=$remote/$default_branch@$(git -C "$worktree" rev-parse --short HEAD)"
echo "branch=$branch"
