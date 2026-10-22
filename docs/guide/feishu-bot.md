# 飞书 / Lark 机器人（双向）

ActSpan 提供一个独立的飞书连接器：在飞书里私聊机器人，或在群里 @机器人，就能让本机的 Chrome 扩展执行浏览器任务，并把结果回复到同一个会话。

```text
飞书私聊 / 群内 @机器人
  → 飞书 WebSocket 长连接（im.message.receive_v1）
  → actspan-feishu 连接器
  → 本机 MCP Server
  → Chrome 扩展执行浏览器任务
  → 飞书回复消息
```

连接器是单独的文件 `mcp-server/feishu-bot.js`，**不复用钉钉连接器或 Telegram 连接器的传输层**。三个连接器各自独立，方便单独修改和替换。

## 1. 创建飞书自建应用

1. 打开[飞书开放平台](https://open.feishu.cn/app)，进入开发者后台。
2. 创建**企业自建应用**，记下 `App ID` 和 `App Secret`。
3. 在 **应用能力 → 机器人** 中开启机器人能力。
4. 在 **权限管理** 中至少开通：
   - 接收用户发给机器人的单聊消息：`im:message.p2p_msg`（或只读权限）；
   - 接收群聊中 @机器人 的消息：`im:message.group_at_msg`（或只读权限）；
   - 以应用身份发消息：`im:message:send_as_bot`。
5. 在 **事件与回调 → 事件订阅** 中添加 **接收消息 v2.0**（`im.message.receive_v1`）。
6. 订阅方式选择 **使用长连接接收事件**。
7. 发布应用，并把机器人添加到目标群；私聊则需要把使用者加入应用的可用范围。

> 国际版 Lark 的开放平台是 `open.larksuite.com`，配置时设置 `FEISHU_DOMAIN=lark`。

## 2. 配置凭据

推荐使用环境变量：

```bash
export FEISHU_APP_ID="cli_xxxxxxxxxxxxxxxx"
export FEISHU_APP_SECRET="你的 App Secret"
```

也可以写入 `~/.actspan/feishu.json`：

```json
{
  "appId": "cli_xxxxxxxxxxxxxxxx",
  "appSecret": "你的 App Secret"
}
```

国际版可以加：

```json
{
  "domain": "lark"
}
```

凭据只保存在本机。不要把 App Secret 提交到仓库、发到聊天里，或写进截图。

## 3. 启动连接器

先确保：

- Chrome 中已安装并启用 ActSpan 扩展；
- 扩展已配置好可用的 LLM；
- 本机 MCP 服务可以正常运行。

然后运行：

```bash
cd mcp-server
npm install
npm run feishu
```

如果通过 npm 全局安装，也可以直接运行：

```bash
actspan-feishu
```

连接成功后会看到：

```text
[actspan-feishu] 已连接飞书长连接；等待私聊或群内 @机器人 消息
```

## 4. 使用

私聊直接输入任务：

```text
打开 GitHub 搜索 ActSpan，把第一条结果的标题和链接发给我
```

群聊 @机器人，或使用 `/ask`：

```text
@ActSpan 打开 example.com 并告诉我页面标题
/ask 汇总今天科技新闻的前三条
```

也支持：

- `/start`、`/help`、`帮助`：查看用法；
- 在群里回复机器人消息：继续下任务。

机器人会先回复「收到」，任务完成后把结果发回同一个会话。同一会话中的任务按顺序执行，避免多个浏览器任务互相抢占标签页。

## 可选配置

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `ACTSPAN_FEISHU_TIMEOUT_MS` | 单个任务最长等待时间 | `900000`（15 分钟） |
| `FEISHU_ALLOWED_OPEN_IDS` | 可选，逗号分隔的发送者 `open_id` 白名单；设置后仅这些用户可以下任务 | 不限制 |
| `FEISHU_DOMAIN` | `feishu`（飞书）或 `lark`（Lark 国际版） | `feishu` |
| `FEISHU_DEBUG` | 设为 `1` 输出飞书 SDK 日志 | 关闭 |

运行参数：

```bash
node feishu-bot.js --config ~/.actspan/feishu.json --debug
```

## 安全建议

- 机器人会使用你浏览器里的真实登录态执行操作，只把机器人加入可信的群。
- 强烈建议设置 `FEISHU_ALLOWED_OPEN_IDS`，只允许指定的用户下任务。
- 需要人工确认的高风险操作仍会在浏览器里等待你确认，不会因来自飞书而跳过。
- 不要把 App Secret 写进代码、截图或公开文档。
- 如果机器人不再使用，停止连接器，并在飞书开放平台停用应用或轮换 App Secret。

## 排查

**启动报缺少凭据**

确认 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 已设置，或 `~/.actspan/feishu.json` 存在且字段正确。

**启动报 App ID 格式不正确**

飞书自建应用的 App ID 形如 `cli_` 加 16 位十六进制字符。请从开放平台复制完整 App ID。

**连接成功但收不到消息**

1. 确认应用已发布，且机器人能力已开启。
2. 确认事件订阅中有 `接收消息 v2.0`（`im.message.receive_v1`）。
3. 确认订阅方式是 **使用长连接接收事件**。
4. 确认已申请单聊或群聊 @机器人 的消息接收权限。
5. 确认机器人已加入目标群；私聊用户已在应用可用范围内。
6. 用 `--debug` 重启连接器查看飞书 SDK 日志。

**群里 @机器人 没有反应**

1. 确认消息里真的 @ 了当前机器人，而不是其他成员。
2. 确认应用有 `im:message.group_at_msg` 或对应只读权限。
3. 如果应用同时申请了“接收群聊所有消息”的敏感权限，连接器会按 mention 判断，避免响应普通聊天；请确认 mentions 中包含当前机器人。

**回复失败**

确认应用有 `im:message:send_as_bot` 权限，机器人仍在目标群内且没有发言限制。飞书对同一群组的机器人发消息有共享 5 QPS 限制，连接器会按分片顺序发送。

**机器人重复回复**

飞书在 3 秒内没有收到事件处理结果时可能重推。连接器会立即返回 ACK，并按 `message_id` 在 5 分钟内去重；如果仍出现重复，检查本机是否同时运行了多个 `actspan-feishu` 进程。

## 独立适配器说明

`feishu-bot.js` 不导入 `dingtalk-stream.js` 或 `telegram-bot.js`。飞书的长连接、消息解析和回复都封装在本文件内；任务执行部分（`ActspanSession`、`runTask`、`extractTaskText`、`splitReply`）保持独立，便于单独维护。

需要新增其他 IM 时，可以复制这个文件，替换以下三处：

1. **收消息**：替换 `Lark.WSClient` 和 `EventDispatcher`；
2. **解析消息**：替换 `stripFeishuMentions`、`normalizeFeishuQuery`、`isBotMentioned`；
3. **回消息**：替换 `FeishuReplier`。

不要把钉钉和飞书的传输层合并成一个适配器，否则任一平台的权限、消息格式或重连策略变化都会互相影响。
