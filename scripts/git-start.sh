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
main_root=$(git -C "$root" worktree list --porcelain | sed -n '1s/^worktree //p')
repo=$(basename "$main_root")

if ! git -C "$main_root" remote get-url "$remote" >/dev/null 2>&1; then
  echo "FAIL: remote '$remote' does not exist"
  exit 2
fi

echo "Fetching $remote ..."
git -C "$main_root" fetch "$remote" --prune

# Query the live default branch: a local remote/HEAD may be absent or stale.
remote_head=$(git -C "$main_root" ls-remote --symref "$remote" HEAD)
default_branch=$(printf '%s\n' "$remote_head" | sed -n 's#^ref: refs/heads/\(.*\)[[:space:]]HEAD$#\1#p')
[[ -n "$default_branch" ]] || {
  echo "FAIL: remote default branch is not advertised by $remote"
  echo "ACTION: inspect the remote HEAD before choosing a task base"
  exit 2
}

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

git -C "$main_root" worktree add --no-track -b "$branch" "$worktree" "refs/remotes/$remote/$default_branch"

echo "PASS: worktree=$worktree"
echo "base=$remote/$default_branch@$(git -C "$worktree" rev-parse --short HEAD)"
echo "branch=$branch"
