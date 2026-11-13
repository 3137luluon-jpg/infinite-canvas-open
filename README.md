# Ai视觉无限画布

这是我基于开源 Infinite Canvas 深度定制的本地 AI 视觉创作台。界面参考 LibTV 的视觉风格，画布操作保留 ComfyUI 那种拖节点、拉连线、随时查看上下游的手感。可以把参考图、提示词、镜头和生成结果放在同一张画布上，从整理素材一路做到交剪辑。

## 画布可以做什么

- **在画布上编排生产流程**。用连线管理提示词、图片、视频和音频之间的引用关系，保留候选结果，并配合素材库与分镜看板组织项目。
- **把选好的镜头送进剪映草稿箱**。在画布里选择视频、调整剪辑顺序，再导出为剪映草稿。适用于安装了剪映专业版的 Windows。
- **让智能体操作画布**。通过本机 Canvas Agent 和 MCP，Codex 等客户端可以读取画布、创建节点、整理素材、连线和触发已配置的生成流程。
- **自由搭配生成渠道**。为图片、视频、音频和文本分别配置模型及接口，继续用自己的渠道与 API Key。

## 片场流 · 影视短片创作工作台

片场流是我配合画布使用的个人创作工作台，已实现类似小云雀的一站式短片创作体验。内嵌智能体可以根据创意推进剧本、分镜和素材清单。确认后，把角色、场景、道具和镜头直接同步到画布执行生成，再回收候选结果。复刻工作室也是个人工具。这两个入口保留在公开画布里，点开会显示说明。

## 从源码启动

安装 Node.js 24 和 Git，在终端执行：

```sh
git clone https://github.com/3137luluon-jpg/infinite-canvas-open.git
cd infinite-canvas-open
npm --prefix web ci --legacy-peer-deps
npm --prefix web run dev
```

浏览器打开 [http://localhost:3000](http://localhost:3000)。画布编辑可直接使用，生成内容时在配置页填写自己的渠道地址、模型和 API Key。浏览器存档与站点地址绑定，日常请使用同一个地址。

## 连接本机智能体

另开一个终端，在仓库根目录启动 Canvas Agent：

```sh
npm --prefix canvas-agent ci
npm --prefix canvas-agent run build
node canvas-agent/dist/index.js
```

在已安装并登录 Codex CLI 的机器上注册 MCP。把路径换成你本机克隆后的绝对路径：

```sh
codex mcp add ai-visual-canvas -- node "/absolute/path/to/infinite-canvas-open/canvas-agent/dist/index.js" mcp
```

打开一个画布项目，让本机 Agent 建立连接，再在 Codex 中指定该项目和要执行的操作。生成任务使用你在画布里配置的渠道。

版本和更新说明见 [GitHub Releases](https://github.com/3137luluon-jpg/infinite-canvas-open/releases)。

本项目基于 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas)，按 [MIT 许可证](LICENSE) 分发。
