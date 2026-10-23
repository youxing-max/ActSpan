# actspan-mcp

Actspan 浏览器扩展的本地 MCP Server：把你 Chrome 里的真实浏览器能力（页面读写、点击输入、截图、网络请求读取、数据抓取、工作流、定时任务）以 **35 个标准 MCP 工具**暴露给任意 MCP 客户端（Claude Code、Codex、各类 IDE Agent）。

> 需要配合 Actspan Chrome 扩展使用。扩展与完整文档见主仓库：
> https://github.com/youxing-max/ActSpan

## 特性

- **真实浏览器**：直接操作你已登录的 Chrome 页面，无需迁移 Cookie
- **35 个工具**：标签页管理、语义快照、页面读写、批量动作脚本（act）、网络请求取数、数据抓取/下载、技能与工作流、异步 Agent 任务、定时任务
- **安全边界**：Tab 租约隔离、SSRF 守卫、Captcha 检测、`page.eval` 副作用防护、审计日志
- **双向机器人**：内置钉钉 Stream 机器人与飞书/Lark 长连接机器人命令
- **本地运行**：桥接守护进程跑在 `127.0.0.1:30121`，配置与凭证不出本机

## 安装与使用

要求 Node.js ≥ 20。

```bash
# 交互式安装：写入 MCP 客户端配置（Claude Code / Codex 等）
npx actspan-mcp install

# 或者全局安装后使用命令
npm i -g actspan-mcp
actspan-install        # 配置客户端
actspan-doctor         # 诊断桥接连接
actspan-mcp            # 手动启动 MCP Server（一般由客户端自动拉起）
actspan-dingtalk       # 启动钉钉 Stream 双向机器人
actspan-feishu         # 启动飞书 / Lark 长连接机器人
```

安装前请确保：

1. Chrome 中已加载 Actspan 扩展（见主仓库 Releases 或源码构建）
2. 扩展 Options 页已配置模型 Endpoint / API Key

## 工具分组速览

| 分组 | 工具数 | 代表工具 |
|---|---|---|
| 状态与通知 | 3 | `actspan_status`、`actspan_status_update`、`actspan_feishu_push` |
| 标签页 | 5 | `actspan_tab_open`、`actspan_tab_navigate`、`actspan_tabs_list` |
| 页面原子操作 | 5 | `actspan_page_read`、`actspan_page_click`、`actspan_screenshot` |
| act 批量动作 | 8 | `actspan_act`（声明式动作脚本）、`actspan_page_snapshot` |
| 网络请求 | 3 | `actspan_network_list/detail/query` |
| 数据抓取 | 3 | `actspan_data_fetch/paginate/download` |
| 技能与工作流 | 3 | `actspan_skills_list`、`actspan_workflow_run` |
| 异步 Agent | 4 | `actspan_agent_submit/status/result/cancel` |
| 定时任务 | 1 | `actspan_timer`（延时/周期/每日每周，原标签页关闭仍执行） |

完整工具语义、参数与防劫持约定见主仓库的 [MCP-BRIDGE.md](https://github.com/youxing-max/ActSpan/blob/main/MCP-BRIDGE.md)。

## 安全须知（Free Mode）

自 v1.1.0 起移除了全部人工审批门：**任何已认证 MCP 客户端可对任意标签页执行任意动作（含表单提交、支付点击），无确认弹窗**。请仅在受信环境运行；敏感操作仍会写入审计日志供事后追溯。详见主仓库 `docs/spec/actspan-free-mode-spec.md`。

## License

[AGPL-3.0](https://github.com/youxing-max/ActSpan/blob/main/LICENSE)
