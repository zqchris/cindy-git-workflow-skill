#!/usr/bin/env bash
# git-start.sh <task-slug> — 起步 SOP 一键化:fetch 真正上游 + 从最新远端默认分支起干净 worktree。
# 在目标仓库任意位置运行。输出新 worktree 路径;之后 cd 进去干活。
set -euo pipefail
slug=${1:?用法: git-start.sh <task-slug>  (小写字母数字和-)}
[[ "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "✗ slug 只允许小写字母数字和-: $slug"; exit 1; }

root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "✗ 当前不在 git 仓库内"; exit 1; }
# 若当前已在某个 worktree 里,定位主仓库根
main_root=$(git -C "$root" worktree list --porcelain | awk 'NR==1&&$1=="worktree"{print $2}')
repo=$(basename "$main_root")

# fork 仓优先使用 upstream；只有没有 upstream 时才使用 origin。
# 不允许 upstream fetch 失败后静默退回 origin，否则会重新落到旧 fork 基线。
base_remote=origin
if git -C "$main_root" remote get-url upstream >/dev/null 2>&1; then
  base_remote=upstream
fi

echo "→ fetch $base_remote --prune ..."
git -C "$main_root" fetch "$base_remote" --prune

def=$(git -C "$main_root" symbolic-ref --short "refs/remotes/$base_remote/HEAD" 2>/dev/null | sed "s#^$base_remote/##") || true
if [ -z "${def:-}" ]; then
  def=$(git -C "$main_root" ls-remote --symref "$base_remote" HEAD 2>/dev/null | awk '$1=="ref:" {sub("refs/heads/", "", $2); print $2; exit}')
fi
if [ -z "${def:-}" ]; then
  for candidate in main master; do
    if git -C "$main_root" show-ref --verify --quiet "refs/remotes/$base_remote/$candidate"; then
      def=$candidate
      break
    fi
  done
fi
[ -n "${def:-}" ] || { echo "✗ 无法识别 $base_remote 的默认分支，停止创建 worktree"; exit 1; }

base_ref="$base_remote/$def"
git -C "$main_root" rev-parse --verify "$base_ref^{commit}" >/dev/null 2>&1 || {
  echo "✗ fetch 后仍找不到 $base_ref，停止创建 worktree"
  exit 1
}
branch="$slug"
wt="$(dirname "$main_root")/${repo}-${slug}"

[ -e "$wt" ] && { echo "✗ 目标已存在: $wt(换个 slug 或先清理)"; exit 1; }
git -C "$main_root" show-ref --verify --quiet "refs/heads/$branch" && { echo "✗ 分支已存在: $branch"; exit 1; }

git -C "$main_root" worktree add --no-track -b "$branch" "$wt" "$base_ref"

# 意图锚点(2026-08-04 新增)。放在 worktree 的 git-dir 里,不进仓库、不污染 diff。
# 它存在的唯一理由:review 循环里每一条意见单看都合理,没有书面锚点就无法判断"这条是不是
# 本 PR 该管的"。当天 #1581 正题 415 行被 8 轮 review 泵成 1097 行后废弃重做,#1636 一个
# 消息丢失的 bug 被扩成"全部出站入口的身份核验",都是没有锚点、靠感觉判断的结果。
# pr-size-gate.mjs 会检查它是否已填写;没填不许开 ready PR。
gitdir=$(git -C "$wt" rev-parse --absolute-git-dir)
intent="$gitdir/cindy-intent.md"
tpl="$(dirname "${BASH_SOURCE[0]}")/intent-template.md"
[ -f "$intent" ] || cp "$tpl" "$intent" 2>/dev/null || true

echo ""
echo "✓ worktree 就绪: $wt"
echo "  base   : $base_ref @ $(git -C "$wt" rev-parse --short HEAD)"
echo "  branch : $branch"
echo "  意图契约: $intent  ← 动手前先填完三段(未填不许开 ready PR)"
echo "  下一步 : cd \"$wt\" 后先填意图契约,再开始实现"
