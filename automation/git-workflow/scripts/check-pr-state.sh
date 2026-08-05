#!/usr/bin/env bash
# check-pr-state.sh <pr-number> [repo] — PR heartbeat pre-run gate.
# First-line protocol (kept backward-compatible):
#   NO_CHANGE
#   CHANGED: ... actionable=yes|no
#   TERMINAL: ...
#   FAIL: ...
# Persistent actionable state is reminded with exponential backoff instead of once-only edges.
# Settle window: bot-review-only actionable is held (NO_CHANGE) while review bots are still
# posting or checks are still running, so 2-3 bots' feedback lands as ONE handoff wave.
# Hard blockers (failed checks / conflict / human review or comment) bypass the hold.
set -euo pipefail

pr=${1:?用法: check-pr-state.sh <pr-number> [owner/repo]}
repo=${2:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || printf '')}
[ -n "$repo" ] || { printf 'FAIL: 无法确定仓库，请传入 owner/repo\n'; exit 0; }

cache_dir="${PR_HEARTBEAT_CACHE_DIR:-${HOME}/.cache/git-workflow-heartbeat}"
cache_prefix="$cache_dir/${repo//\//_}_pr${pr}"
cache_file="${cache_prefix}.fingerprint"
wake_key_file="${cache_prefix}.actionable-key"
wake_at_file="${cache_prefix}.last-wake"
wake_count_file="${cache_prefix}.wake-count"
settle_hold_file="${cache_prefix}.settle-hold"
retry_base=${PR_HEARTBEAT_RETRY_BASE_SECONDS:-1800}
retry_max=${PR_HEARTBEAT_RETRY_MAX_SECONDS:-21600}
settle_secs=${PR_HEARTBEAT_SETTLE_SECONDS:-600}
settle_max=${PR_HEARTBEAT_SETTLE_MAX_SECONDS:-2700}
review_bots=${PR_HEARTBEAT_REVIEW_BOTS:-"chatgpt-codex-connector,greptile-apps,copilot-pull-request-reviewer,magiclizi,coderabbitai"}
wake_was_reminder=no
mkdir -p "$cache_dir"

case "$retry_base" in ''|*[!0-9]*) retry_base=1800 ;; esac
case "$retry_max" in ''|*[!0-9]*) retry_max=21600 ;; esac
[ "$retry_max" -ge "$retry_base" ] || retry_max=$retry_base
case "$settle_secs" in ''|*[!0-9]*) settle_secs=600 ;; esac
case "$settle_max" in ''|*[!0-9]*) settle_max=2700 ;; esac
[ "$settle_max" -ge "$settle_secs" ] || settle_max=$settle_secs

fail() {
  printf 'FAIL: %s\n' "$1"
  exit 0
}

add_reason() {
  if [ -z "$reasons" ]; then
    reasons=$1
  else
    reasons="$reasons,$1"
  fi
}

backoff_delay() {
  local attempt=$1
  local delay=$retry_base
  local i=1
  while [ "$i" -lt "$attempt" ] && [ "$delay" -lt "$retry_max" ]; do
    delay=$((delay * 2))
    [ "$delay" -le "$retry_max" ] || delay=$retry_max
    i=$((i + 1))
  done
  printf '%s\n' "$delay"
}

record_wake() {
  local key=$1
  local now=$2
  local attempt=$3
  printf '%s\n' "$key" > "$wake_key_file"
  printf '%s\n' "$now" > "$wake_at_file"
  printf '%s\n' "$attempt" > "$wake_count_file"
}

wake_is_due() {
  local key=$1
  local now=$2
  local old_key='' last_wake=0 attempt=0 delay

  [ -f "$wake_key_file" ] && old_key=$(<"$wake_key_file")
  if [ "$old_key" != "$key" ]; then
    wake_was_reminder=no
    record_wake "$key" "$now" 1
    return 0
  fi

  [ -f "$wake_at_file" ] && last_wake=$(<"$wake_at_file")
  [ -f "$wake_count_file" ] && attempt=$(<"$wake_count_file")
  case "$last_wake" in ''|*[!0-9]*) last_wake=0 ;; esac
  case "$attempt" in ''|*[!0-9]*) attempt=0 ;; esac
  delay=$(backoff_delay "$attempt")
  if [ $((now - last_wake)) -lt "$delay" ]; then
    return 1
  fi

  attempt=$((attempt + 1))
  wake_was_reminder=yes
  record_wake "$key" "$now" "$attempt"
  return 0
}

state_json=$(gh pr view "$pr" --repo "$repo" --json author,state,reviewDecision,mergeStateStatus,mergeable,isDraft,reviewRequests,latestReviews,statusCheckRollup,comments,commits 2>/dev/null) ||
  fail "无法获取 PR #$pr 状态 (gh pr view 失败)"
printf '%s' "$state_json" | jq -e . >/dev/null 2>&1 || fail "PR #$pr 状态不是有效 JSON"

