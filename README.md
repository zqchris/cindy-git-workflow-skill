# Cindy Git Workflow

给实习生和编码 Agent 使用的工程工作流：从一个清楚的用户目标开始，在独立工作区实现，用真实运行证据送审，再有依据地处理 review。

公开通用版 **2.0.0**，适用于 Cindy、Codex、Claude Code 等支持 `SKILL.md` 的工具。不依赖发布者的个人配置、内部服务或会话数据库。

## 这版解决什么

- **实际验收**：功能变化先跑核心场景；数据库用旧版非空数据升级，迁移验证真正执行、结果回流和恢复。
- **停止持续有效**：用户叫停测试版/虚拟机/模拟器后，CI、review 或任务恢复不能重新启动。
- **任务独立负责**：不自行跨 session 派活、交换进度、共享资源协调或叠 PR。
- **继续有依据的工作**：一个平台等登录不冻结独立修复；不因每轮评论重开整套环境。
- **Review 保留原功能**：采纳真实缺陷，有据拒绝低收益建议，不按行数或轮数机械停工。

## 安装或学习

向 Cindy 提供：

```text
/learn https://github.com/zqchris/cindy-git-workflow-skill
```

也可将仓库克隆到运行时支持的 skill 目录。例如目录尚不存在时：

```bash
git clone https://github.com/zqchris/cindy-git-workflow-skill.git \
  ~/.agents/skills/cindy-git-workflow
```

安装到其他位置时，调整脚本路径，并按运行时自己的方式暴露此 skill。更新已有副本前先检查本地修改，不能覆盖自定义规则。安装后确认运行时发现的版本；必要时新开或重启 Agent 会话，但不因此重启承载任务的助手应用。

**从旧 automation 包升级的使用者先读 [迁移说明](automation/README.md)。** 当前包已撤下 PR 总管和多会话编排安装模板；仅更新文件不会停止以前装好的后台任务。不要同时加载旧 `git-workflow` 和本包。

## 实习生怎么用

把具体目标和交付范围告诉 Agent，例如：

```text
使用 cindy-git-workflow 修复保存后刷新丢失设置的问题。
在本任务独立 worktree 实现，保留原功能；用隔离数据验证保存、刷新和重新启动。
完成自审和相关验证后提交正式 PR。不要联系其他 session，也不要启动额外设备。
```

Agent 应自行核对仓库与权限，完成已授权工作；只在真正缺产品决定、信息或权限时询问。导师重点看用户结果、实测证据与缺项，不能用 CI 绿灯或提交速度代替验收。

首次使用可走一遍 [情景练习](references/scenarios.md)。这些例子用于理解判断方式，不代表在你的项目里已经测过。

## 内容与工具

| 文件 | 用途 |
| --- | --- |
| [SKILL.md](SKILL.md) | 唯一主流程：授权、工作区、实现、验收、review 与交付 |
| [真实运行验收](references/runtime-acceptance.md) | 按改动选场景，处理环境、证据复用和交付阶段 |
| [评审处置](references/review.md) | 采纳/拒绝依据，批量修复与防止循环 |
| [情景练习](references/scenarios.md) | 实习生常见判断题及对应动作 |
| [自动跟进与迁移](automation/README.md) | 可选 watcher 边界与旧版退出；不是安装器 |
| `scripts/git-start.sh` | 从指定远端当前默认分支创建独立 worktree |
| `scripts/preflight.sh` | 只读检查主工作区、分支和已有修改 |
| `scripts/align-branch.sh` | fetch 后比较本地/远端分支，不自动合并或改写 |

脚本需要 Bash 和 Git；运行时可按授权使用 GitHub CLI，但本包 Git 脚本不依赖 Cindy 内部工具。脚本不会清理用户文件、启动产品、创建 PR 或安装后台任务。PASS 只表示对应检查通过，不表示授权、功能验收或安全审查完成。

维护者验证脚本（Python 3，仅本地临时 Git 仓库）：

```bash
python3 -m unittest discover -s tests -v
```

## 公开内容边界

只收录可复用的工作方式。个人凭证、公司内部地址、真实会话/设备标识、运行状态和个人授权不进入公开包；安全事项见 [SECURITY.md](SECURITY.md)。文档规则不等于程序级拦截，也不保证已经安装到每位使用者设备。

## License

MIT
