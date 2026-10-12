# ai-whiteboard

An AI-editable whiteboard built on Excalidraw, with MCP tools, editable math, and a reusable diagramming skill.

一个在本机运行的 AI 讲解白板。你可以手动画图和输入文字，也可以让支持 MCP 的聊天助手读取、生成和局部修改可编辑图形。

## 功能

- 蓝色简约界面、轻手写文字、矩形与箭头、自由绘制。
- 新建、搜索、复制、重命名、归档与恢复多个白板。
- 自动保存版本快照、导入和导出可编辑稿、PNG 备份。
- LaTeX 公式本地渲染为 SVG，保留源码，可再次编辑。
- 全屏阅读、鼠标滚轮缩放、主流程与详解导航。
- 六个 MCP 工具：状态、读取、候选预览、局部修改、布局检查、实际渲染。
- `whiteboard-teaching` Skill：先规划逻辑和图形表达，再绘制核心机制与就近详解。

## 本地运行

需要 Node.js 22.12 或更高版本及 npm。以下为 Windows PowerShell 示例；不需要全局安装依赖。

```powershell
git clone https://github.com/yanjunlin828-dotcom/ai-whiteboard.git
Set-Location -LiteralPath 'ai-whiteboard'
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd --prefix formula-runtime ci --ignore-scripts --no-audit --no-fund
npm.cmd run build
$env:WHITEBOARD_DATA_DIR = Join-Path $PWD '.local/boards/main/revisions'
npm.cmd start
```

保持终端开启，在浏览器访问 <http://127.0.0.1:48765>。服务仅绑定本机地址。结束使用前确认页面显示“已保存”，再用 Ctrl+C 停止自己启动的服务。

开发模式可用 `npm.cmd run dev`，与普通启动使用同一端口，不应同时运行。

### 数据和配置

上面的 `WHITEBOARD_DATA_DIR` 将白板保存在仓库内被忽略的 `.local/boards` 中。这个变量指定 **main 白板的 revisions 目录**；其他白板的独立目录由服务在同一个白板库中管理。

未设置该变量时，程序沿用原有工作区默认路径：仓库父目录下的 `文档/自建学习材料/AI讲解白板/白板/main/revisions`。已有用户保持原路径即可，无须迁移旧白板。

| 环境变量 | 用途 |
| --- | --- |
| `WHITEBOARD_PORT` | 服务端口，默认 `48765`；MCP 客户端需使用同一值 |
| `WHITEBOARD_DATA_DIR` | main 白板的版本目录，由白板服务读取 |
| `WHITEBOARD_BRIDGE_FILE` | 本机 MCP 连接密钥文件路径；服务和 MCP 需使用同一路径 |

服务启动时会在 `.local/bridge-<端口>.key` 创建本机连接密钥。白板数据、密钥、依赖和构建产物不纳入 Git。重要白板请额外导出 `.excalidraw` 备份。

## 接入 MCP

先启动白板服务，再在支持本地 STDIO MCP 的 AI 客户端中添加：

| 参数 | 值 |
| --- | --- |
| 服务器名称 | `ai_whiteboard`（与 Skill 中的依赖名称一致） |
| 命令 | 本机 `node` 的绝对路径 |
| 参数 | 克隆目录下 `mcp/server.mjs` 的绝对路径 |
| 工作目录 | 克隆目录的绝对路径 |
| 环境变量 | 按需要设置 `WHITEBOARD_PORT`、`WHITEBOARD_BRIDGE_FILE` |

注册格式由具体客户端决定。MCP 入口是 STDIO 进程，不是白板网页 URL，也不需要把本机连接密钥写进聊天。

连接后应看到六个工具：

| 工具 | 作用 |
| --- | --- |
| `board_status` | 确认目标标题、活动编辑页和可操作状态 |
| `board_read` | 同步并读取身份、版本、分区和图元 |
| `board_preview` | 检查候选修改和 PNG，不保存候选 |
| `board_patch` | 新增或局部修改图形、文字、公式及连接 |
| `board_validate` | 检查溢出、遮挡、端口和布局问题 |
| `board_render` | 渲染已保存版本的实际 PNG |

打开并保持目标白板编辑页活跃，结束文字输入或拖动后再让 AI 操作。读写携带本次读取的 `boardId`、`editorSessionId` 和版本；超时先用原请求 ID 查回执，不重复提交。详细参数与流程见 [工具参考](skills/whiteboard-teaching/references/tools.md)。

`npm.cmd run check:mcp` 可检查 SDK 到 MCP 的连接与工具列表，不能代替 AI 客户端中的实际工具发现和调用验收。

## 使用 Skill

最新版在 [skills/whiteboard-teaching/SKILL.md](skills/whiteboard-teaching/SKILL.md)，同目录包含完整参考文件与客户端元数据。将整个 `whiteboard-teaching` 文件夹安装到客户端支持的 Skill 目录；已有同名版本时先保留备份，再按客户端方式更新。

示例请求：

> 使用 whiteboard-teaching，在我打开的目标白板上讲解这个主题。先说明共同逻辑、模块层级和核心关系，再选择各部分的图形表达。核心清楚集中，独立附图就近展开并用浅色无箭头虚线说明归属，关键跨区域传递保留实线。不要把规划编号写到成品中；先预览再保存。

Skill 按实际关系选择方向、嵌套与分支，不固定方形或纵向排版。附图尺度按可读性调整；短旁注可不连线。它提供作者工作方法，不是自动布局引擎。

## 项目结构

```text
src/             React 编辑界面、白板库、导航和字体
server/          本机服务、持久化、会话、备份和公式渲染
shared/          图元编辑、分区、路由和几何检查
mcp/             STDIO MCP 服务
formula-runtime/ 独立锁定的 MathJax 与 Fira Math 依赖
skills/          可复用的讲解图 Skill
tests/           合成数据的自动测试
qa/              浏览器验收入口
scripts/         构建、MCP 检查和历史阶段验收脚本
```

## 验证与限制

```powershell
npm.cmd test
npm.cmd run build
```

自动测试使用合成数据；历史阶段脚本可能在仓库父目录的 `中间过程/AI讲解白板` 中新增验收产物，运行前查看脚本所用端口和目录。`check:mcp` 需要本机白板服务运行。

这是本地使用的项目初版，不提供公网部署或多人实时协作。AI 编辑有版本和会话校验；部分锁定、旋转、原生框架或复杂绑定对象不支持局部修改。几何检查不能验证知识、公式推导或审美，交付仍需查看实际预览。

依赖版本由两个 `package-lock.json` 固定。字体适配针对 Excalidraw `0.18.1`，升级前需要检查适配器。

## 第三方资源

绘图基于 Excalidraw；公式使用 MathJax 和 Fira Math；字体资源包含 Noto 字体及现有 Euler Math 文件。随仓库保留的字体许可见 [src/fonts](src/fonts/)，依赖各自的许可在安装包中。本次没有新增项目整体的 `LICENSE`。
