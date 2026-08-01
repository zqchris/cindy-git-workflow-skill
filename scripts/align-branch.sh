#!/usr/bin/env bash
# Compare a local PR branch with its remote counterpart without merging or rebasing.
# Usage: align-branch.sh <branch> [remote]
set -euo pipefail

branch=${1:?usage: align-branch.sh <branch> [remote]}
remote=${2:-origin}

root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "FAIL: not inside a Git repository"
  exit 2
}

if ! git -C "$root" remote get-url "$remote" >/dev/null 2>&1; then
  echo "FAIL: remote '$remote' does not exist"
  exit 2
fi

git -C "$root" fetch "$remote" --prune

local_ref="refs/heads/$branch"
remote_ref="refs/remotes/$remote/$branch"

if ! git -C "$root" show-ref --verify --quiet "$local_ref"; then
  if git -C "$root" show-ref --verify --quiet "$remote_ref"; then
    echo "NOT_LOCAL: remote branch exists at $remote/$branch"
    echo "ACTION: create a local tracking branch or worktree before editing"
  else
    echo "NOT_FOUND: neither local nor remote branch exists: $branch"
  fi
  exit 0
fi

if ! git -C "$root" show-ref --verify --quiet "$remote_ref"; then
  echo "LOCAL_ONLY: local branch has not been pushed to $remote"
  exit 0
fi

local_sha=$(git -C "$root" rev-parse "$local_ref")
remote_sha=$(git -C "$root" rev-parse "$remote_ref")

if [[ "$local_sha" == "$remote_sha" ]]; then
  echo "ALIGNED: $branch@${local_sha:0:7}"
  exit 0
fi

base=$(git -C "$root" merge-base "$local_sha" "$remote_sha" 2>/dev/null || true)
if [[ "$base" == "$local_sha" ]]; then
  count=$(git -C "$root" rev-list --count "$local_sha..$remote_sha")
  echo "BEHIND: local branch is behind by $count commit(s)"
elif [[ "$base" == "$remote_sha" ]]; then
  count=$(git -C "$root" rev-list --count "$remote_sha..$local_sha")
  echo "AHEAD: local branch is ahead by $count commit(s)"
else
  ahead=$(git -C "$root" rev-list --count "$base..$local_sha")
  behind=$(git -C "$root" rev-list --count "$base..$remote_sha")
  echo "DIVERGED: ahead=$ahead behind=$behind"
  echo "ACTION: inspect the history and choose merge/rebase according to repository policy"
fi
