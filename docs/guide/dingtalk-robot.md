# 钉钉群机器人（双向）

ActSpan 支持两种钉钉接入方式：

| 方式 | 能力 | 是否需要公网 |
|---|---|---|
| 自定义机器人 Webhook | 任务完成后单向推送通知 | 否 |
| 企业内部应用机器人 + Stream | 群里 @机器人 执行任务并回复结果 | 否 |

本文说明第二种方式。单向推送在扩展的 **Options → Webhook** 中配置即可。

## 工作方式

```text
钉钉群 @ActSpan
  → 钉钉 Stream 长连接
  → actspan-dingtalk 连接器
  → 本机 MCP Server
  → Chrome 扩展执行浏览器任务
  → 结果回复到钉钉群
```

连接器运行在本机，不需要公网 IP 或回调地址。

## 1. 创建钉钉企业内部应用

1. 打开[钉钉开发者后台](https://open-dev.dingtalk.com/)。
2. 创建**企业内部应用**，记下 `ClientID`（AppKey）和 `ClientSecret`（AppSecret）。
3. 在应用能力中添加**机器人**。
4. 机器人消息接收方式选择 **Stream 模式**。
5. 发布应用，并把机器人添加到目标群。

## 2. 配置凭据

推荐使用环境变量：

```bash
export DINGTALK_CLIENT_ID="你的 ClientID"
export DINGTALK_CLIENT_SECRET="你的 ClientSecret"
```

也可以写入 `~/.actspan/dingtalk.json`：

```json
{
  "clientId": "你的 ClientID",
  "clientSecret": "你的 ClientSecret"
}
```

配置文件只保存在本机。不要把 AppSecret 提交到仓库或发到聊天里。

## 3. 启动连接器

先确保：

- Chrome 中已安装并启用 ActSpan 扩展；
- 扩展已配置好可用的 LLM；
- 本机 MCP 服务可以正常运行。

然后运行：

```bash
cd mcp-server
npm install
npm run dingtalk
```

如果通过 npm 全局安装，也可以直接运行：

```bash
actspan-dingtalk
```

启动成功后会看到：

```text
[actspan-dingtalk] 已连接钉钉 Stream；等待群内 @机器人 消息
```

## 4. 使用

在群里 @机器人 并输入任务：

```text
@ActSpan 打开 GitHub 搜索 ActSpan，把第一条结果的标题和链接发给我
```

机器人会先回复「收到」，任务完成后把最终结果回复到同一个群。同一个会话中的任务会按顺序执行，避免多个浏览器任务互相抢占标签页。

## 可选配置

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `ACTSPAN_DINGTALK_TIMEOUT_MS` | 单个任务最长等待时间 | `900000`（15 分钟） |
| `DINGTALK_ALLOWED_USER_IDS` | 可选，逗号分隔的 `senderStaffId` 白名单；设置后仅这些成员可以下任务 | 不限制 |
| `DINGTALK_DEBUG` | 输出 SDK 调试日志 | 关闭 |

运行参数：

```bash
node dingtalk-stream.js --config ~/.actspan/dingtalk.json --debug
```

## 安全建议

- 机器人会使用你浏览器里的真实登录态执行操作，只把机器人加入可信的群。
- 建议设置 `DINGTALK_ALLOWED_USER_IDS`，只允许指定的群成员下任务。
- 需要人工确认的高风险操作仍会在浏览器里等待你确认，不会因来自钉钉而跳过。
- 不要把 AppSecret 写进代码、截图或公开文档。
- 如果机器人不再使用，停止连接器并在钉钉后台停用应用。

## 排查

**@机器人没有反应**

1. 确认应用已发布，机器人能力选择了 **Stream 模式**。
2. 确认机器人已加入当前群。
3. 确认 `actspan-dingtalk` 进程仍在运行。
4. 确认 Chrome 扩展在线，且 MCP 服务正常。
5. 用 `--debug` 重启连接器查看钉钉连接日志。

**回复「处理失败」**

连接器会把 MCP 返回的错误原样回复，例如浏览器未连接、LLM 未配置或任务超时。根据提示修复后重新 @机器人 即可。
