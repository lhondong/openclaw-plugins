# openclaw-langfuse-trace 插件说明

## 1. 插件是什么

`openclaw-langfuse-trace` 是一个 OpenClaw 可观测性插件，用来把 OpenClaw 运行过程中的关键链路转换为 OpenTelemetry Trace，再通过 Langfuse 提供的 OTLP Trace 接口上报到 Langfuse。

它关注的是链路追踪，而不是指标或日志。插件会把一次用户请求、一次 Agent 执行、一次 LLM 调用、一次 Tool 调用、一次 Subagent 生命周期等事件串成一条可追踪的 trace，方便在 Langfuse 中排查问题、分析调用路径和观察模型行为。

## 2. 适用场景

这个插件适合下面几类场景：

- 需要在 Langfuse 中观察 OpenClaw 一次请求的完整执行链路。
- 需要定位某次回答为什么慢、为什么失败、失败发生在 Agent、LLM 还是 Tool。
- 需要分析多 Agent 或 Subagent 协作时的调用关系。
- 需要复盘某次会话中模型输入、输出、Token 使用量、Tool 参数和结果。
- 需要给不同环境的 OpenClaw 实例统一上报 tracing 数据，例如 `dev`、`staging`、`prod`。

不适合的场景：

- 只想看 metrics 或 logs。Langfuse 的 `/api/public/otel` 当前只接收 traces，本插件不会向 Langfuse 上报 metrics 和 logs。

## 3. 整体原理

插件启动后会做几件事：

1. 读取插件配置，组装 Langfuse OTLP Trace 上报地址和认证头。
2. 初始化 OpenTelemetry `NodeTracerProvider` 和 `OTLPTraceExporter`。
3. 监听 OpenClaw 的事件，例如消息收发、模型调用、工具调用、Subagent 生命周期等。
4. 为这些事件创建或复用 trace context，并生成对应 span。
5. 使用 `BatchSpanProcessor` 批量把 span 导出到 Langfuse。

可以把它理解成一层“事件到 trace 的翻译器”：

- OpenClaw 负责产生运行事件。
- 本插件负责把事件组织成 trace/span。
- OpenTelemetry 负责导出。
- Langfuse 负责展示与检索。

## 4. trace 是怎么串起来的

插件内部维护了一套上下文映射，用来把离散事件关联成同一条 trace，主要按下面几类 key 关联：

- `sessionKey`
- `conversationId`
- `runId`
- `toolCallId`

核心思路是：

- 当收到 `message_received` 等入口事件时，创建 root trace。
- 后续的 `before_model_resolve`、`llm_input`、`before_tool_call` 等事件会复用同一个 trace context。
- Tool 调用、LLM 调用、Agent 执行会挂在对应父 span 下面，形成树状链路。
- Subagent 启动时会继承上游 trace，并生成自己的生命周期 span。
- 请求结束后，插件会延迟结束 root span，尽量把最后的输出、Agent 结束和消息发送结果都挂进去。

为避免上下文泄漏，插件还实现了超时清理：

- trace context 默认 30 分钟过期。
- 未结束 span 默认 15 分钟超时清理。

## 5. OpenClaw 事件与 Langfuse 观测对象映射

当前版本大致会导出下面这些数据：

| OpenClaw 事件 / 阶段 | 在 Langfuse 中的类型 | 说明 |
|------|------|------|
| 根请求 | trace + `span` observation | 一次用户请求的总入口 |
| `session_start` / `session_end` | `span` | 会话生命周期 |
| `message_received` / `message_sending` / `message_sent` | `span` | 收发消息过程 |
| `before_model_resolve` / `agent_end` | `agent` | Agent 生命周期 |
| `llm_input` / `llm_output` | `generation` | 模型调用、输入输出、token 使用量 |
| `before_tool_call` / `after_tool_call` | `tool` | 工具调用参数、结果、错误 |
| `tool_result_persist` | `tool` | 工具结果持久化 |
| `subagent_spawning` / `subagent_spawned` / `subagent_ended` | `agent` | Subagent 生命周期 |
| `after_compaction` | `span` | 真正的会话压缩生命周期 |
| `command:new` / `command:reset` / `command:stop` | `span` | 命令级事件 |
| `gateway_start` / `gateway_stop` | `span` | 网关启动和停止 |

