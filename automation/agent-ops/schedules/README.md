# 定时任务正本存档（全套可迁移）

本目录 = 本机全部 schedule 的 **prompt 正本 + 配置快照**，与 `../schedule-checks/`（前置检查脚本备份）合起来构成完整迁移包：**同步本仓库到任何机器，就拿到了重建全套自动化所需的一切**。

| 文件 | 任务 | 类型 |
|---|---|---|
| `signoff-gate-makecindy-cindy.md` | 签字门巡检 | 每日 3 轮,产品门决策报告 |
| `plugins-pr-review.md` | 插件仓 PR 巡检 | 每 3 小时 |
| `pi-issue-autofix.md` | PI Issue 自动修复 | 每小时,路由建 session |
| `model-catalog-audit.md` | 模型目录官方校准 | 每日 2 次 |
| `openclaw-auto-upgrade.md` | OpenClaw 自动升级 | 每日,已配零 token 版本比对闸(2026-08-05) |
| `base-refs-refresh.md` | 本地基底保活 | script 模式,零 token |
| （PR 总管） | **正本在 `git-workflow/references/pr-coordinator-prompt.md`**，与 git-workflow skill 配套,不在此重复 | 每 30 分钟 |

## 三份一致纪律

每条任务的 prompt 有三个存在：**scheduler 活体**、**本目录存档**、**与之配对的 skill 条款**。改任何一份，同轮对齐另两份。只改存档不 apply 到 scheduler = 存档是假的；只改活体不回写 = 下次迁移把旧病带过去。

导出方式（改完活体后重跑一次即可全量刷新）：本目录文件由本机 Cindy DB 的 `schedules` 表直接导出（见 git log 中的导出脚本），不手抄——手抄万字级 prompt 必然转录漂移。

## 迁移 runbook（新机器 / 公司机）

1. 同步本仓库（README 根目录「同步协议」）。
2. 逐个打开本目录文件，按「配置」表重建 schedule，prompt 逐字贴入。**机器专属项要改**：working_dir、preRunHook 里的绝对路径、targetSessionId（持久会话在新机重建后换新 id）。
3. preRunHook 按 `../schedule-checks/README.md`：脚本内容从备份取，但**必须经 `schedule_set_pre_run_hook` 安装**（它自测并保证协议），不要手拷了事。
4. **逐条 resume、逐条观察**：每恢复一条，等它真实跑一轮，确认静默/通知行为符合预期再放下一条。不整批开闸（2026-08-04 熔断的恢复纪律）。
5. 状态文件（`~/.cindy/schedule-state/`、`git-workflow/sweeps/*_*.json`）是**机器本地的，不迁移**——新机从空状态自然重建。