state=$(printf '%s' "$state_json" | jq -r '.state // "unknown"')
if [ "$state" = "MERGED" ] || [ "$state" = "CLOSED" ]; then
  printf '%s\n' "$state" > "$cache_file"
  printf 'TERMINAL: PR #%s is %s\n' "$pr" "$state"
  exit 0
fi

old_fingerprint=''
old_merge_status=''
old_latest_review=''
old_latest_comment=''
if [ -f "$cache_file" ]; then
  old_fingerprint=$(<"$cache_file")
  IFS='|' read -r _ _ old_merge_status _ _ _ _ _ _ old_latest_review old_latest_comment _ <<< "$old_fingerprint"
fi

pr_author=$(printf '%s' "$state_json" | jq -r '.author.login // ""')
review_decision=$(printf '%s' "$state_json" | jq -r 'if (.reviewDecision // "") == "" then "none" else .reviewDecision end')
merge_status=$(printf '%s' "$state_json" | jq -r '.mergeStateStatus // "unknown"')
mergeable=$(printf '%s' "$state_json" | jq -r '.mergeable // "UNKNOWN"')
comments_count=$(printf '%s' "$state_json" | jq -r '.comments | length')
latest_commit=$(printf '%s' "$state_json" | jq -r '.commits[-1].oid // "none"')
checks_summary=$(printf '%s' "$state_json" | jq -r '[.statusCheckRollup[]? | .conclusion // .status] | sort | join(",")')
changes_requested=$(printf '%s' "$state_json" | jq -r '[.latestReviews[]? | select(.state == "CHANGES_REQUESTED")] | length')
latest_external_review=$(printf '%s' "$state_json" | jq -r --arg owner "$pr_author" '[.latestReviews[]? | select((.author.login // "") != $owner and (.state == "CHANGES_REQUESTED" or .state == "COMMENTED"))] | sort_by(.submittedAt // "") | last // {}')
latest_review_marker=$(printf '%s' "$latest_external_review" | jq -r '[.id // "none", .author.login // "", .state // "", .submittedAt // ""] | join("@")')
# Known auto-review/auto-merge bots whose repeated nag comments must NOT count as new events
# (2026-07 data: no nag filter => pre-run gate passed 94% of rounds). Override via PR_HEARTBEAT_NAG_BOTS.
nag_bots=${PR_HEARTBEAT_NAG_BOTS:-"magiclizi,greptile-apps,copilot-pull-request-reviewer,chatgpt-codex-connector,coderabbitai"}
latest_external_comment=$(printf '%s' "$state_json" | jq -r --arg bots "$nag_bots" '
  ($bots | split(",") | map(ascii_downcase)) as $b
  | [.comments[]? | select(.viewerDidAuthor != true)
      | select((((.author.login // "") | ascii_downcase | sub("\\[bot\\]$"; "")) as $a | ($b | index($a)) | not))]
  | sort_by(.createdAt // "") | last // {}')
latest_comment_marker=$(printf '%s' "$latest_external_comment" | jq -r '[.id // "none", .author.login // "", .createdAt // ""] | join("@")')

# Settle inputs: latest review-bot activity epoch + whether checks are still running.
latest_bot_epoch=$(printf '%s' "$state_json" | jq -r --arg bots "$review_bots" '
  ($bots | split(",") | map(ascii_downcase)) as $b
  | def isbot: (((.author.login // "") | ascii_downcase | sub("\\[bot\\]$"; "")) as $a | ($b | index($a)) != null);
  ([.latestReviews[]? | select(isbot) | .submittedAt // empty]
   + [.comments[]? | select(isbot) | .createdAt // empty])
  | map(select(. != "") | fromdateiso8601) | (max // "") | tostring' 2>/dev/null || printf '')
case "$latest_bot_epoch" in ''|*[!0-9]*) latest_bot_epoch='' ;; esac
pending_checks=no
if printf '%s' "$checks_summary" | grep -Eqi 'PENDING|IN_PROGRESS|QUEUED|EXPECTED|WAITING|REQUESTED'; then
  pending_checks=yes
fi
latest_review_author=$(printf '%s' "$latest_external_review" | jq -r '(.author.login // "") | ascii_downcase | sub("\\[bot\\]$"; "")')

if [ "$merge_status" = "UNKNOWN" ] && [ -n "$old_merge_status" ]; then
  merge_status=$old_merge_status
fi

repo_owner=${repo%%/*}
repo_name=${repo##*/}
threads_json=$(gh api graphql -f query='query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:100){nodes{isResolved}}}}}' -F o="$repo_owner" -F n="$repo_name" -F p="$pr" 2>/dev/null) ||
  fail "无法获取 PR #$pr reviewThreads"
unresolved_threads=$(printf '%s' "$threads_json" | jq -er 'if (.data.repository.pullRequest.reviewThreads.nodes | type) == "array" then [.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length else error("missing reviewThreads") end' 2>/dev/null) ||
  fail "PR #$pr reviewThreads 响应无效"

fingerprint="${state}|${review_decision}|${merge_status}|${comments_count}|${latest_commit}|${checks_summary}|${changes_requested}|${unresolved_threads}|${mergeable}|${latest_review_marker}|${latest_comment_marker}|v2"
reasons=''
persistent_actionable=no
event_actionable=no

if [ "$unresolved_threads" -gt 0 ]; then
  persistent_actionable=yes
  add_reason threads
fi
if printf '%s' "$checks_summary" | grep -Eqi 'FAILURE|ERROR|TIMED_OUT|CANCELLED|STARTUP_FAILURE'; then
  persistent_actionable=yes
  add_reason checks
fi
if [ "$mergeable" = "CONFLICTING" ] || [ "$merge_status" = "DIRTY" ]; then
  persistent_actionable=yes
  add_reason conflict
fi

if [ -n "$old_fingerprint" ] && [ "$latest_review_marker" != "$old_latest_review" ] && [ "$latest_review_marker" != "none@@@" ]; then
  event_actionable=yes
  add_reason review
fi
if [ -n "$old_fingerprint" ] && [ "$latest_comment_marker" != "$old_latest_comment" ] && [ "$latest_comment_marker" != "none@@" ]; then
  event_actionable=yes
  add_reason comment
fi

changed=no
[ "$fingerprint" != "$old_fingerprint" ] && changed=yes

actionable=no
[ "$persistent_actionable" = yes ] && actionable=yes
[ "$event_actionable" = yes ] && actionable=yes

# Settle window: hold bot-review-only actionable while bots are still posting / checks running,
# so one wave = one wake. Fingerprint & wake state stay untouched during the hold.
if [ "$actionable" = yes ]; then
  settle_bypass=no
  case ",$reasons," in
    *,checks,*|*,conflict,*) settle_bypass=yes ;;
  esac
  if [ "$settle_bypass" = no ] && [ "$event_actionable" = yes ]; then
    case ",$reasons," in *,comment,*) settle_bypass=yes ;; esac  # human comment (bots filtered upstream)
    if [ "$settle_bypass" = no ]; then
      case ",$reasons," in
        *,review,*)
          bot_review=no
          case ",$(printf '%s' "$review_bots" | tr 'A-Z' 'a-z')," in
            *",$latest_review_author,"*) bot_review=yes ;;
          esac
          [ "$bot_review" = no ] && settle_bypass=yes  # human review
          ;;
      esac
    fi
  fi
  if [ "$settle_bypass" = no ]; then
    now=$(date +%s)
    settle_recent=no
    if [ -n "$latest_bot_epoch" ] && [ $((now - latest_bot_epoch)) -lt "$settle_secs" ]; then
      settle_recent=yes
    fi
    [ "$pending_checks" = yes ] && settle_recent=yes
    if [ "$settle_recent" = yes ]; then
      hold_since=$now
      if [ -f "$settle_hold_file" ]; then
        hold_since=$(<"$settle_hold_file")
        case "$hold_since" in ''|*[!0-9]*) hold_since=$now ;; esac
      else
        printf '%s\n' "$now" > "$settle_hold_file"
      fi
      if [ $((now - hold_since)) -lt "$settle_max" ]; then
        printf 'NO_CHANGE\n'
        exit 0
      fi
    fi
  fi
fi
rm -f "$settle_hold_file" 2>/dev/null || true

if [ "$changed" = yes ]; then
  printf '%s\n' "$fingerprint" > "$cache_file"
fi

if [ "$actionable" = yes ]; then
  if [ "$persistent_actionable" = yes ]; then
    # Owner push / own comments must not reset the delivery cooldown for the same open work.
    action_key="persistent|${unresolved_threads}|${checks_summary}|${mergeable}|${merge_status}|${latest_review_marker}|${latest_comment_marker}"
  else
    action_key="event|${latest_review_marker}|${latest_comment_marker}"
  fi
  now=$(date +%s)
  if wake_is_due "$action_key" "$now"; then
    printf 'CHANGED: state=%s review=%s merge=%s mergeable=%s comments=%s commit=%s checks=%s cr=%s threads=%s reasons=%s reminder=%s actionable=yes\n' \
      "$state" "$review_decision" "$merge_status" "$mergeable" "$comments_count" "${latest_commit:0:7}" "$checks_summary" "$changes_requested" "$unresolved_threads" "$reasons" "$wake_was_reminder"
    exit 0
  fi
  printf 'NO_CHANGE\n'
  exit 0
fi

if [ "$changed" = yes ]; then
  printf 'CHANGED: state=%s review=%s merge=%s mergeable=%s comments=%s commit=%s checks=%s cr=%s threads=%s reasons=none reminder=no actionable=no\n' \
    "$state" "$review_decision" "$merge_status" "$mergeable" "$comments_count" "${latest_commit:0:7}" "$checks_summary" "$changes_requested" "$unresolved_threads"
else
  printf 'NO_CHANGE\n'
fi
