# PR 自动化整套方案(给 Cindy 配置用)

这是一套**让 AI agent 安全地写代码、发 PR、消化 review、并且不失控**的完整方案,从真实多机工程环境中提炼(版本 v4.7,2026-08-05)。核心思想一句话:

> **纪律写进 skill,侦测交给零成本脚本,编排交给便宜订阅模型,改码只留给唯一 owner 会话——每一层都有闸,闸与闸成对出现。**

## 架构:三层分工

```
第 1 层  预检脚本(preRunHook,零 token)
         pr-gw-hb-v4-luna.mjs 每 30 分钟侦测 GitHub live 状态,
         没事 exit 2(本轮连模型都不唤醒),有事才放行
              ↓ 事件(_pending.json)
第 2 层  PR 总管(订阅通道便宜模型,只转交不改码)
         消化完整 review 批次 → 意图锚点 + 三分法预归类 → 投递给 owner
              ↓ HANDOFF(带意图锚点)
第 3 层  owner session(主力模型,唯一改码者)
         1 会话 = 1 PR = 1 worktree = 1 意图契约
```

## 三道闸(位置不同,不可互相替代)

| 闸 | 位置 | 工具 | 判据 |
|---|---|---|---|
| 入口 | 开 ready PR 前 | `pr-size-gate.mjs` | 非测试代码 WARN 150 行 / STOP 300 行;意图契约未填不放行 |
| 过程 | review 循环中 | 「3 轮硬上限」(skill 条款) | 第 4 轮 address-review 即冻结,`hb-register --pause` + 问用户三选一 |
| push 侧 | 每次 push 前 | `pr-drift-check.mjs` | 循环强度 / 规模漂移 / 悬空线程 / 绝对规模 / 工具链容量 五项 |

为什么是三道:开局就贪大的 PR 没有漂移可测(只有入口闸能拦);过程闸拦"每轮单看都合理"的渐进膨胀;push 闸是最后的机械核查。2026-08 实测:实现面 54 行的 PR 一轮合并,292 行跑 4 轮,450 行振荡 8 轮后报废——**规模与 review 轮数是断崖关系**。

## 安装

### 1. skill 部分(纪律文本 + 脚本)

```bash
# 拷进共享 skill 目录
rsync -a automation/git-workflow/ ~/.agents/skills/git-workflow/
rsync -a automation/agent-ops/    ~/.agents/skills/agent-ops/

# 给 Claude Code / Codex 建软链
ln -sfn ~/.agents/skills/git-workflow ~/.claude/skills/git-workflow
ln -sfn ~/.agents/skills/git-workflow ~/.codex/skills/git-workflow
ln -sfn ~/.agents/skills/agent-ops    ~/.claude/skills/agent-ops
ln -sfn ~/.agents/skills/agent-ops    ~/.codex/skills/agent-ops
```

### 2. sweeps 仓库配置(每个要跟踪的 repo 一份)

`~/.agents/skills/git-workflow/sweeps/<owner>_<repo>.json`:

```json
{
  "repo": "your-org/your-repo",
  "author": "your-github-login",
  "localRepo": "/path/to/local/checkout",
  "reviewBots": [
    { "type": "review", "login": "your-review-bot" },
    { "type": "check",  "name": "verify" }
  ],
  "tracked": [],
  "ignore": []
}
```

- `reviewBots` 声明"必须等齐哪些信号才转交"——这是**批次握手**的关键:bot 还在陆续出意见时压住不放行,全部安静后一波合并成一条转交,owner 不会被逐条唤醒。
- `tracked[]` 不要手填,由 `hb-register.mjs` 写入(带锁 + 原子写 + 回读)。
- `_pending.json` / `_coordinator-state.json` 是**机器本地运行时状态**,不入库、换机不迁移。

### 3. 建 PR 总管 schedule(Cindy 的 cindy_scheduler)

用 `schedule_create` 创建,关键参数:

| 参数 | 值 | 为什么 |
|---|---|---|
| `cronExpr` | `*/30 * * * *` | 预检零成本,节奏可以密;总管本体只在有事时被唤醒 |
| `agentKind` / `model` | 订阅计费通道的中档模型 | 巡检层**绝不用按 token 计价的主力模型**;haiku 档实测不可靠(谎报/漏查) |
| `effort` | max | 消化 review 正文需要判断力 |
| `workingDir` | sweeps 目录 | |
| `silentWhenIdle` | `true` | |
| `notify` | 全关 | 总管永不直接通知用户(见下面通知纪律) |
| `prompt` | `git-workflow/references/pr-coordinator-prompt.md` 的「Prompt 全文」逐字贴入 | **机器专属路径要改成本机的**;改 prompt 前先读该文件的「与 skill 的契约」表 |

### 4. 装 preRunHook(必须走宿主通道)

**必须经 Cindy 的 `schedule_set_pre_run_hook` 工具安装**(传 `scheduleId` + `agent-ops/schedule-checks/pr-gw-hb-v4-luna.mjs` 的内容),不要自己写文件手填 `preRunHook.command`——宿主统一保证落盘路径、协议,并且**落盘后立即自测**把结果回传。

协议:`exit 0` 放行 / `exit 2` 跳过本轮(零 token)/ 其它异常 **fail-closed** 阻止本轮。脚本内任何意外失败必须非零退出,不许 catch 后装作没事。

