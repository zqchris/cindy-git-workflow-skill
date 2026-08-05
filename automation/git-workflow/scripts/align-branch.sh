#!/usr/bin/env bash
# align-branch.sh <branch> [remote] — follow-up 前对齐本地分支与远端 PR head。
# 输出: ALIGNED / BEHIND / DIVERGED / NOT_FOUND
set -euo pipefail

branch=${1:?用法: align-branch.sh <branch-name> [remote]}
remote=${2:-origin}

root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "FAIL: 不在 git 仓库内"; exit 0; }

# fetch 最新
git -C "$root" fetch "$remote" --prune 2>/dev/null

# 检查本地分支是否存在
if ! git -C "$root" show-ref --verify --quiet "refs/heads/$branch"; then
  # 本地不存在，尝试从远端 checkout
  if git -C "$root" show-ref --verify --quiet "refs/remotes/$remote/$branch"; then
    echo "NOT_LOCAL: 本地无 $branch，远端有。执行 git checkout $branch 来创建本地跟踪分支"
    exit 0
  fi
  echo "NOT_FOUND: 本地和远端都没有 $branch"
  exit 0
fi

# 检查远端是否有对应分支
if ! git -C "$root" show-ref --verify --quiet "refs/remotes/$remote/$branch"; then
  # 可能是 fork 的分支，尝试查找
  fork_remote=$(git -C "$root" remote | grep -v "^$remote$" | head -1)
  if [ -n "$fork_remote" ] && git -C "$root" show-ref --verify --quiet "refs/remotes/$fork_remote/$branch"; then
    remote="$fork_remote"
    echo "INFO: 使用 fork remote '$fork_remote' 对比"
  else
    echo "ALIGNED: 本地有 $branch 但远端无对应分支（可能是新分支未推送）"
    exit 0
  fi
fi

local_sha=$(git -C "$root" rev-parse "refs/heads/$branch")
remote_sha=$(git -C "$root" rev-parse "refs/remotes/$remote/$branch")

if [ "$local_sha" = "$remote_sha" ]; then
  echo "ALIGNED: $branch @ ${local_sha:0:7}"
  exit 0
fi

# 判断方向
base=$(git -C "$root" merge-base "$local_sha" "$remote_sha" 2>/dev/null || echo "")

if [ "$base" = "$local_sha" ]; then
  behind_count=$(git -C "$root" rev-list --count "$local_sha..$remote_sha")
  echo "BEHIND: 本地落后远端 $behind_count 个 commit"
  echo "ACTION: git checkout $branch && git pull $remote $branch"
  exit 0
elif [ "$base" = "$remote_sha" ]; then
  ahead_count=$(git -C "$root" rev-list --count "$remote_sha..$local_sha")
  echo "ALIGNED: 本地领先远端 $ahead_count 个 commit（未推送的本地 commit）"
  exit 0
else
  ahead=$(git -C "$root" rev-list --count "$base..$local_sha")
  behind=$(git -C "$root" rev-list --count "$base..$remote_sha")
  echo "DIVERGED: 本地和远端已分叉 (ahead $ahead, behind $behind)"
  echo "ACTION: 建议 git checkout $branch && git merge $remote/$branch（堆叠 PR 链禁 rebase）"
  exit 0
fi
