# 自定义 AI 规则与技能

本仓库仅维护自定义全局规则与技能，固定使用用户主目录下的 `~/ai-rule` 作为检出位置。`~` 表示当前用户主目录，不包含特定用户名或盘符。

## 目录结构

- `AGENTS.md`：全局约束的唯一维护源。
- `AGENTS-TEMP.md`：Codex 和 Claude Code 共用的入口模板。
- `sync.cmd`：Windows 双击同步入口。
- `sync.ps1`：模板同步、差异跳过、覆盖前备份与失败回滚。
- `skills/gitlab-cli/SKILL.md`：GitLab CLI 使用约定。
- `skills/wsl-docker/SKILL.md`：需要 Docker 时使用 WSL 内 Docker 的执行环境约定。
- `README.md`：目录、接入和维护说明。

## 接入与技能发现

- `~/.codex/AGENTS.md`、`~/.claude/CLAUDE.md` 和项目规则入口要求先完整读取 `~/ai-rule/AGENTS.md`。
- `~/.agents/AGENTS.md` 仅保留兼容入口，不保存全局约束正文副本。
- 自定义技能正文存放在 `~/ai-rule/skills/<技能名>/SKILL.md`，外部安装技能存放在 `~/.agents/skills/<技能名>/SKILL.md`。
- 自定义技能直接从仓库读取，不在工具技能目录中创建目录联接、符号链接或副本。
- 任务开始时检查两个来源的技能描述，命中后读取对应目录中的正文。
- 第三方技能目录和 `~/.agents/.skill-lock.json` 不纳入本仓库，不手动覆盖安装器维护的数据。

## 换机器

将仓库克隆到新用户的 `~/ai-rule`，运行 Windows 同步入口，并将第三方技能安装在 `~/.agents/skills/`。通过全局规则直接检查两个来源，不需要建立技能目录联接。

## Windows 一键同步

前提是 Windows 已安装 PowerShell 7，且 `pwsh.exe` 位于 PATH 中。仓库必须放在当前用户主目录的 `ai-rule` 文件夹下，不能直接保留默认克隆目录名 `ai-rules`。

双击仓库中的 `sync.cmd`，或在 PowerShell 中执行：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File "$HOME/ai-rule/sync.ps1"
```

脚本将同一份 `AGENTS-TEMP.md` 分别同步到 `~/.codex/AGENTS.md` 和 `~/.claude/CLAUDE.md`。缺少目标目录时自动创建，内容完全相同时跳过。模板或目标类型检查失败时不修改入口；覆盖前将所有需要替换的旧文件备份到 `.sync-backups/<时间与唯一标识>/`，备份失败不覆盖，写入失败尝试回滚本次已改动的入口。

备份文件分别为 `codex-AGENTS.md` 和 `claude-CLAUDE.md`，需要恢复时复制回对应目标。备份目录已被 Git 忽略。同步只替换两个入口，不合并旧入口中的附加内容，不修改技能、其他设置、项目入口或 `~/.agents/AGENTS.md`，不自动执行 Git 操作。

入口文件或其直接父目录为目录联接、符号链接时，脚本拒绝覆盖。脚本支持 `-UserHome` 指定隔离用户目录进行验证，默认使用当前用户主目录。

## Git 维护

在仓库内检查 `git status` 和差异，只提交全局规则、入口模板、同步脚本、自定义技能及必要说明。新建自定义技能直接维护 `skills/<技能名>/SKILL.md`，不要把第三方安装目录复制进仓库。

仓库初始化不等于已建立提交历史。提交、设置远程地址和推送均由用户明确安排；凭据、令牌、日志、迁移备份和本机私有配置不得放入仓库。
