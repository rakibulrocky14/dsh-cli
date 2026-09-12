# ⚡ dsh-cli (dsh-terminal)

> **终端里的原生 DeepSeek Harness** — 基于 `dsh-base` 构建、具备 Web GUI 完整对齐能力的 Cordis 终端界面。智能体预设、插件、工具、会话、审批与设置，全部搬进命令行。不增不减，原生纯粹。

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](https://nodejs.org)
[![Community Plugin](https://img.shields.io/badge/DeepSeek%20Harness-社区插件%20(非官方)-0066FF.svg)](https://github.com/rakibulrocky14/dsh-cli)

**[English](README.md) | [简体中文](README_CN.md)**

> [!IMPORTANT]
> **免责声明**：本项目为一个独立的开源社区驱动插件，**与 DeepSeek AI 或官方团队无任何隶属、赞助或官方背书关系**。"DeepSeek" 及 "DeepSeek Harness" 均为其对应持有者的注册商标。

---

![dsh-terminal 初始界面](docs/assets/dsh-terminal-preview.png)

![dsh-terminal 智能体预设](docs/assets/dsh-presets-preview.png)

---

## ✨ 核心特性

- 🎨 **DeepSeek 经典蓝与现代 TUI**：圆角输入框设计、专属 ASCII 鲸鱼欢迎横幅、底部自适应状态栏，自动适配终端缩放。
- 🎛️ **全量 Agent 预设对齐**：输入 `/presets` 即可无缝切换 **标准模式 (Standard)**、**PTC 模式 (Code Mode)**、**极简模式 (Minimal)** 与 **创作者模式 (Creator)**。
- ⚡ **Web GUI 级别体验**：实时流式打字输出、深度思考 (Reasoning Effort) 进度条、工具调用卡片折叠、多会话管理与交互式审批弹窗。
- 🔌 **原生 Cordis 插件无缝支持**：DSH 环境中安装的任意 Cordis 插件均可在终端界面中直接调用，无需二次开发。
- 🖱️ **完整的终端手感交互**：原生鼠标滚轮平滑滚动、PageUp/PageDown 翻页、Tab 补全斜杠命令、以及快速中断/退出快捷键。
- 🧩 **启动即选的三种模式**：
  - **全屏 TUI (Full-screen TUI)**：交互式终端默认启动。
  - **行式 REPL (Line REPL)**：适用于管道重定向、CI/CD 或使用 `--line` 强制启动。
  - **单次运行 (One-shot CLI)**：通过 `--print "<任务>"` 快速执行单任务并在标准输出打印结果后退出。

---

## 📦 安装与配置

### 环境要求

- Node.js `^22.19 || >=24`
- 已在系统中安装 [DeepSeek Harness (`dsh`) CLI](https://github.com/deepseek-ai)

### 方法一：通过 DSH CLI 直接安装（推荐）

无需克隆代码，直接将插件添加到专属的 terminal 配置文件中：

```bash
dsh plugin --profile terminal add github:rakibulrocky14/dsh-cli
```

### 方法二：本地源码克隆与构建安装

```bash
# 1. 克隆代码仓库
git clone https://github.com/rakibulrocky14/dsh-cli.git
cd dsh-cli

# 2. 安装依赖并编译 TypeScript
npm install
npm run build

# 3. 添加到 DSH terminal 配置文件
dsh plugin --profile terminal add .
```

---

## 🚀 启动与使用

### 启动全屏 TUI

```bash
dsh --profile terminal
```

### 命令行常用参数

```bash
# 指定使用的模型启动
dsh --profile terminal --model deepseek-reasoner

# 恢复指定的历史会话
dsh --profile terminal --resume session-c302f9d0

# 强制以标准行式 REPL 启动（非全屏 TUI）
dsh --profile terminal --line

# 单次命令模式（执行后直接打印回复并退出，非常适合脚本调用）
dsh --profile terminal --print "请帮我写一个快速排序算法"
```

### 为此 Profile 叠加更多插件

```bash
dsh plugin --profile terminal add <npm-pkg | github:owner/repo | ./path | ./pkg.tgz>
```

---

## 🎛️ Agent 预设支持

随时输入 `/presets` 打开可视化切换面板，或直接输入 `/presets <id>` 快速切换：

| 预设模式 | 标识 (ID) | 详细功能说明 |
|---|---|---|
| **标准模式 (Standard mode)** | `standard` | 具备文件编辑、Shell 终端、文件/网络搜索、技能库、多步规划和子智能体等全部功能的完备开发助手。 |
| **PTC 模式 (PTC mode)** | `code` | 具备标准模式的全部能力，并通过 Code Mode SDK 将所有工具暴露给模型，模型可在一个 TypeScript 程序中组合调用多步操作。 |
| **极简模式 (Minimal mode)** | `minimal` | 轻量高效的双工具智能体，仅包含持久化 Bash 和 `str_replace_editor` 字符串替换工具。 |
| **创作者模式 (Creator mode)** | `cordis` | 专为创建与调试自定义 Agent 预设设计，拥有标准模式能力及 Cordis 运行时检查与插件实验指南。 |

---

## ⌨️ 快捷键指南

| 按键 | 对应动作 |
|---|---|
| `Enter` | 发送消息 / 确认当前菜单选择 |
| `Esc` | 关闭当前弹窗 / 返回聊天主界面 |
| `Tab` | 自动补全斜杠命令 (`/`) |
| `↑` / `↓` | 浏览命令历史或上下导航菜单 |
| `PageUp` / `PageDown` | 向上/向下滚动聊天记录 |
| `鼠标滚轮` | 丝滑滚动查看上下文与长代码输出 |
| `Ctrl + O` | 展开 / 折叠所有工具调用输出卡片 |
| `Ctrl + C` | 终止当前模型回复（空闲时清空输入框） |
| `Ctrl + D` | 退出并结束当前会话 |

---

## 🛠️ 常用斜杠命令

在输入框输入 `/` 后按 `Tab` 键即可探索所有内置与插件命令：

- **会话管理**：`/sessions` (历史会话浏览器), `/resume <id>`, `/new`, `/fork`
- **配置切换**：`/presets` (智能体预设), `/model` (模型切换器), `/effort` (思考深度调节), `/settings`, `/permissions`
- **状态检查**：`/tools` (当前可用工具列表), `/commands` (所有命令速查), `/skills`, `/agents`, `/plugins`, `/jobs`, `/usage`, `/doctor`
- **工作区操作**：`/terminals`, `/todos`, `/title`, `/clear`, `/stop`, `/quit`

---

## 🏗️ 项目架构

```
dsh --profile terminal
  └── dsh-terminal (Cordis 插件包)
        ├── cordis.patch.yml      注入 base 行、code-runtime、cordis-host 与启动服务
        ├── dsh-terminal/startup  命令行参数解析 → terminalStartup
        └── dsh-terminal          runner 驱动层 → TUI | REPL | --print
              ├── core/dsh.ts         Cordis 服务门面与运行时特性嗅探
              ├── core/transcript.ts  持久化日志映射与实时流式 Chunk 聚合
              ├── core/messages.ts    不可变消息对象工厂
              ├── core/lineinput.ts   单读取器 TTY/Pipe 输入流
              ├── repl.ts             行式 REPL 界面实现
              ├── print.ts            单次 CLI 任务执行实现
              └── tui/                状态引擎与 Ink React 渲染组件树
```

---

## 🧪 开发与测试

```bash
# 类型检查
npm run typecheck

# 编译 TypeScript 至 lib/
npm run build

# 运行自动化单元测试 (包含 61 项回归测试)
npm test
```

---

## 🤝 参与贡献

非常欢迎任何形式的代码贡献、Issue 反馈与 Pull Request！

- 请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解本地开发配置及 PR 规范。
- 如果你有任何功能建议或遇到了显示异常，欢迎直接提交 Issue 或开 PR 讨论！

---

## 🏷️ 标签与关键词

`#deepseek` `#deepseek-harness` `#dsh` `#dsh-cli` `#dsh-terminal` `#terminal` `#tui` `#cli` `#ai-agent` `#llm` `#cordis` `#coding-assistant`

---

## ⚠️ 免责声明

`dsh-cli` 是一个由开源社区开发者为 DeepSeek Harness 生态独立打造的非官方项目。**本项目与 DeepSeek AI、杭州深度求索人工智能基础技术研究有限公司无任何隶属、维护、赞助或官方背书关系。**

所有产品名称、标识、品牌与商标均属于其各自所有者。

---

## 📄 开源许可协议

[Apache-2.0](LICENSE) © [rakibulrocky14](https://github.com/rakibulrocky14)
