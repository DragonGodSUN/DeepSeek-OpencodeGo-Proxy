# DeepSeek OpencodeGo Proxy

通用代理，解决任何客户端通过 DeepSeek API 调用时 `reasoning_content` 必须回传的问题。

## 问题

DeepSeek V4 推理模式要求每次请求中，历史 assistant 消息必须携带 `reasoning_content` 字段（原文）。某些客户端（如 Claude Code、ChatGPT Next Web、Open WebUI 等）在返回响应时保留了该字段，但下一轮请求时未正确注入，导致 DeepSeek 返回 400 错误。

## 原理

```
客户端 → DeepSeek Proxy (:3456) → DeepSeek API / OpenAI 兼容 API
              │
              ├─ 请求路径：为缺失 reasoning_content 的 assistant 消息注入之前捕获的原文
              └─ 响应路径：从响应（流式/非流式）中捕获 reasoning_content 存入 session
```

每次请求自动完成：**注入 → 转发 → 捕获 → 下一轮再注入**。

## 特性

- **通用兼容**：兼容任何 OpenAI Chat Completions API 格式的客户端
- **多 session 隔离**：通过 `x-session-id` 头隔离不同会话
- **流式 + 非流式双支持**：自动识别 content-type 并提取 reasoning_content
- **零外部依赖**：仅使用 Node.js 内置模块（http, https, zlib, stream）
- **可配置 upstream**：通过环境变量指向任意 OpenAI 兼容 API 端点
- **模型映射 + tool_choice 剥离**：自动处理不同模型名的兼容性问题
- **Path 自动规范化**：客户端路径缺 `/v1/` 前缀时自动补齐

## 使用

```bash
# 启动代理（默认转发到 opencode.ai/zen/go）
node proxy.js

# 或双击 start.bat
```

默认监听 `localhost:3456`。

### 配置

**方式一：`config.json`（推荐）**

```json
{
  "target_base_url": "https://api.deepseek.com/v1",
  "proxy_port": 3456,
  "upstream_timeout": 120000,
  "model_map": {
    "deepseek-v4-flash": "deepseek-v4-pro",
    "gpt-4": "deepseek-v4-pro"
  }
}
```

**方式二：环境变量**（优先级高于 config.json）

| 变量 | config.json 对应字段 | 说明 |
|------|---------------------|------|
| `TARGET_BASE_URL` | `target_base_url` | 上游 API 地址 |
| `PROXY_PORT` | `proxy_port` | 代理监听端口 |
| `UPSTREAM_TIMEOUT` | `upstream_timeout` | 上游超时（毫秒） |
| `MODEL_MAP` | `model_map` | 模型名映射，JSON 字符串 |

环境变量会覆盖 config.json 中的对应项。

### Session 隔离

无需客户端配合。代理自动从请求头派生 session key，优先级依次为：

1. `x-session-id` — 显式指定
2. `x-claude-code-session-id` — Claude Code 自带
3. `Authorization` token 末 12 位 — 不同 API key 自动隔离
4. `__default__` — 兜底

多客户端并发时各自的 `reasoning_content` 互不污染。30 分钟无活动自动清理。

### 客户端配置

**Claude Code (via CC-switch)**

```json
{
  "ANTHROPIC_BASE_URL": "http://localhost:3456",
  "ANTHROPIC_MODEL": "deepseek-v4-pro"
}
```

**BitFun / ChatGPT Next Web / 其他**

将 API Base URL 设为 `http://localhost:3456`，模型名按上游 API 要求填写。路径缺 `/v1/` 前缀时自动补齐，无需调整客户端设置。

## 文件

| 文件 | 说明 |
|------|------|
| `proxy.js` | 代理服务主程序 |
| `config.json` | 配置文件（API 地址、端口、模型映射等） |
| `package.json` | 项目元信息 |
| `start.bat` | Windows 启动脚本 |

## 注意

- 首次使用必须启动**新会话**，让代理从第一轮开始捕获 reasoning_content
- 同一客户端内多个并行子 agent 共享 session（例如 Claude Code 开两个子 agent 同时做任务），无法区分
- 这是临时工具，等待 opencode 官方修复 API 接口后即失去作用（虽然官方到现在还没修，害得我不得不更新了）
