# Cindy 定时任务的前置检查（preRunHook）

**前置检查是自动化的第一道闸,也是唯一一道零成本的闸。**它在 agent 被唤醒之前跑,用退出码决定这一轮要不要烧 token。没有它,一个 `*/30` 的任务每天要空转 48 次;有了它,只有真正有事的轮次才会启动 agent。

本目录是本机全部 preRunHook 脚本的**备份正本**。活的脚本不在这里(见下面的「活的位置」),这里是 git 兜底——2026-08-04 盘点发现三个位置全部没有备份:`~/scripts/schedule-checks/` 不在任何 git 仓库、cindy 仓的被 `.git/info/exclude` 排除、cindy-official-plugins 仓的是 untracked。换机或误删就全丢,而这些脚本一旦丢失,自动化不会报错——它只会开始每轮空转烧钱。

---

## 协议(宿主定义,不可自创)

| 退出码 | 含义 | 结果 |
|---|---|---|
| `0` | 放行 | 启动 agent,跑这一轮 |
| `2` | 跳过 | 本轮静默结束,**不消耗任何 token** |
| 其它 / 超时 / 抛异常 | 异常 | **fail-closed**:阻止本轮并记录失败 |

fail-closed 是刻意的:预检脚本自己坏了的时候,宁可不跑,也不要让 agent 在信息不全的情况下动手。所以脚本里任何意外失败都必须非零退出,**不许 catch 后返回 0 装作没事**。

## 怎么设置(唯一通道)

**必须经 `cindy_scheduler` 的 `schedule_set_pre_run_hook` 工具**创建或修改,不要自己写脚本文件再手填 `preRunHook.command`。理由:宿主代码统一保证落盘路径规范、协议正确,并且**落盘后立即自测**并把决策结果返回给你。

```
schedule_set_pre_run_hook({
  scheduleId: "<任务 id>",   // 传了就自动继承该任务的目录/名称,并在安装成功后直接挂载
  script: "<Node ESM 源码>"  // 有项目上下文时优先自己写;需求很通用时改传 description 让宿主生成
})
```

- 返回值里的 `test` 字段是**刚跑完的自测结果**。决策不符合预期(该放行却 skip、该 skip 却放行)就修了再来,不要把没自测通过的脚本留给任务。
- 不传 `scheduleId` 则只落盘并返回 `command`,由你随后在 `schedule_create` 里带上。
- 脚本用 **Node ESM,只能用 node 内置模块**;要调外部命令走 `child_process`(`gh`、`sqlite3` 等)。

## 落盘位置规范

| 任务类型 | 脚本位置 | 备份状态 |
|---|---|---|
| 有项目目录的 | `<项目>/scripts/schedule-checks/` | 各项目自理;cindy 仓走 `.git/info/exclude`(不进公司上游),cindy-official-plugins 仓 untracked ——**两者都靠本目录兜底** |
| 无项目目录的 | `~/scripts/schedule-checks/` | 不在任何 git 仓库 ——**完全靠本目录兜底** |

## 活的位置(恢复时复制回去)

| 脚本 | 服务的 schedule | 活的路径 |
|---|---|---|
| `pr-gw-hb-v4-luna.mjs` | PR 总管 · gw-hb/v4 (luna) | `~/scripts/schedule-checks/` |
| `pi-issue-makecindy-cindy.mjs` | PI Issue 自动修复 · makecindy/cindy | `~/scripts/schedule-checks/` |
| `cindy-server.mjs` | 模型目录官方校准 · cindy-server | `~/scripts/schedule-checks/` |
| `makecindy-cindy.mjs` | 签字门巡检 · makecindy/cindy | `~/Code/Github/cindy/scripts/schedule-checks/` |
| `pr-cindy-official-plugins.mjs` | 插件仓 PR 巡检 | `~/Code/Github/cindy-official-plugins/scripts/schedule-checks/` |
| `signoff-board/*` | 签字门看板(非 preRunHook,是配套的看板服务与对比稿模板) | `~/Code/Github/cindy/scripts/schedule-checks/` |

恢复后要核对 schedule 的 `preRunHook.command` 指向的绝对路径与实际落点一致;路径不符时 fail-closed 会让任务**每轮都失败**(而不是空转),这一点反而容易发现。

## 各脚本在拦什么

- **`pr-gw-hb-v4-luna.mjs`(19KB,最复杂)** — head 批次握手。只在「出现新 head 且 checks 终态 + 仓库声明的全部 review bot 都完成了该 head」或有独立 gate/stale/ttl/terminal/fail/conflict 事件时放行。它维护 `~/.agents/skills/git-workflow/sweeps/_pending.json` 事件表与 `_coordinator-state.json` 指纹。**只侦测、落状态,不投递、不改 PR**。它是「bot 意见等出齐再转交」这条纪律的执行者——没有它,owner 会被逐 bot 逐条唤醒。
- **`makecindy-cindy.mjs`** — 签字门口径过滤:`body` 含「由 review-pr 流程自动创建」且 `title/body` 含「产品」或「product」的 open issue;维护 `~/.cindy/schedule-state/signoff-gate.makecindy-cindy.json` 的 prev/current 供巡检轮识别新增与消失。
- **`pr-cindy-official-plugins.mjs`** — 插件仓 open PR 快照与变化侦测。
- **`pi-issue-makecindy-cindy.mjs`** — 把 PI 候选 issue 快照写到 `~/.cindy/schedule-state/pi-issues-live.makecindy-cindy.json`,供协调器做归属判定(自己方 vs 外部)。
- **`cindy-server.mjs`** — 模型目录校准的前置闸:已有同类 open PR 时静默跳过,避免开第二张。

## 改动纪律

1. 改活的脚本 → 用 `schedule_set_pre_run_hook` 重新安装(**它会自测**)→ 确认 `test` 结果符合预期。
2. 把新版复制回本目录 → commit 进 `zqchris/skills`。
3. 阈值/口径类改动(例如「等哪些 bot」「多久算 stale」)要同步检查对应 schedule prompt 里的描述是否还成立——预检与 prompt 描述不一致时,agent 会按 prompt 的描述行事而实际收不到事件,这种失配**不报错、只是永远不触发**,最难发现。

## 与 git-workflow 的关系

`pr-gw-hb-v4-luna.mjs` 是 PR 总管的眼睛,总管 prompt 的正本存档在 `git-workflow/references/pr-coordinator-prompt.md`(含与 skill 的逐条配对表)。两者加上 `git-workflow/sweeps/` 下的状态文件构成完整链路:

```
预检脚本(本目录) → _pending.json 事件 → 总管 agent(prompt 存档在 git-workflow/references/)
   → 意图锚点 + 三分法归类 → owner session(纪律在 git-workflow/SKILL.md)
```

链路上任一环的改动都要回头看另外两环。