## 6. 会上报哪些字段

插件会把一部分信息作为 Langfuse / OTEL 标准属性写入，也会附带一些 OpenClaw 运行时属性。

常见信息包括：

- trace 名称
- 用户输入与最终输出
- `user.id`、`session.id`
- OpenClaw 的 `sessionKey`、`conversationId`、`channelId`
- Agent ID、触发来源、消息提供方
- 模型提供商、模型名、prompt / completion 内容
- token 使用量，包括输入、输出、总量、cache read、cache write
- Tool 名称、参数、结果、错误
- Subagent 标签、模式、runId、会话关系
- compaction 统计信息

其中详细内容是否上报，受 `allowUserDetailInfoReport` 控制。

## 7. 隐私与数据边界

`allowUserDetailInfoReport` 默认是 `true`。这意味着插件会尽量把以下内容带上报文：

- 用户输入
- 模型 prompt / completion
- Tool 参数和结果
- 会话消息内容

如果你的场景对敏感数据比较严格，建议显式关闭：

```json
{
  "allowUserDetailInfoReport": false
}
```

关闭后，插件仍会上报链路结构和部分元数据，但会减少详细内容暴露。

另外，属性值过长时会被截断，当前单个属性最大长度为 65536 字符。

## 8. 安装方式

```bash
openclaw plugins install /path/to/package/openclaw-langfuse-trace-0.1.2.tgz
```

安装后，需要在 OpenClaw 配置中允许并启用这个插件。

## 9. 配置项说明

插件配置定义在 `plugins.entries.openclaw-langfuse-trace.config` 下。

### 9.1 必填配置

| 参数 | 类型 | 是否必填 | 说明 |
|------|------|------|------|
| `langfuseBaseUrl` | string | 是 | Langfuse 地址，例如 `https://cloud.langfuse.com`、`https://us.cloud.langfuse.com` 或自建地址 |
| `langfusePublicKey` | string | 是 | Langfuse 项目公钥，形如 `pk-lf-...` |
| `langfuseSecretKey` | string | 是 | Langfuse 项目私钥，形如 `sk-lf-...` |

插件会基于这三个参数自动拼接 trace 上报地址：

```text
{langfuseBaseUrl}/api/public/otel/v1/traces
```

并通过 Basic Auth 方式鉴权。

### 9.2 可选配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|------|------|
| `serviceName` | string | `openclaw` | OTEL Resource 中的 `service.name` |
| `environment` | string | `default` | Langfuse 环境标识 |
| `headers` | object | `{}` | 额外请求头，会合并到导出请求中 |
| `debug` | boolean | `false` | 是否打印调试日志 |
| `allowUserDetailInfoReport` | boolean | `true` | 是否上报详细输入输出内容 |
| `extraResourceAttributes` | object | `{}` | 额外的 OTEL Resource 属性 |

### 9.3 已废弃配置

下面这些字段仍然出现在 schema 中，但已经不建议继续使用：

| 参数 | 现状 |
|------|------|
| `endpoint` | 已废弃。仅作为直接 OTLP endpoint 覆盖项保留，优先使用 `langfuseBaseUrl` + key 配置 |
| `openclawNativeMetrics` | 已废弃且基本无效，Langfuse OTLP 不接收 metrics |
| `log` | 已废弃且无效，Langfuse OTLP 不接收 logs |
| `reportDiagnosticsLog` | 已废弃且无效 |
| `diagnosticsLogEndpoint` | 已废弃且无效 |

## 10. 配置示例

### 10.1 最小可用配置

```json
{
  "plugins": {
    "allow": ["openclaw-langfuse-trace"],
    "entries": {
      "openclaw-langfuse-trace": {
        "enabled": true,
        "config": {
          "langfuseBaseUrl": "https://cloud.langfuse.com",
          "langfusePublicKey": "pk-lf-xxxxx",
          "langfuseSecretKey": "sk-lf-xxxxx"
        }
      }
    }
  }
}
```

### 10.2 生产环境示例

