# 全局约定

## 路径约定

- `~` 表示当前运行环境的用户主目录，不是项目目录；读取文件前先解析该路径，不硬编码用户名或盘符。
- 自定义规则与技能的 Git 仓库位于 `~/ai-rule/`；全局规则正文只维护在 `~/ai-rule/AGENTS.md`。
- 工具不支持 `~` 展开时，先获取当前用户主目录再拼接后续路径；PowerShell 中使用 `$HOME`。

## 技能库

- 自定义技能位于 `~/ai-rule/skills/`，第三方安装技能位于 `~/.agents/skills/`；两个目录都必须检查，每个直接子目录中的 `SKILL.md` 为技能正文。
- 执行任务前，检查上述两个目录中各技能的 frontmatter `description`，按任务匹配相关技能；不得只检查自定义技能而忽略第三方技能。没有匹配项时按常规方式处理。
- 命中技能后，完整读取其 `SKILL.md` 并遵循其中规则；技能所需的脚本、数据和补充文档按正文指定路径加载。
- 自定义技能直接从 `~/ai-rule/skills/` 读取，不在 `~/.agents/skills/`、`~/.codex/skills/` 或其他工具技能目录中创建指向自定义技能的目录联接、符号链接或副本。同名但来源不同的技能须核对用途，存在歧义时先确认，不静默覆盖。
- 新建或更新个人技能时，直接维护 `~/ai-rule/skills/<技能名>/`，不再嵌套额外的目录层级，不创建库级 `SKILL.md` 或占位模板；不得未经确认覆盖已有同名技能。
- 第三方技能及 `~/.agents/.skill-lock.json` 保留在安装目录，不复制进自定义 Git 仓库，不擅自修改安装记录。
- 技能说明使用中文，保留必要的命令和标识符；不重复 CLI 自带帮助，具体参数通过对应命令的 `--help` 查询。简单技能只保留 `SKILL.md`，不额外创建 README。

## 终端

- Windows 环境；终端命令默认使用 pwsh（PowerShell 7）执行，遵循 PowerShell 语法与习惯。
- 路径使用正斜杠或双反斜杠；环境变量设置用 `$env:NAME = "value"`。
- 脚本被执行策略拦截时，用 `Set-ExecutionPolicy -Scope Process Bypass` 临时放行。
- pwsh 不支持 Bash heredoc；多行补丁使用 UTF-8 here-string，并直接调用 `apply_patch` 底层命令，避免管道和重定向造成编码或换行错误。
- WSL 输出中文乱码不等于命令失败；以进程退出码和实际结果为准。

## Python

- 一律使用 `uv` 管理虚拟环境和依赖：`uv venv`（`-p 3.12` 指定版本）、`uv add <pkg>`、`uv add -d <pkg>`（开发依赖）、`uv remove`、`uv sync`、`uv lock --upgrade`。
- 不要直接使用系统 pip，也不要手动激活 venv 后用裸 pip 装包。
- 运行一律通过 `uv run <cmd>`（自动处理 PATH，无需 activate），如 `uv run python main.py`、`uv run pytest`。
- `uv pip install` 仅用于不写入 `pyproject.toml` 的临时安装；`uv.lock` 必须提交到仓库。
- WSL 中运行 Python 测试不得使用裸 `python3 -m pytest`；在仓库根目录用 `uv` 创建 `.venv-wsl`，并通过 `.venv-wsl/bin/python -m pytest` 执行。

## Git

- 未经明确要求，不执行 `git commit`。
- 重构前先用 `git log --oneline` 和 `git blame` 了解文件历史。

## 文档与产物

- skill/文档/注释必须自包含：规则直接陈述为事实，禁止出现"参考XX""与XX一致""按XX同样规则"等出处式引用。
- 对话中的"参考XX""像XX一样"是工作指令，决定怎么做，不进入产物内容。
- 写完自查：脱离本次对话，未来读者能否仅凭这份文件理解每条规则？
