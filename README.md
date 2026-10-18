<p align="center">
  <img src="public/actspan-logo.svg" width="128" height="128" alt="Actspan Logo">
</p>

<h1 align="center">Actspan</h1>

<p align="center">
  <strong>你的 AI 浏览器助手 — 用自然语言完成搜索、页面操作与信息整理。</strong>
</p>

<p align="center">
  中文 | <a href="./README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/youxing-max/ActSpan/blob/master/LICENSE">
    <img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License">
  </a>
</p>

---

提问之后，Actspan 会在浏览器后台调用工具、搜索网页、解析数据、跨站点采集信息，并把结果呈现给你，不打扰你正在做的事。

## 特性

- **AI 原生对话** — 悬浮球随时唤起，自然语言交互，流式响应
- **原位执行** — 在你的真实浏览器中工作，复用已有登录态。无需迁移 Cookie，无需重新登录，已登录的站点直接操作
- **36+ 内置工具** — 页面操作、CDP 深度控制（10 域）、请求拦截、DOM/CSS/存储操作、导航、截图、网络诊断、人机确认…
- **工作流录制** — 演示一次即可录制浏览器操作，AI 自动清洗去噪，生成可复用的标准工作流
- **站点工作流** — 声明式 JSON 定义，无需写代码即可自动化网站操作
- **LLM 自由选择** — 兼容任何 OpenAI API 格式的服务，数据完全自主可控
- **MCP 协议** — 标准化工具注册与调用，支持动态扩展
- **Agentic Loop** — Codex 风格自驱循环，代码管边界，模型管决策
- **开源免费** — AGPL-3.0 协议，社区驱动

## 快速开始

```bash
git clone https://github.com/youxing-max/ActSpan.git
cd ActSpan
npm install
npm run build
```

构建完成后，在 Chrome 中加载 `build_version/actspan-extension/` 下的扩展目录即可使用。详见[快速开始文档](docs/guide/getting-started.md)。

## 工作原理

```
你提问 → AI 进入后台 Agentic Loop
       → Channel 通信 + MCP 工具调用 + 多轮推理
       → 结果呈现在悬浮球中
```

Actspan 运行在 Chrome 扩展的三层架构中：

| 层 | 角色 |
|---|------|
| Content Script | 悬浮球 UI + 页面交互 |
| Background | AI 编排 + 工具调度 |
| Channel | 跨层消息通信 |

## 文档

阅读 [Actspan 文档](docs/index.md)了解详细使用和开发指南。

## 开发

```bash
npm run dev          # 开发模式（监听构建）
npm run build        # 构建所有组件
npm run lint         # 代码检查
npm run docs:dev     # 文档站本地预览
```

## 致谢

本项目在 [linux.do](https://linux.do) 社区发起，感谢社区成员的反馈与支持。

## 许可证

[AGPL-3.0](LICENSE)