### 5. 日常使用(owner 侧)

```bash
# 开工:从远端默认分支起隔离 worktree(自动生成意图契约模板)
bash ~/.agents/skills/git-workflow/scripts/git-start.sh <task-slug>

# 任何写操作前
bash ~/.agents/skills/git-workflow/scripts/preflight.sh --session <会话id>

# 开 ready PR 前
node ~/.agents/skills/git-workflow/scripts/pr-size-gate.mjs

# PR 发布后立即登记(收口三件套之一,漏了=自动跟进失联)
node ~/.agents/skills/git-workflow/scripts/hb-register.mjs <owner/repo> <PR号> \
  --owner <会话id> --branch <分支> --worktree <绝对路径> --brief <一句话>

# review 修复第二轮起,push 前
node ~/.agents/skills/git-workflow/scripts/pr-drift-check.mjs <PR号>

# 人为叫停一个仍 OPEN 的 PR(冻结跟进,不是删除)
node ~/.agents/skills/git-workflow/scripts/hb-register.mjs <owner/repo> <PR号> --pause "原因"

# PR 合并/关闭后(收口)
node ~/.agents/skills/git-workflow/scripts/hb-register.mjs <owner/repo> <PR号> --remove "原因"
```

## 事件类型(预检产出 → 总管转交)

| 事件 | 触发条件 | 总管动作 |
|---|---|---|
| `facts` | 新 head 的完整评审批次收齐(checks 终态 + 声明的 bot 全出) | 意图锚点 + 三分法预归类 → 投 owner |
| `conflict` | 与 base 冲突 | 提醒先 merge main 再继续(硬阻塞直通,不等 bot) |
| `behind` | **已 approve 但分支落后 base**(仓库要求 up-to-date 时这是唯一阻断,却既无 unresolved 线程也不是 conflict——老口径会当"干净"漏掉) | 提醒 update-branch,绿后交仓库方合并;**禁止 agent 自己合并** |
| `gate` | product-gate 卡点超 12h | 提醒 owner 按固定动作催办 |
| `stale` | PR 干净但干等 review/合并超 10h | 提醒 owner 催人 |
| `ttl` | 跟踪超 7 天 | 提醒 owner 决定去留 |
| `terminal` | PR 合并/关闭 | 提醒 owner 走收口三件套(fetch 核对 → --remove → 改标题) |
| `fail` | 预检自身失败 / owner 失联 | 只报告,绝不接管 |

## 防失控的关键机制(蒸馏重点)

1. **意图契约落盘**:worktree 的 `cindy-intent.md` 写死「目标一句话 + 非目标 + 验收清单」。每份 review 转交把它原文抛在最前面,owner 对每条意见先答"这解决的是不是目标句里的问题"——**临场判断必输,因为每条意见单看都合理**。
2. **意见三分法**:修(同时满足"服务于目标句"+"必须留在本 PR")/ 答(误读过时,证据回复 + resolve)/ **推(加固、邻域补全、通用能力——即使是真问题也默认外推 issue)**。
3. **owner 唯一性**:转交只投登记的 owner 会话,收到转交第一动作是核对自己的会话 id;双会话写同一分支是 PR 报废的头号原因。
4. **owner 忙碌不打扰**:预检直接查宿主 DB 判断 owner 是否在跑 turn,忙就压住事件下轮再投——绝不排队加塞。
5. **通知纪律**:总管每轮无论做了什么一律静默;需要用户拍板的,经 owner 会话转达(owner 的会话有上下文,用户回复不会落空)。
6. **多机纪律**:GitHub 是全账号视图,`origin/*` 一次 fetch 全量同步——都不构成"本机在做"的证据。断言归属前三查:宿主 DB 会话绑定 / sweeps 登记 / 本地 `refs/heads`。三查全空只读不处置。
7. **每条硬规则后面带日期 + 实踩案例**——没有案例的规则会被后人当冗余"优化"掉。

## 目录

```
automation/
├── README.md                          ← 本文件
├── git-workflow/
│   ├── SKILL.md                       ← 工作流纪律全文(owner 侧执行标准)
│   ├── references/
│   │   ├── pr-coordinator-prompt.md   ← PR 总管 prompt 正本 + 与 skill 的契约表 + 变更记录
│   │   └── heartbeat.md               ← 心跳/转交协议细节(维护总管时才读)
│   └── scripts/                       ← 三道闸 + 登记 + worktree 工具
└── agent-ops/
    ├── SKILL.md                       ← 自动化与编排纪律(建 loop / 开 subagent 的门禁)
    ├── schedule-checks/               ← preRunHook 协议说明 + 总管预检脚本
    └── schedules/                     ← schedule 设计规范(七段骨架)与迁移 runbook
```

## 已知边界

- prompt 正本和 SKILL.md 里保留了大量真实事故案例(PR 号来自公开仓库),这是刻意的——见上面第 7 条。
- 脚本假定 `gh` 已登录、宿主是 Cindy(会话 DB、`schedule_set_pre_run_hook`、`send_to_session` 等均为 Cindy 能力);换宿主需要替换这几个接口。
- 各文件内的绝对路径已归一为 `~`,部署时按本机实际路径调整(schedule prompt 里的路径必须写绝对路径)。
