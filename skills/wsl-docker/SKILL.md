---
name: wsl-docker
description: 当任务需要使用 Docker 或 Docker Compose，包括在脚本、构建或测试中调用 Docker 时使用；在 Windows 环境下统一使用 WSL 内直接安装的 Docker，不使用 Windows Docker 或 Docker Desktop。
---

# 使用 WSL 中的 Docker

需要使用 Docker 时，将命令放在安装了 Docker Engine 的 WSL 发行版内执行。本技能只规定执行环境，不重复 Docker 基础操作或通用排障知识。

- Windows 侧通过 `wsl.exe --distribution $distribution --exec docker ...` 调用；Compose 同样在该发行版内执行。已处于目标 WSL 环境时直接使用其中的 Docker，无需再次调用 `wsl.exe`。
- 发行版未明确时，先用 `wsl.exe --list --verbose` 识别；存在多个候选且无法确定时再询问。不要硬编码发行版名称。
- 依赖项目目录的命令先定位 WSL 内的项目路径，再通过 `--cd` 设置工作目录。Windows 路径用目标发行版中的 `wslpath` 转换，不假设固定挂载根；路径和参数分别传递并正确引用。
- 脚本、构建和测试若会间接调用 Docker，也应在目标 WSL 环境运行，不能只把手动 Docker 命令切到 WSL。
- 如环境变量或 context 指向其他 Docker 服务，先确认目标，不能把“CLI 在 WSL 中”当作“连接 WSL 本地 Engine”。用户明确指定其他环境时遵循该请求。
- WSL 中的 Docker 不可用时报告具体原因，不自动回退到 Windows Docker、安装 Docker Desktop 或改动全局 Docker 配置。
