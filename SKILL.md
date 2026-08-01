---
name: cindy-git-workflow
description: Git 开发全周期工作流：写前检查、隔离 worktree、范围控制、安全扫描、验证、PR 创建与 review 收敛；在 Git 仓库中执行任何写操作前使用。
version: "1.0.0"
---

# Cindy Git Workflow

让编码 Agent 在 Git 仓库里安全、克制、可审计地完成开发任务。核心目标不是“尽快写代码”，而是避免污染用户工作区、控制改动范围、用可靠证据交付，并让 PR review 在有限轮次内收敛。

本 skill 是跨仓库通用基线。仓库自己的 `AGENTS.md`、`CLAUDE.md`、贡献指南、PR 模板和 CI 规则优先级更高。

## When to Use

在以下动作之前使用：

- 编辑、创建、移动或删除 Git 仓库中的文件。
- 创建分支或 worktree，执行 commit、push、开 PR/MR。
- 修复 CI、处理 review feedback、解决合并冲突。
- 用户说“实现一下”“修这个 bug”“继续处理这个 PR”。

纯只读探索可以先进行；从探索转为写入时，必须补齐本 skill 的写前检查。

## Authority and Side-Effect Boundaries

- 用户要求“看看、分析、给建议”时，默认只读，不自动改代码。
- 修改代码不等于授权 commit；commit 不等于授权 push；push 不等于授权创建 PR；创建 PR 不等于授权合并。
- 发公开评论、关闭 issue、改变 PR 描述、合并、删除远端分支等外部副作用，需要用户明确授权或仓库已有明确 standing policy。
- 不使用 `reset --hard`、`clean -fd`、强制 checkout、覆盖文件或擅自 stash 来处理不属于本任务的改动。
- 不把用户未提交的工作当成自己的改动提交、删除或“顺手整理”。

## Procedure

### 1. 读取仓库规则

进入仓库后先寻找并完整阅读适用规则：

- `AGENTS.md`
- `CLAUDE.md`
- `CONTRIBUTING.md`
- `.github/pull_request_template.md`
- 当前目录上层或子目录中的局部规则

规则冲突时遵循：用户当前明确指令 > 更具体目录规则 > 仓库级规则 > 本 skill。

### 2. 只读摸清现状

动手前至少确认：

```bash
git status --short --branch
git worktree list
git remote -v
git log -5 --oneline
```

同时阅读相关代码、测试和近期历史，回答：

1. 当前行为是什么？
2. 用户真正要改变什么？
3. 哪些行为明确不在范围内？
4. 哪些测试或运行态证据能证明完成？

能从代码和文档查到的问题不要反问用户。只把真正影响产品行为、范围或不可逆操作的决策交给用户。

### 3. 建立简短意图契约

非微小任务在写码前压成不超过 5 行：

- **目标**：一句话说明要改变什么。
- **非目标**：明确不做什么。
- **行为契约**：用户可观察到的结果。
- **失效契约**：涉及账号、会话、tab、工作区或缓存切换时，哪些旧状态必须失效。
- **验收方式**：测试、命令或人工步骤。

单文件、无状态、行为显然的小修可以省略形式化文本，但仍须在心里完成同样判断。

### 4. 执行写前门禁

如果已安装本 skill：

```bash
bash ~/.agents/skills/cindy-git-workflow/scripts/preflight.sh
```

也可以从源码目录运行：

```bash
bash scripts/preflight.sh
```

- `PASS`：可以继续。
- `WARN`：确认现有改动确属当前任务后继续。
- `FAIL`：停止写入，按提示建立隔离 worktree 或让用户决定。

不要在主 checkout 的默认分支上直接开发。默认使用独立 worktree：

```bash
bash ~/.agents/skills/cindy-git-workflow/scripts/git-start.sh <task-slug>
```

用户明确要求留在当前分支，或正在处理已有 PR 分支的 follow-up 时，可以例外，但仍要确认工作区和远端分支状态。

### 5. 写码前切片

预计 diff 超过约 300–400 行，或横跨两个以上模块/层时，先拆成可独立验证和回滚的切片：

1. schema / protocol / type 地基。
2. 核心行为。
3. UI 或调用方接线。
4. 测试和文档。
5. 机械 rename、格式化、依赖升级单独处理。

每个切片应能用一句话描述。标题需要用“以及、顺便、同时”连接两个无关动作时，通常应拆成两个 PR。

### 6. 聚焦实现

- 只修改完成目标所需的文件。
- 修 bug 时优先先写或定位能复现问题的测试。
- 不顺手重构相邻代码，不混入无关格式化。
- 新抽象必须有当前消费者；不要为假设中的未来需求先建复杂地基。
- 对异步和状态逻辑，主动检查取消、重复触发、超时、登出、切换和迟到回调。
- 改写路径时检查对应读取路径；改序列化时检查反序列化；改权限时检查所有入口。

### 7. 自审六个维度

提交前逐项检查：

1. **正确性**：空值、边界值、错误路径、竞态、幂等、状态失效。
2. **安全性**：输入验证、权限边界、注入风险、secret、敏感日志。
3. **范围**：没有夹带无关功能、重构、格式化或生成物。
4. **架构**：职责清晰、依赖方向合理、没有不必要的新依赖。
5. **可维护性**：命名清楚、无调试残留、无死代码、测试能说明行为。
6. **用户体验**：涉及 UI 时真实查看默认态、加载/空态、错误态和深色模式（如支持）。

