# Cindy Git Workflow Skill

一个面向 Cindy 及其他编码 Agent 的公开 Git 工作流 skill，重点解决：

- 写代码前先读取仓库规则并确认范围
- 默认使用隔离 worktree，不污染用户主工作区
- 区分 edit / commit / push / PR / merge 的授权边界
- 提交前做安全扫描、测试和六维自审
- 批量处理 review feedback，避免一条意见一次 push
- 如实报告验证结果、未验证项和剩余风险

本仓库是从个人工作流中提炼出的**公开通用版本**，不包含个人数据、公司私有仓库规则、内部服务、session/schedule 配置或凭证。

## 让 Cindy 学习

将仓库 URL 交给支持 `learn` 的 Cindy：

```text
/learn https://github.com/zqchris/cindy-git-workflow-skill
```

也可以先 clone，再从本地路径学习：

```bash
gh repo clone zqchris/cindy-git-workflow-skill
```

```text
从 ./cindy-git-workflow-skill 学习这个 Git 工作流，结合我的仓库规则生成本地版本。
```

`learn` 应当参考并个性化，而不是盲目覆盖目标仓库已有的 `AGENTS.md`、`CLAUDE.md` 或贡献规范。

## 直接安装

```bash
git clone https://github.com/zqchris/cindy-git-workflow-skill.git \
  ~/.agents/skills/cindy-git-workflow
```

如果运行时从其它目录加载 skills，可以再建立软链：

```bash
ln -sfn ~/.agents/skills/cindy-git-workflow \
  ~/.claude/skills/cindy-git-workflow
```

## 文件

```text
SKILL.md                  工作流正文(入门精简版)
scripts/preflight.sh      写前只读检查
scripts/git-start.sh      从远端默认分支创建隔离 worktree
scripts/align-branch.sh   对比本地与远端 PR 分支，不自动 merge/rebase
automation/               完整 PR 自动化方案(v4.7):三道闸、PR 总管、
                          preRunHook 预检、意图契约、多机纪律——
                          面向 Cindy 的配置指南见 automation/README.md
```

## 设计原则

1. 仓库规则优先于通用 skill。
2. 只读请求不自动升级为写代码。
3. 修改、提交、推送、开 PR、合并是不同授权层级。
4. 不 stash/reset/clean 用户的未知工作。
5. 一个 PR 只解决一个清晰问题。
6. 证据优先：测试、运行态和实际 PR 状态比模型判断可靠。
7. Review 合批处理，避免无限 bot 复审循环。

## License

MIT