```json
{
  "plugins": {
    "allow": ["openclaw-langfuse-trace"],
    "entries": {
      "openclaw-langfuse-trace": {
        "enabled": true,
        "config": {
          "langfuseBaseUrl": "https://cloud.langfuse.com",
          "langfusePublicKey": "pk-lf-xxxxx",
          "langfuseSecretKey": "sk-lf-xxxxx",
          "serviceName": "openclaw-agent",
          "environment": "prod",
          "debug": false,
          "allowUserDetailInfoReport": false,
          "extraResourceAttributes": {
            "deployment.region": "cn-shanghai",
            "team": "ai-platform"
          }
        }
      }
    }
  }
}
```

## 11. 使用方式

配置完成并重启 OpenClaw 后，插件会自动工作，不需要业务侧额外调用接口。

典型使用流程：

1. 安装插件。
2. 在 `openclaw.json` 中启用插件并填写 Langfuse 配置。
3. 重启 OpenClaw。
4. 发起一次对话、工具调用或 Subagent 协作。
5. 在 Langfuse 中查看对应 trace。

通常你会在 Langfuse 中看到：

- 一个 root trace，代表一次 OpenClaw 请求。
- 若干子 span，表示消息收发、Agent、LLM、Tool、Subagent 等阶段。
- LLM generation 中包含模型、prompt、completion 和 usage。

## 12. 调试与排查

如果你怀疑没有上报成功，可以按下面顺序排查：

### 12.1 打开调试日志

```json
{
  "debug": true
}
```

打开后，插件会输出带 `[OpenClaw Langfuse Plugin]` 前缀的日志，例如：

- 插件初始化是否成功
- exporter URL 是什么
- 是否缺少 Langfuse 配置
- context / span 是否因超时被清理
- flush 是否失败

### 12.2 检查配置是否完整

至少确认这三个字段已经填写：

- `langfuseBaseUrl`
- `langfusePublicKey`
- `langfuseSecretKey`

如果缺失，插件会直接告警并跳过初始化。

### 12.3 检查 Langfuse 地址是否正确

插件不是直接把数据发到根地址，而是发到：

```text
/api/public/otel/v1/traces
```

如果 `langfuseBaseUrl` 配错，或者自建 Langfuse 没暴露这个接口，trace 不会入库。

### 12.4 检查是否误以为会有 metrics / logs

这个插件当前只导出 traces。如果你在 Langfuse 里期待看到 metrics 或 logs，那不是这个插件的输出范围。

## 13. 设计取舍

这个插件当前的设计重点是“把 OpenClaw 的运行链路尽可能稳定地映射到 Langfuse trace”，所以会有一些明确取舍：

- 优先保证 trace 串联完整，而不是追求每个事件都一比一还原。
- 优先使用 Langfuse 支持的 trace/observation 模型，不再保留 metrics/log exporter。
- 通过内存上下文映射关联事件，因此更适合单进程内链路追踪。
- 对长文本做截断，避免属性过大导致导出失败或负担过重。

## 14. 当前能力边界

截至当前版本，已知边界包括：

- 只支持 traces / observations，不支持 metrics / logs。
- trace 关联依赖运行时事件顺序和内存上下文，不是跨进程分布式追踪方案。
- 某些事件如果缺少上下文，可能会退化为独立 span，而不是理想父子结构。
- 如果关闭详细上报，Langfuse 中能看到的内容会更偏结构化链路而不是完整业务内容。

## 15. 代码入口参考

如果需要继续深入实现，可以重点看这些文件：

- `src/index.js`：插件入口、事件注册、导出逻辑
- `src/trace/context.js`：trace context 管理
- `src/trace/span.js`：span 创建、结束、超时清理
- `openclaw.plugin.json`：插件定义与配置 schema

## 16. 总结

这个插件的核心价值不是“多打一些日志”，而是把 OpenClaw 的执行过程变成一条可浏览、可检索、可定位问题的 trace。

如果你需要在 Langfuse 中观察 OpenClaw 的请求入口、Agent 决策、模型调用、Tool 执行和 Subagent 协作，这个插件就是为这个目标设计的。
