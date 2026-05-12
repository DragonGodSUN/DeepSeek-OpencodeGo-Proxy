# Changelog — reasoning_content Proxy v2 → v3

## 版本

| 版本 | 日期 | 说明 |
|------|------|------|
| v1 | 2026-04-26 | 初始版本 |
| v2 | 2026-04-28 | 初版改 |
| **v3** | **2026-05-12** | **本次更新：通用化改造** |

## 概览

将代理从 **CC-switch 专用** 改造为 **任意 OpenAI 兼容客户端通用**。

## 新增

### 1. Session 隔离

- **全局单变量** `lastReasoningContent` → **`Map<sessionId, SessionData>`** 带 TTL 管理
- 无 `x-session-id` 时自动从以下来源派生 session key：
  1. `x-claude-code-session-id`（Claude Code 自带）
  2. `Authorization` token 末 12 位（BitFun 等客户端自动隔离）
  3. `__default__` 兜底
- 30 分钟无活动自动清理过期 session
- 响应头自动回传 `x-session-id`

### 2. upstream 可配置

- `TARGET_BASE_URL` 环境变量：full URL 配置 upstream（含协议+主机+路径）
- `PROXY_PORT` 环境变量：代理监听端口
- `UPSTREAM_TIMEOUT` 环境变量：上游超时毫秒数
- 默认值保持兼容：`https://opencode.ai/zen/go` / `3456` / `120000`

### 3. Path 自动规范化

- 客户端发 `/chat/completions` → 自动补 `/v1/` 前缀 → `/v1/chat/completions`
- 客户端发 `/v1/chat/completions` → 不变
- 解决部分客户端省略 OpenAI `/v1/` 前缀导致的 404

### 4. 非流式响应支持

- 流式（SSE）响应：通过 `Transform` stream 拦截 SSE 行，捕获 `choices[0].delta.reasoning_content`
- 非流式（JSON）响应：收集完整 body，解析 `choices[0].message.reasoning_content`
- 均写入对应 session store

### 5. 压缩支持

- 保留 `accept-encoding` 头发送
- 自动解压 upstream 的 gzip/deflate 响应（Node.js `zlib`）

### 6. 模型名映射

- `MODEL_MAP` 环境变量：JSON 格式的模型名映射表
- 示例：`MODEL_MAP='{"deepseek-v4-flash":"deepseek-v4-pro"}'`
- 映射后记录日志

### 7. `tool_choice` 自动剥离

- 检测到请求体中有 `tool_choice` 字段时自动删除
- 原因：DeepSeek reasoner 系列模型不支持此参数

### 8. 调试日志增强

- 每个请求打印 session ID 前缀（`[__defaul]` / `[c1b8f65e]`）
- 打印转发头列表（`HDR <name>: <value>`），便于对比不同客户端请求差异

### 9. `package.json`

- 新增项目元信息：`"type": "module"`、Node >= 18

## 变更

### `proxy.js`

| 区域 | v2 | v3 |
|------|----|----|
| 配置 | 硬编码 3 个常量 | 4 个环境变量 + 默认值 |
| Session | 全局单变量 `lastReasoningContent` | `Map<sid, { lastReasoningContent, createdAt, lastAccessAt }>` |
| Session key | 不存在 | 三级自动派生 |
| Path | 固定 `/zen/go` + 客户端路径 | `TARGET_BASE_URL` 解析 + `/v1/` 自动补充 |
| 转发表头 | 剥离 `accept-encoding` | 保留 `accept-encoding` |
| 响应处理 | 仅 SSE stream pipe | SSE + 非流式 JSON 双模式 + gzip 解压 |
| 请求体 | 仅 `patchMessages` | `patchMessages` + 模型映射 + `tool_choice` 剥离 |
| 日志 | 基础 | Session ID + 请求头详情 |
| 依赖 | `http`, `https`, `stream` | `http`, `https`, `stream`, `zlib` |

### `README.md`

- 重写：通用客户端适配说明、环境变量表格、Session 隔离机制、多客户端配置示例

### `package.json`

- 新建

### `start.bat`

- 不变

## 不变

- 零外部依赖，纯 Node.js 内置模块
- CORS 全开策略
- `patchMessages` 核心注入逻辑（仅取值从全局变量改为 session 变量）
- Windows `start.bat` 启动脚本

## 测试记录

| 客户端 | 测试项 | 结果 |
|--------|--------|------|
| Claude Code (CC-switch) | `/v1/chat/completions` + `deepseek-v4-pro` | 200，reasoning_content 捕获和注入正常 |
| Claude Code (CC-switch) | 连续多轮对话 | reasoning 跨轮保留，无 400 错误 |
| BitFun | `/chat/completions` + `deepseek-v4-flash` | 200，自动补 `/v1/` + 剥离 `tool_choice` |
| BitFun | 多模型切换 (v4-flash / v4-pro) | 透传正常 |
| 双客户端并发 | Claude Code + BitFun 同时请求 | Session 隔离（token 末12位区分），无互相污染 |

## 已知局限

- 同一客户端内多会话仍共享 session（例如 Claude Code 开两个子 agent 并行），除非上游支持 `x-session-id` 回传
- 这是个临时工具，等待 opencode 官方修复 API 接口后失去作用，因此不计划进一步维护（虽然官方到现在还没解决这个问题害的我不得不更新了）