重点审查高发问题：

- 账号、会话、工作区切换后旧 cache/intent 是否残留。
- in-flight 请求期间用户关闭、切换或重复点击会怎样。
- 是否在副作用成功前过早推进 cursor、时间戳或完成标记。
- 重试和重复 final 事件是否幂等。
- fire-and-forget 操作是否会在退出时丢失。
- 数据语义变化后旧缓存是否需要版本化或作废。

### 8. 安全门禁

Stage 后、commit 前检查文件列表和 diff：

```bash
git diff --cached --stat
git diff --cached --name-only
git diff --cached
```

敏感文件至少包括：

- `.env`、`.env.*`
- `credentials*`、`*secret*`
- `*.pem`、`*.p12`、`*.key`
- token、Cookie、JWT、私钥、真实账号数据

可使用基础扫描作为辅助，但不能把正则扫描当成唯一保证：

```bash
git diff --cached | grep -nEi \
  '(api[_-]?key|client[_-]?secret|access[_-]?token|private[_-]?key|password)[[:space:]]*[=:]'
```

命中后人工判断是占位符还是真实凭证。发现真实敏感信息必须移除；如果它曾进入 Git 历史，还要按泄露流程轮换凭证并清理历史。

### 9. 运行验证

验证顺序从便宜到昂贵：

1. 与改动最相关的定向测试。
2. lint / typecheck。
3. 受影响 package 或模块测试。
4. 仓库要求的全量测试或构建。
5. 用户可见行为的真实运行态验证。

不要在没有代码变化时反复运行同一套昂贵全量测试。失败时区分：

- 本次改动引入的问题。
- 默认分支也存在的基线问题。
- 环境缺失或外部服务不可用。

没有跑过的验证必须明确写“未验证”，不能暗示已经通过。

### 10. Commit 纪律

- 一个逻辑单元一个 commit。
- 使用仓库要求的 message 风格；无约定时可使用 Conventional Commits。
- 不使用 `wip`、`tmp`、`fix fix`、`address comment` 等无意义 message。
- commit 只包含当前任务文件；提交前再次查看 staged diff。
- 不擅自改写已推送历史。rebase、force-push 或 squash 已共享分支前先获得授权。

建议命令：

```bash
git diff --cached
git status --short
git commit -m "fix(scope): describe the behavior change"
```

### 11. 发布 PR

只有在得到授权后才 push 或创建 PR。发布前确认：

- diff 聚焦且规模合理。
- 测试结果真实记录。
- 没有敏感信息。
- PR 标题和描述符合模板。
- 描述包含目标、非目标、行为变化、测试证据和未验证项。

创建后立即拉回检查 PR 的实际展示、base/head、commit 和 checks 是否正确。Draft 用于实现未完成或需要早期方向反馈；完整实现并通过既定验证后才标 Ready。

### 12. Review Follow-Up

处理 review 时采用批量收敛流程：

1. 一次性读取所有 inline thread、顶层 review、CI 和 mergeability。
2. 按正确性、安全、产品决策、误读/过时分类。
3. 回读 PR 的原始目标，避免 bot 建议悄悄改变产品意图。
4. 把同一轮技术问题批量修完并自审。
5. 跑定向验证，再做一次合并 push。
6. 对每条 thread 留下可见回复后再 resolve。
7. 重新检查 unresolved、checks 和 review decision。

不要“发现一条 → 改一条 → push 一次”。频繁 push 会触发重复全量 review，制造无限循环。低价值风格建议或误读用证据回复，不为每个 nit 单独改代码。

同一个底层逻辑连续多轮出现不同 finding，说明可能是设计缺口；停止局部打补丁，重新写清状态和不变量后一次性修正。

### 13. 收口

PR 合并或任务结束后：

- fetch 并核对远端终态。
- 确认 worktree 干净，未提交内容属于谁。
- 只有确认分支内容已安全进入目标分支后，才删除 worktree/本地分支。
- 不删除含未知 dirty 状态的 worktree。
- 汇报：改了什么、commit/PR、验证结果、未验证项和剩余风险。

## Pitfalls

- 把“实现”自动扩大成 push、PR 或 merge。
- 为避开脏工作区而 stash、reset 或覆盖用户文件。
- 没读仓库规则就套用通用命令。
- 用测试绿替代 UI/运行态验证。
- 把 bot 意见当成产品需求，导致范围漂移。
- 一条 finding 一次 push，陷入无限复审。
- 只检查当前文件，不检查 Git 历史里的 secret。
- 长时间自治却不留下 checkpoint，导致上下文丢失后无法接续。

## Verification

交付前应能明确回答：

- 当前分支/worktree 是否隔离且干净？
- diff 是否只包含目标范围？
- staged 内容是否经过人工查看和敏感信息检查？
- 哪些测试实际运行并通过？
- 哪些面未验证，为什么？
- commit、push、PR、公开评论和 merge 是否都在授权范围内？
- review threads、checks、冲突和后续风险是否如实汇报？
