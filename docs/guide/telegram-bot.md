# Telegram 机器人（双向）

ActSpan 提供一个独立的 Telegram 连接器：在 Telegram 里私聊机器人，或在群里 @机器人，就能让本机的 Chrome 扩展执行浏览器任务，并把结果回复到同一个会话。

```text
Telegram 私聊 / 群内 @机器人
  → Telegram getUpdates 长轮询
  → actspan-telegram 连接器
  → 本机 MCP Server
  → Chrome 扩展执行浏览器任务
  → Telegram sendMessage 回复结果
```

连接器是一个单独的文件 `mcp-server/telegram-bot.js`，**不复用钉钉连接器的传输层**。需要接入其他 IM 时，可以整份复制这个文件，只替换收消息和回消息两处。

## 1. 创建 Telegram 机器人

1. 在 Telegram 中搜索并打开 [@BotFather](https://t.me/BotFather)。
2. 发送 `/newbot`，按提示设置机器人名称和用户名。
3. 记下 BotFather 返回的 Token，格式类似 `123456789:AA...`。

如果要在群里使用，把机器人拉进群即可。Telegram 默认的隐私模式会向机器人投递 **@提及、回复和命令**，已经够用。

如果发现群里 @机器人 没有反应，可以：

1. 在 BotFather 中发送 `/setprivacy`，选择该机器人，设置为 **Disable**；
2. 把机器人移出群后重新拉进群，让隐私设置生效。

## 2. 配置 Token

推荐使用环境变量：

```bash
export TELEGRAM_BOT_TOKEN="你的 Bot Token"
```

也可以写入 `~/.actspan/telegram.json`：

```json
{
  "botToken": "你的 Bot Token"
}
```

Token 只保存在本机。不要把它提交到仓库、发到聊天里，或写进截图。

> 中国大陆网络通常无法直接访问 `api.telegram.org`。如果启动时报网络错误，可以把 `TELEGRAM_API_BASE` 指向一个可访问的 Telegram Bot API 兼容代理，例如 `https://your-proxy.example.com`。代理会看到 Token，请只使用你信任的代理。

## 3. 启动连接器

先确保：

- Chrome 中已安装并启用 ActSpan 扩展；
- 扩展已配置好可用的 LLM；
- 本机 MCP 服务可以正常运行。

然后运行：

```bash
cd mcp-server
npm install
npm run telegram
```

如果通过 npm 全局安装，也可以直接运行：

```bash
actspan-telegram
```

启动成功后会看到：

```text
[actspan-telegram] 已连接 Telegram @你的机器人；等待私聊或群内 @机器人 消息
```

## 4. 使用

私聊直接输入任务：

```text
打开 GitHub 搜索 ActSpan，把第一条结果的标题和链接发给我
```

群聊 @机器人，或使用 `/ask`：

```text
@ActSpan 打开 example.com 并告诉我页面标题
/ask@ActSpan 汇总今天科技新闻的前三条
```

也支持：

- `/start`、`/help`：查看用法；
- 回复机器人的消息：继续下任务。

机器人会先回复「收到」，任务完成后把结果发回同一个会话。同一会话中的任务按顺序执行，避免多个浏览器任务互相抢占标签页。

## 可选配置

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `ACTSPAN_TELEGRAM_TIMEOUT_MS` | 单个任务最长等待时间 | `900000`（15 分钟） |
| `TELEGRAM_ALLOWED_USER_IDS` | 可选，逗号分隔的 Telegram 用户 ID 白名单；设置后仅这些用户可以下任务 | 不限制 |
| `TELEGRAM_API_BASE` | 可选，Telegram Bot API 地址或兼容代理 | `https://api.telegram.org` |

运行参数：

```bash
node telegram-bot.js --config ~/.actspan/telegram.json
```

## 安全建议

- 机器人会使用你浏览器里的真实登录态执行操作，只把机器人加入可信的群。
- 强烈建议设置 `TELEGRAM_ALLOWED_USER_IDS`，只允许指定的用户下任务。
- 需要人工确认的高风险操作仍会在浏览器里等待你确认，不会因来自 Telegram 而跳过。
- 不要把 Bot Token 写进代码、截图或公开文档。
- 如果机器人不再使用，停止连接器，并在 BotFather 中撤销 Token。

## 排查

**启动报 `Telegram 连接失败`**

1. 确认 Token 完整且没有多余空格。
2. 确认本机能访问 `TELEGRAM_API_BASE`；中国大陆网络通常需要代理。
3. 如果返回 `401 Unauthorized`，说明 Token 无效，请在 BotFather 中重新获取。

**提示已配置 Webhook，长轮询无法接收消息**

同一个机器人不能同时使用 Webhook 和 `getUpdates`。先在 BotFather 或 Bot API 中删除 Webhook，再启动连接器。

**群里 @机器人 没有反应**

1. 确认机器人已经在群里。
2. 确认消息里真的有 `@机器人用户名`，或使用了 `/ask@机器人用户名`。
3. 如果机器人开启了隐私模式，默认只接收 @、回复和命令；需要接收所有群消息时，在 BotFather 中用 `/setprivacy` 关闭隐私模式，然后重新拉机器人进群。
4. 确认 `actspan-telegram` 进程仍在运行，且日志里没有持续报错。

**回复「处理失败」**

连接器会把 MCP 返回的错误原样回复，例如浏览器未连接、LLM 未配置或任务超时。根据提示修复后重新发送任务即可。

**启动时报 Bridge 白名单不兼容**

连接器会尝试从 `~/.actspan/bridge-<port>.json` 读取已运行 Bridge 的扩展白名单。如果仍然失败，先确认 Chrome 扩展和 IDE 侧的 MCP 服务在线，或显式设置 `ACTSPAN_EXTENSION_IDS`。

## 复制成其他 IM 适配器

`telegram-bot.js` 保持独立，不依赖 `dingtalk-stream.js`。复制后主要改三处：

1. **收消息**：把 `getUpdates` 长轮询换成目标 IM 的 WebSocket、长连接或 Webhook。
2. **解析消息**：替换 `normalizeTelegramQuery`、`isBotAddressed`、`isHelpCommand`，保留 `ActspanSession` 的任务提交和轮询逻辑。
3. **回消息**：替换 `TelegramApi.sendMessage`，保留 `splitReply` 的长度限制和同一会话串行队列。

任务执行部分（`ActspanSession`、`runTask`、`extractTaskText`）与 IM 无关，可以原样复用。
