#!/usr/bin/env bash
# preflight.sh — 写前门禁检查。agent 在任何写操作前必须执行。
# 输出 PASS 或 FAIL + 原因。agent 看到 FAIL 必须停止写操作。
#
# 用法: bash preflight.sh [--session <宿主会话id>]
#   --session 用宿主的 get_current_session_id 取(不是 CLAUDE_CODE_SESSION_ID / agent 内部
#   sdkSessionId,那是另一个 id 空间)。传了它,检查5 的分支归属冲突才能硬 FAIL;不传只能给
#   WARN 把 owner 摆出来让 agent 自己核对。
set -euo pipefail

self_session=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session) self_session="${2:-}"; shift; [ $# -gt 0 ] && shift ;;
    *) shift ;;
  esac
done

# 必须在 git 仓库内
root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "FAIL: 不在 git 仓库内"; exit 0; }

branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "detached")
main_root=$(git -C "$root" worktree list --porcelain | awk 'NR==1&&$1=="worktree"{print $2}')

# 检测默认分支名
default_branch=$(git -C "$main_root" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##') || true
[ -z "${default_branch:-}" ] && default_branch=main

# 检查1: 是否在默认分支上
if [ "$branch" = "$default_branch" ] && [ "$root" = "$main_root" ]; then
  echo "FAIL: 在主 checkout 的默认分支 ($default_branch) 上，不允许直接修改"
  echo "ACTION: 执行 git-start.sh <task-slug> 起干净 worktree"
  exit 0
fi

# 检查2: 工作区是否有无关改动
dirty=$(git -C "$root" status --porcelain 2>/dev/null | head -5)
if [ -n "$dirty" ]; then
  # 如果在 worktree 里且有改动，可能是当前任务的 WIP，给警告但不 FAIL
  echo "WARN: 工作区有未提交改动:"
  echo "$dirty"
  echo "INFO: 如果是当前任务的 WIP 可以继续；如果是无关改动请先处理"
fi

# 检查3: gh auth 状态
if command -v gh &>/dev/null; then
  if ! gh auth status &>/dev/null 2>&1; then
    echo "WARN: gh auth 未登录，push/PR 操作可能失败"
  fi
fi

# 检查4: 基底新鲜度(2026-08-02 新增)。
# 背景:Cindy 自动 worktree 从陈旧本地 ref 切分支不 fetch,曾造出落后上游 1000+ commit 的工作区。
# 规则:以 upstream(存在时)否则 origin 的默认分支为基准——
#   - 分支上还没有自己的 commit(刚切出来) 且基底落后 > 阈值 → FAIL,必须重建/rebase 后再开工;
#   - 分支已有自己的 commit(在途工作) 且基底落后 > 阈值 → WARN,建议尽快 merge 最新基准分支。
# 阈值可用 PREFLIGHT_MAX_BEHIND 覆盖,默认 200。
max_behind=${PREFLIGHT_MAX_BEHIND:-200}
base_remote=origin
git -C "$main_root" remote get-url upstream >/dev/null 2>&1 && base_remote=upstream
if git -C "$main_root" remote get-url "$base_remote" >/dev/null 2>&1 && [ "$branch" != "detached" ]; then
  base_db=$(git -C "$main_root" symbolic-ref --short "refs/remotes/$base_remote/HEAD" 2>/dev/null | sed "s#^$base_remote/##") || true
  [ -z "${base_db:-}" ] && base_db=$default_branch
  # FETCH_HEAD 30 分钟内更新过就跳过 fetch(保活 schedule 每 2h 刷一次,这里只兜底)
  need_fetch=1
  [ -n "$(find "$main_root/.git/FETCH_HEAD" -mmin -30 2>/dev/null)" ] && need_fetch=0
  if [ "$need_fetch" = 1 ]; then
    git -C "$main_root" fetch --quiet "$base_remote" "$base_db" 2>/dev/null || echo "WARN: fetch $base_remote 失败,按本地已有 ref 判断新鲜度"
  fi
  base_ref="$base_remote/$base_db"
  if git -C "$root" rev-parse --verify --quiet "$base_ref" >/dev/null; then
    mb=$(git -C "$root" merge-base HEAD "$base_ref" 2>/dev/null) || mb=""
    if [ -n "$mb" ]; then
      behind=$(git -C "$root" rev-list --count "$mb..$base_ref" 2>/dev/null || echo 0)
      ahead=$(git -C "$root" rev-list --count "$mb..HEAD" 2>/dev/null || echo 0)
      if [ "$behind" -gt "$max_behind" ] && [ "$ahead" -eq 0 ]; then
        echo "FAIL: 基底陈旧——当前分支尚无自己的 commit,而基底落后 $base_ref $behind 个 commit(阈值 $max_behind)"
        echo "ACTION: 不要在这个 worktree 上开工。执行 git-start.sh <task-slug> 从最新 $base_ref 重建;或 git fetch $base_remote && git rebase $base_ref"
        exit 0
      fi
      if [ "$behind" -gt "$max_behind" ]; then
        echo "WARN: 基底落后 $base_ref $behind 个 commit(在途工作,ahead=$ahead)。收口前先 merge 最新 $base_ref,否则 PR diff 和 CI 都会失真"
      fi
    fi
  fi
fi

# 检查5: 分支归属校验(2026-08-04 新增)。
# 背景:总管的 tracked[] 记着每个在飞 PR 的 owner 会话,但没有任何东西阻止别的会话往这个分支写。
# 两个 agent 会各自决定、推出方向相反的 commit,而双方都收不到警告。
# 2026-08-04 实踩:#1581 的 owner 是 6340563b,另一个会话 a22fba91 接了转交后往同一分支 push 了
# 3 个 commit、resolve 了 5 条线程、还把 PR 转成 draft。两人分别加了「失败就交还写入权」与
# 「超时不回滚代际、保持单调」——同一段代际语义被两个相反取向叠在一起,谁接手都得重判一次。
sweeps_dir="${GIT_WORKFLOW_SWEEPS_DIR:-$HOME/.agents/skills/git-workflow/sweeps}"
if [ "$branch" != "detached" ] && [ -d "$sweeps_dir" ] && command -v node >/dev/null 2>&1; then
  hit=$(node -e '
    const fs = require("fs"), path = require("path");
    const [dir, br] = process.argv.slice(1);
    let out = "";
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json") || f.startsWith("_")) continue;
        let cfg; try { cfg = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
        for (const t of (cfg.tracked || [])) {
          if (t.branch === br) { out = [t.owner || "", t.number, cfg.repo || ""].join("\t"); break; }
        }
        if (out) break;
      }
    } catch {}
    process.stdout.write(out);
  ' "$sweeps_dir" "$branch" 2>/dev/null) || hit=""

  if [ -n "$hit" ]; then
    t_owner=$(printf '%s' "$hit" | cut -f1)
    t_pr=$(printf '%s' "$hit" | cut -f2)
    t_repo=$(printf '%s' "$hit" | cut -f3)
    # owner 会话还活着才算「有人正在跟进」;archived/deleted 的不拦路
    owner_status=""
    if [ -n "$t_owner" ]; then
      db=$(ls "$HOME/Library/Application Support/Cindy/"cindy-*.db 2>/dev/null | head -1)
      if [ -n "$db" ] && command -v sqlite3 >/dev/null 2>&1; then
        owner_status=$(sqlite3 -readonly "$db" "SELECT status FROM sessions WHERE id='$t_owner'" 2>/dev/null || echo "")
      fi
    fi
    if [ -z "$t_owner" ]; then
      echo "WARN: 本分支登记在 $t_repo#$t_pr 的跟踪里,但 owner 空缺(自动补登记没找到会话)"
      echo "INFO: 收口前用 hb-register.mjs 重新登记补上 owner,否则 review 转交会永久悬空"
    elif [ -n "$self_session" ] && [ "$self_session" = "$t_owner" ]; then
      : # 就是 owner 自己,静默通过
    elif [ -n "$self_session" ]; then
      echo "FAIL: 本分支属于 $t_repo#$t_pr,owner 是 ${t_owner:0:8}… 而本会话是 ${self_session:0:8}…"
      echo "ACTION: 不要在这个分支上写。把意见交回 owner 会话处理;确实要转移 owner 先与用户确认,再用 hb-register.mjs 重新登记覆盖。"
      exit 0
    elif [ "$owner_status" = "active" ]; then
      echo "WARN: 本分支属于 $t_repo#$t_pr,已登记 owner=${t_owner:0:8}…(该会话当前 active)"
      echo "ACTION: 用宿主 get_current_session_id 核对这是否是你自己。不是你 → 立即停手,别往别人在跟进的分支上写(#1581 实踩:两个会话推出方向相反的 commit)。是你 → 以后带 --session <id> 调用本脚本可静默通过。"
    else
      echo "INFO: 本分支属于 $t_repo#$t_pr,登记 owner=${t_owner:0:8}…(会话状态 ${owner_status:-未知},非 active)"
    fi
  fi
fi

echo "PASS: branch=$branch root=$root"
