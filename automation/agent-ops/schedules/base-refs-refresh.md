# 本地基底保活 · git refs — schedule 正本存档

> 活体在本机 scheduler(id `0072e54e-ebca-434b-b772-9f90952dfcbe`)。改活体必同步本文件;只改本文件不 apply = 存档是假的。
> 迁移新机:按下表重建 schedule,prompt 原样贴入;preRunHook 经 schedule_set_pre_run_hook 安装(脚本备份见 ../schedule-checks/)。

## 配置

| 项 | 值 |
|---|---|
| cron_expr | `23 */2 * * *` |
| timezone | `Asia/Shanghai` |
| agent_kind | `claude-code` |
| working_dir | `~/Code/Github/cindy` |
| use_worktree | `0` |
| persistent_session | `0` |
| execution_mode | `script` |
| silent_when_idle | `0` |
| status | `active` |
| scriptConfig | `{"command":"node ~/.agents/skills/git-workflow/scripts/refresh-base-refs.mjs","capabilities":[],"timeoutMs":540000}` |

## Prompt 全文(逐字)

````text
(script 模式,无 prompt)
````
