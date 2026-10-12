# 自定义 AI 规则与技能

本仓库仅维护自定义全局规则与技能，固定使用用户主目录下的 `~/ai-rule` 作为检出位置。`~` 表示当前用户主目录，不包含特定用户名或盘符。

约束与说明分四层：`RULES.md` 承载所有会话的全局行为约束（经符号链接同步到各工具）；`AGENTS.md` 与 `CLAUDE.md` 只承载本仓库的项目约束（在仓库内工作时由工具作为项目指令加载，`CLAUDE.md` 经导入读取 `AGENTS.md`）；`tools/<项目>/AGENTS.md` 承载对应子项目的开发约束；本 README 只描述仓库结构与机制，不承载行为约束。

## 目录结构

- `RULES.md`：全局行为约束的唯一维护源，经符号链接同步到各工具。
- `AGENTS.md` / `CLAUDE.md`：本仓库的项目约束；`CLAUDE.md` 经导入读取 `AGENTS.md`，兼容只识别 CLAUDE.md 的工具。
- `sync.cmd`：Windows 双击同步入口。
- `sync.ps1`：入口符号链接与技能目录联接维护、覆盖前备份与失败恢复。
- `skills/database-query-cli/SKILL.md`：数据库命令行查询工具的使用约定，只读查询、表结构检查与业务数据统计。
- `skills/gitlab-cli/SKILL.md`：GitLab CLI 使用约定。
- `skills/wsl-docker/SKILL.md`：需要 Docker 时使用 WSL 内 Docker 的执行环境约定。
- `tools/`：工具项目（当前为 `database-query-cli`），各自以子目录中的 `AGENTS.md` 承载开发约束。
- `README.md`：目录、接入和维护说明。

未列出的任务设计文档与 `.sync-backups/` 备份仅保留在本地，不纳入版本控制；提交与推送由用户明确安排，仓库初始化不等于已建立提交历史。

## 接入与技能发现

- `~/.codex/AGENTS.md` 和 `~/.claude/CLAUDE.md` 是指向 `~/ai-rule/RULES.md` 的符号链接，由同步脚本维护；两个工具原生读取完整规则正文，入口不含内容副本。
- 创建符号链接需要管理员权限或已开启 Windows 开发者模式；同步脚本在当前会话无权限时自动弹出管理员授权（UAC）重跑，已开启开发者模式时静默直过。
- 用 `/context` 或 `/memory` 可验证全局规则是否已加载。
- `~/.agents/AGENTS.md` 仅保留兼容入口，不保存全局约束正文副本。
- 自定义技能正文唯一存放在 `~/ai-rule/skills/<技能名>/SKILL.md`，由同步脚本以目录联接接入 `~/.claude/skills/` 和 `~/.codex/skills/`；外部安装技能存放在 `~/.agents/skills/<技能名>/SKILL.md`。
- 任务开始时按第三方技能的 frontmatter 描述检查命中（支持原生技能发现的工具会自动列出自定义技能），命中后读取对应目录中的正文。
- 第三方技能目录和 `~/.agents/.skill-lock.json` 不纳入本仓库，不手动覆盖安装器维护的数据。

## 换机器

将仓库克隆到新用户的 `~/ai-rule`，运行同步入口（无权限时自动请求管理员授权，建立入口符号链接与 `~/.claude/skills/`、`~/.codex/skills/` 技能目录联接），再将第三方技能安装在 `~/.agents/skills/`。

## Windows 一键同步

前提是 Windows 已安装 PowerShell 7，且 `pwsh.exe` 位于 PATH 中。仓库必须放在当前用户主目录的 `ai-rule` 文件夹下，不能直接保留默认克隆目录名 `ai-rules`。

双击仓库中的 `sync.cmd`，或在 PowerShell 中执行：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File "$HOME/ai-rule/sync.ps1"
```

脚本将 `~/.codex/AGENTS.md` 和 `~/.claude/CLAUDE.md` 维护为指向 `~/ai-rule/RULES.md` 的符号链接，并为 `~/ai-rule/skills/` 下每个包含 `SKILL.md` 的技能在 `~/.claude/skills/` 和 `~/.codex/skills/` 中维护目录联接。映射已正确时跳过；入口为真实文件或映射指向其他位置时，备份后替换为正确映射；符号链接创建失败时恢复原文件。仅当入口映射待更新且当前会话无权限创建符号链接时，脚本自动弹出管理员授权（UAC）并重跑；已开启开发者模式或入口无需改动时静默直过。联接指向其他位置时自动重建；目标为真实目录或文件时跳过并警告；工具技能目录本身为联接时拒绝维护。

被替换的旧入口文件备份到 `.sync-backups/<时间与唯一标识>/`，备份文件名分别为 `codex-AGENTS.md` 和 `claude-CLAUDE.md`，需要恢复时复制回对应目标；备份失败不覆盖。备份目录已被 Git 忽略。同步不合并旧入口中的附加内容，不修改其他设置、项目入口或 `~/.agents/AGENTS.md`，不自动执行 Git 操作。

入口的父目录为目录联接或符号链接，或入口本身是目录时，脚本拒绝处理。脚本支持 `-UserHome` 指定隔离用户目录进行验证，默认使用当前用户主目录。
