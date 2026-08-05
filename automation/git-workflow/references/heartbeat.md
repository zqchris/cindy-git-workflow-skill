# PR 总管协议（gw-hb/v4.2）

只在维护全局 PR 总管 schedule、pre-run hook、`sweeps/*.json` 数据结构或排障投递链时读取本文件。普通开发、ready PR 登记和 review follow-up 不读取；登记直接运行 `scripts/hb-register.mjs`。

## 当前结构

- 全局只有一条 schedule：`PR 总管 · gw-hb/v4 (luna)`。
- schedule 使用 `executionMode=agent`、`agentKind=codex`、`model=gpt-5.6-luna`、`persistentSession=false`、`silentWhenIdle=true`，cron 为 `*/15 * * * *`。
- pre-run hook：`~/scripts/schedule-checks/pr-gw-hb-v4-luna.mjs`。它在零 token 路径扫描所有仓配置并更新 `_pending.json`；无到期事件时 exit 2，不唤醒模型。
- 总管只读 live PR 状态、消化批次并投递真实 owner session；不修码、不评论、不 resolve、不 push、不合并、不碰 worktree。
- 全局 schedule 是常驻基础设施。tracked 为空时保持 active，由 pre-run 静默跳过；不得因某个 PR/repo 终态删除或 pause 全局 schedule。

## Canonical 数据

每仓一份 `~/.agents/skills/git-workflow/sweeps/<owner>_<repo>.json`：

```json
{
  "repo": "owner/repo",
  "author": "zqchris",
  "reviewBots": [
    { "type": "review", "login": "chatgpt-codex-connector" },
    { "type": "check", "name": "Greptile Review" }
  ],
  "notes": [],
  "tracked": [
    {
      "number": 123,
      "owner": "host-session-uuid",
      "branch": "feature-branch",
      "worktree": "/absolute/path",
      "addedAt": "2026-08-02T00:00:00+00:00",
      "deadline": "2026-08-09T00:00:00+00:00",
      "brief": "一句话"
    }
  ],
  "ignore": []
}
```

- tracking 主入口是本机发布 ready PR 时运行 `hb-register.mjs`;**2026-08-02 起 pre-run 另有「本机证据自动补登记」兜底**(用户裁决:漏登记 = 自动跟进失联,不可接受):每轮 `gh pr list --author <cfg.author> --state open`,只对「本机 `<cfg.localRepo>` 存在同名 head 分支」的未登记 PR 补登记(brief 带"(自动补登记)"标记),owner 从 Cindy DB `session_pr_refs` 反查 active session、查不到则落 fail 事件报告待人工绑定。其它机器发布的 PR 本机无分支,天然排除——「不接管别机 PR」的 2026-07-31 原意保持不变。配置需带 `author` 与 `localRepo` 字段。
- owner 必须来自宿主 `get_current_session_id`，不能用 Codex/Claude 内部 thread/session id。
- draft 不登记；draft 转 ready 时立即登记。
- `hb-register.mjs` 必须核对 live PR 为 OPEN、非 draft、head 分支一致，原子写入并回读；失败即发布未完整收口。
- `_pending.json` 是待交付事件；`_coordinator-state.json` 保存 head 锁、批次和最近投递状态。它们是运行态，不提交到 skills 仓库。

## 批次握手

1. owner push 新 head 后，pre-run 为该 head 收集 checks、review bot 与 unresolved thread。
2. checks 未终态或仓配置声明的 `reviewBots[]` 未齐时继续 hold；不要发送部分反馈。
3. `mergeable=CONFLICTING` 或 checks FAILURE 属硬阻塞，可带当前已有 review 直通，但仍遵守 owner 空闲门。
4. owner 空闲后，总管通读 live 正文，剔除过时/重复/误报，把所有有效问题按根因和优先级合并成每 PR 一份完整 handoff；不把低优先级真问题默认留到下一轮。同 owner 多 PR 合并成一条消息。
5. send 成功后立刻记录 `lastInformedHead=awaitingOwnerPushHead=<head>` 并删除事件；同一 head 永不二次投递，直到 owner 再 push。
6. `wake_kind=queued` 视为竞态下已交付，不追加第二条。send 失败不记已交付。

## Owner 空闲门

- 权威判据来自 Cindy 主库只读状态：turn 正在运行或输入队列非空都视为 busy。
- pre-run eligibility 先过滤 busy owner；总管投递前再核验一次。busy 时 `holdUntil=now+10min`，不投递也不排队。
- SQLite 探测失败时，总管可用 `get_chat_history` 退化判断；不得因探测失败永久卡死全链路。
- owner ARCHIVED/NOT_FOUND/DELETED 时只报告等待人工重绑；禁止自建替代会话、接管分支或把任务派给无关 session。

## 事件与终态

- facts：新 head 的 review/check 批次；按 head 只交付一次。
- conflict/checks-red：硬阻塞，空闲时优先投递。
- gate/stale：按当前 schedule prompt 的 12h/10h 阈值生成，24h 防重。
- ttl：默认登记 7 天。到期只移除该 tracked 项并通知 owner；需要继续时重新登记/续期。
- terminal：向 owner 投递终态收口，随后移除该 tracked 项并清同 PR cache/pending/coordinator 状态；保留全局 schedule。**收口不立即删 worktree/分支**——保留 ≥72h(刚合并常有 follow-up;立删会抽走 owner 会话工作目录使其变哑,2026-08-02 #1359 实踩),到期删前核对 Cindy DB 无 active session 绑定。
- fail：持续基础设施失败要通知用户；不得把失败吞成“无变化”。

## 维护门禁

1. 用 `schedule_list` / `schedule_get` 确认全局只有一条 v4 schedule，读取 live 配置后再改。
2. 修改 pre-run hook 只走 `schedule_set_pre_run_hook` 并检查自测；不要手填 command 或另建重复 schedule。
3. 修改 `_pending.json` / `_coordinator-state.json` 前重读最新文件，只改本轮处理的 key，避免覆盖并行写入。
4. repo 配置只保存稳定参数和 tracked 绑定；运行态 event/fingerprint 不写回 repo 配置。
5. 无变化时调用 `schedule_silence_current_run`；有投递、owner 失联或持续 fail 时调用 `schedule_notify_current_run`。
6. 单轮 `gh` 调用不超过 40 次，10 分钟内收口；等待 bot/人类时结束本轮，不 sleep 轮询。

## Owner handoff 格式

```text
HANDOFF·总管
#<PR> <一句话结论>
本轮完整修复清单（按优先级与根因分组）:
- <文件:行 / check> — <问题与建议改法>
状态: head <sha7> | unresolved <n> | checks <绿/红> | <MERGEABLE/CONFLICTING>
worktree: <绝对路径>
```

结尾提醒 owner 先重查 live、重读意图契约，再按 `git-workflow` Review Follow-Up 把本轮有效问题全部合批修复、自审、统一测试、一次 push。handoff 不复述完整协议。
