import { LangfuseExporter } from "./langfuse-exporter.js";
function generateId(length = 16) {
    const chars = "0123456789abcdef";
    let result = "";
    for (let index = 0; index < length; index += 1) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}
function safeClone(value) {
    if (typeof globalThis.structuredClone === "function") {
        return globalThis.structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}
function normalizeChannelId(input, defaultPlatform = "system") {
    if (!input || input === "unknown") {
        return `${defaultPlatform}/unknown`;
    }
    if (input.includes("/")) {
        return input;
    }
    const prefix = input.split(/[_:]/)[0];
    switch (prefix) {
        case "ou":
        case "oc":
        case "og":
            return `feishu/${input}`;
        case "user":
        case "chat":
            return `feishu/${input.slice(prefix.length + 1)}`;
        case "agent":
            return `agent/${input.slice(6)}`;
        default:
            return `${defaultPlatform}/${input}`;
    }
}
function resolveChannelId(ctx, eventFrom, defaultValue = "system/unknown") {
    if (ctx.conversationId && /^(user|chat):/.test(ctx.conversationId)) {
        return normalizeChannelId(ctx.conversationId);
    }
    if (eventFrom && /^feishu:/.test(eventFrom)) {
        return `feishu/${eventFrom.slice(7)}`;
    }
    if (ctx.channelId && /^feishu\/(ou|oc|og)_/.test(ctx.channelId)) {
        return ctx.channelId;
    }
    const raw = ctx.sessionKey || ctx.channelId || eventFrom || defaultValue;
    return normalizeChannelId(raw);
}
function getString(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
}
function getOptionalString(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
function getBoolean(value, fallback = false) {
    return typeof value === "boolean" ? value : fallback;
}
function getNumber(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function getStringArray(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const items = value.filter((item) => typeof item === "string");
    return items.length > 0 ? items : undefined;
}
function getLastAssistantUsage(lastAssistant) {
    if (!lastAssistant || typeof lastAssistant !== "object") {
        return undefined;
    }
    const usage = lastAssistant.usage;
    return usage && typeof usage === "object" ? usage : undefined;
}
let lastUserChannelId;
let lastUserTraceContext;
let pendingToolCall;
const langfuseTracePlugin = {
    id: "openclaw-langfuse-trace",
    name: "OpenClaw Langfuse Trace",
    version: "0.1.0",
    description: "Report OpenClaw execution traces to Langfuse via OpenTelemetry",
    activate(api) {
        const pluginConfig = api.pluginConfig || {};
        const publicKey = getString(pluginConfig.publicKey);
        const secretKey = getString(pluginConfig.secretKey);
        if (!publicKey || !secretKey) {
            api.logger.error("[LangfuseTrace] Missing required configuration: 'publicKey' and 'secretKey' must be provided");
            return;
        }
        const config = {
            baseUrl: getString(pluginConfig.baseUrl) ||
                getString(pluginConfig.endpoint) ||
                "https://cloud.langfuse.com",
            publicKey,
            secretKey,
            serviceName: getString(pluginConfig.serviceName) || "openclaw-agent",
            environment: getOptionalString(pluginConfig.environment),
            release: getOptionalString(pluginConfig.release),
            debug: getBoolean(pluginConfig.debug, false),
            batchSize: getNumber(pluginConfig.batchSize, 10),
            batchInterval: getNumber(pluginConfig.batchInterval, 5_000),
            enabledHooks: getStringArray(pluginConfig.enabledHooks),
        };
        const buildBaseAttributes = (ctx, channelId, type, attributes = {}) => ({
            ...attributes,
            "session.id": channelId,
            "langfuse.session.id": channelId,
            "run.id": ctx.runId,
            "turn.id": ctx.turnId,
            ...(config.environment ? { "langfuse.environment": config.environment } : {}),
            ...(config.release ? { "langfuse.release": config.release } : {}),
            "langfuse.trace.metadata.channel_id": channelId,
            "langfuse.trace.metadata.run_id": ctx.runId,
            "langfuse.trace.metadata.turn_id": ctx.turnId,
            "langfuse.trace.metadata.integration": "openclaw",
            "langfuse.observation.type": type === "model" ? "generation" : "span",
            "langfuse.observation.metadata.openclaw_span_type": type,
        });
        const exporter = new LangfuseExporter(api, config);
        const contextByChannelId = new Map();
        const contextByRunId = new Map();
        const shouldHookEnabled = (hookName) => {
            if (!config.enabledHooks) {
                return true;
            }
            return config.enabledHooks.includes(hookName);
        };
        const getContextByChannel = (channelId) => contextByChannelId.get(channelId);
        const getContextByRun = (runId) => contextByRunId.get(runId);
        const getOriginalChannelId = (runId) => {
            const ctx = contextByRunId.get(runId);
            return ctx?.originalChannelId || ctx?.channelId;
        };
        const startTurn = (runId, channelId, originalChannelId) => {
            const ctx = {
                traceId: generateId(32),
                rootSpanId: generateId(16),
                runId,
                turnId: runId,
                channelId,
                originalChannelId: originalChannelId || channelId,
            };
            contextByChannelId.set(channelId, ctx);
            contextByRunId.set(runId, ctx);
            return ctx;
        };
        const endTurn = (channelId) => {
            const ctx = contextByChannelId.get(channelId);
            if (!ctx) {
                return;
            }
            contextByChannelId.delete(channelId);
            contextByRunId.delete(ctx.runId);
        };
        const getOrCreateContext = (rawChannelId, runId, hookName) => {
            let channelId = rawChannelId;
            let activeCtx = getContextByChannel(rawChannelId);
            const effectiveRunId = runId || activeCtx?.runId || `run-${Date.now()}`;
            if (rawChannelId.startsWith("agent/")) {
                const originalChannelId = getOriginalChannelId(effectiveRunId);
                if (originalChannelId) {
                    channelId = originalChannelId;
                    activeCtx = getContextByChannel(originalChannelId) || activeCtx;
                }
            }
            if (!activeCtx) {
                activeCtx = getContextByRun(effectiveRunId);
            }
            if (!activeCtx && rawChannelId.startsWith("agent/") && lastUserTraceContext) {
                activeCtx = lastUserTraceContext;
                channelId = lastUserChannelId || channelId;
                contextByChannelId.set(rawChannelId, activeCtx);
                contextByRunId.set(effectiveRunId, activeCtx);
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] LINKING agent to user context: hook=${hookName}, agentChannel=${rawChannelId}, userChannel=${channelId}, traceId=${activeCtx.traceId}`);
                }
            }
            let isNew = false;
            if (!activeCtx) {
                activeCtx = startTurn(effectiveRunId, channelId, rawChannelId !== channelId ? rawChannelId : undefined);
                isNew = true;
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] NEW TraceContext created: hook=${hookName}, channelId=${channelId}, runId=${effectiveRunId}, traceId=${activeCtx.traceId}`);
                }
            }
            else if (config.debug) {
                api.logger.info(`[LangfuseTrace] REUSING TraceContext: hook=${hookName}, channelId=${channelId}, runId=${effectiveRunId}, traceId=${activeCtx.traceId}`);
            }
            return { ctx: activeCtx, channelId, isNew };
        };
        const createSpan = (ctx, channelId, name, type, startTime, endTime, attributes = {}, input, output, parentSpanId) => {
            const resolvedParentSpanId = parentSpanId ??
                ctx.agentSpanId ??
                (ctx.rootSpanStartTime ? ctx.rootSpanId : undefined);
            return {
                name,
                type,
                startTime,
                endTime,
                attributes: buildBaseAttributes(ctx, channelId, type, attributes),
                input,
                output,
                traceId: ctx.traceId,
                spanId: generateId(16),
                parentSpanId: resolvedParentSpanId,
            };
        };
        api.on("gateway_stop", async () => {
            await exporter.dispose();
        });
        if (shouldHookEnabled("gateway_start")) {
            api.on("gateway_start", async (event) => {
                const now = Date.now();
                const { ctx, channelId } = getOrCreateContext("system/gateway", undefined, "gateway_start");
                const span = createSpan(ctx, channelId, "gateway_start", "gateway", now, now, {
                    "gateway.version": event.version || "unknown",
                    "gateway.working_dir": event.workingDir || process.cwd(),
                });
                await exporter.export(span);
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] Exported gateway_start span, traceId=${ctx.traceId}`);
                }
            });
        }
        if (shouldHookEnabled("session_start")) {
            api.on("session_start", async (event, hookCtx) => {
                const rawChannelId = resolveChannelId(hookCtx, event.sessionId);
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] session_start hookCtx: ${JSON.stringify({
                        channelId: hookCtx.channelId,
                        sessionKey: hookCtx.sessionKey,
                        conversationId: hookCtx.conversationId,
                    })}`);
                }
                const { ctx, channelId } = getOrCreateContext(rawChannelId, undefined, "session_start");
                const now = Date.now();
                const span = createSpan(ctx, channelId, "session_start", "entry", now, now, {
                    "event.type": "session_start",
                });
                await exporter.export(span);
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] Exported session_start: ${channelId}, traceId=${ctx.traceId}`);
                }
            });
        }
        if (shouldHookEnabled("session_end")) {
            api.on("session_end", async (event, hookCtx) => {
                const rawChannelId = resolveChannelId(hookCtx, event.sessionId);
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] session_end hookCtx: ${JSON.stringify({
                        channelId: hookCtx.channelId,
                        sessionKey: hookCtx.sessionKey,
                        conversationId: hookCtx.conversationId,
                    })}`);
                }
                const { ctx, channelId } = getOrCreateContext(rawChannelId, undefined, "session_end");
                const now = Date.now();
                const span = createSpan(ctx, channelId, "session_end", "entry", now, now, {
                    "session.duration_ms": event.duration || 0,
                    "session.message_count": event.messageCount || 0,
                    "session.total_tokens": event.totalTokens || 0,
                }, undefined, {
                    messageCount: event.messageCount,
                    totalTokens: event.totalTokens,
                });
                await exporter.export(span);
                endTurn(channelId);
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] Exported session_end: ${channelId}`);
                }
            });
        }
        if (shouldHookEnabled("message_received")) {
            api.on("message_received", async (event, hookCtx) => {
                const rawChannelId = resolveChannelId(hookCtx, event.from || event.metadata?.senderId);
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] message_received hookCtx: ${JSON.stringify({
                        channelId: hookCtx.channelId,
                        sessionKey: hookCtx.sessionKey,
                        conversationId: hookCtx.conversationId,
                    })}, event.from=${event.from}`);
                }
                const { ctx, channelId, isNew } = getOrCreateContext(rawChannelId, undefined, "message_received");
                const now = Date.now();
                let role = event.role;
                if (!role && event.from) {
                    role = "user";
                }
                if (role === "user" && !rawChannelId.startsWith("agent/")) {
                    lastUserChannelId = channelId;
                    lastUserTraceContext = ctx;
                    ctx.userInput = event.content;
                    if (config.debug) {
                        api.logger.info(`[LangfuseTrace] Saved user context: channelId=${channelId}, traceId=${ctx.traceId}`);
                    }
                    if (isNew) {
                        ctx.rootSpanStartTime = now;
                        const rootSpanData = {
                            name: "openclaw_request",
                            type: "entry",
                            startTime: now,
                            attributes: buildBaseAttributes(ctx, channelId, "entry", {
                                "langfuse.trace.name": "openclaw_request",
                            }),
                            input: ctx.userInput,
                            traceId: ctx.traceId,
                            spanId: ctx.rootSpanId,
                        };
                        await exporter.startSpan(rootSpanData, ctx.rootSpanId);
                        if (config.debug) {
                            api.logger.info(`[LangfuseTrace] Started root span: traceId=${ctx.traceId}, spanId=${ctx.rootSpanId}`);
                        }
                    }
                }
                const span = createSpan(ctx, channelId, role === "user" ? "user_message" : "message_received", "message", now, now, {
                    "message.role": role || "unknown",
                    "message.from": event.from || "unknown",
                }, event.content);
                await exporter.export(span);
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] Exported message_received: ${channelId}, role=${role}, traceId=${ctx.traceId}`);
                }
            });
        }
        if (shouldHookEnabled("message_sending")) {
            api.on("message_sending", async (event, hookCtx) => {
                if (lastUserTraceContext) {
                    lastUserTraceContext.lastOutput = event.content;
                    if (config.debug) {
                        api.logger.info(`[LangfuseTrace] Captured output for root span: traceId=${lastUserTraceContext.traceId}, content=${typeof event.content === "string" ? event.content.substring(0, 100) : "non-string"}`);
                    }
                    return;
                }
                const rawChannelId = resolveChannelId(hookCtx, event.to);
                const { ctx } = getOrCreateContext(rawChannelId, undefined, "message_sending");
                ctx.lastOutput = event.content;
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] Captured output (fallback) for root span: traceId=${ctx.traceId}`);
                }
            });
        }
        if (shouldHookEnabled("message_sent")) {
            api.on("message_sent", async (event, hookCtx) => {
                if (!event.content || !event.success) {
                    return;
                }
                if (lastUserTraceContext) {
                    lastUserTraceContext.lastOutput = event.content;
                    if (config.debug) {
                        api.logger.info(`[LangfuseTrace] Captured output from message_sent: traceId=${lastUserTraceContext.traceId}`);
                    }
                    return;
                }
                const rawChannelId = resolveChannelId(hookCtx, event.to);
                const { ctx } = getOrCreateContext(rawChannelId, undefined, "message_sent");
                ctx.lastOutput = event.content;
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] Captured output from message_sent (fallback): traceId=${ctx.traceId}`);
                }
            });
        }
        let lastLlmInput;
        let lastLlmStartTime;
        let lastLlmSpanId;
        if (shouldHookEnabled("llm_input")) {
            api.on("llm_input", async (event, hookCtx) => {
                const rawChannelId = resolveChannelId(hookCtx);
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] llm_input hookCtx: ${JSON.stringify({
                        channelId: hookCtx.channelId,
                        sessionKey: hookCtx.sessionKey,
                        conversationId: hookCtx.conversationId,
                    })}, event.runId=${event.runId}`);
                }
                const { ctx } = getOrCreateContext(rawChannelId, event.runId, "llm_input");
                ctx.llmStartTime = Date.now();
                ctx.llmSpanId = generateId(16);
                const messages = [];
                if (event.systemPrompt) {
                    messages.push({ role: "system", content: safeClone(event.systemPrompt) });
                }
                if (event.historyMessages?.length) {
                    messages.push(...event.historyMessages.map((message) => safeClone(message)));
                }
                if (event.prompt) {
                    messages.push({ role: "user", content: safeClone(event.prompt) });
                }
                const convertToolCallInPlace = (target) => {
                    if (target.type !== "toolCall") {
                        return;
                    }
                    target.type = "tool_use";
                    if ("arguments" in target) {
                        target.input = target.arguments;
                        delete target.arguments;
                    }
                };
                const convertToolCallDeepInPlace = (value) => {
                    if (!value) {
                        return;
                    }
                    if (Array.isArray(value)) {
                        for (const item of value) {
                            convertToolCallDeepInPlace(item);
                        }
                        return;
                    }
                    if (typeof value !== "object") {
                        return;
                    }
                    const objectValue = value;
                    convertToolCallInPlace(objectValue);
                    if ("content" in objectValue) {
                        convertToolCallDeepInPlace(objectValue.content);
                    }
                };
                for (const message of messages) {
                    convertToolCallDeepInPlace(message);
                }
                ctx.llmInput = { messages };
                lastLlmInput = ctx.llmInput;
                lastLlmStartTime = ctx.llmStartTime;
                lastLlmSpanId = ctx.llmSpanId;
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] LLM input started: ${event.provider}/${event.model}, runId=${event.runId}, traceId=${ctx.traceId}`);
                }
            });
        }
        if (shouldHookEnabled("llm_output")) {
            api.on("llm_output", async (event, hookCtx) => {
                const rawChannelId = resolveChannelId(hookCtx);
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace][DEBUG] llm_output event.usage=${JSON.stringify(event.usage)}`);
                    api.logger.info(`[LangfuseTrace][DEBUG] llm_output event.lastAssistant=${JSON.stringify(event.lastAssistant)}`);
                    api.logger.info(`[LangfuseTrace][DEBUG] llm_output event keys=${JSON.stringify(Object.keys(event))}`);
                    api.logger.info(`[LangfuseTrace] llm_output hookCtx: ${JSON.stringify({
                        channelId: hookCtx.channelId,
                        sessionKey: hookCtx.sessionKey,
                        conversationId: hookCtx.conversationId,
                    })}, event.runId=${event.runId}`);
                }
                const { ctx, channelId } = getOrCreateContext(rawChannelId, event.runId, "llm_output");
                const now = Date.now();
                const startTime = ctx.llmStartTime || lastLlmStartTime || now;
                if (event.assistantTexts?.length) {
                    const outputText = event.assistantTexts.join("\n");
                    ctx.lastOutput = outputText;
                    if (lastUserTraceContext) {
                        lastUserTraceContext.lastOutput = outputText;
                    }
                    if (config.debug) {
                        api.logger.info(`[LangfuseTrace] Captured output from llm_output (will use last): traceId=${ctx.traceId}, length=${outputText.length}`);
                    }
                }
                const llmInput = ctx.llmInput || lastLlmInput;
                const llmSpanId = ctx.llmSpanId || lastLlmSpanId;
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] llm_output ctx: traceId=${ctx.traceId}, rootSpanId=${ctx.rootSpanId}, llmSpanId=${llmSpanId || "none"}, hasInput=${Boolean(llmInput)}`);
                }
                const lastAssistantUsage = getLastAssistantUsage(event.lastAssistant);
                const inputTokens = event.usage?.input ?? lastAssistantUsage?.input ?? 0;
                const outputTokens = event.usage?.output ?? lastAssistantUsage?.output ?? 0;
                const usageDetails = {
                    input: inputTokens,
                    output: outputTokens,
                    total: inputTokens + outputTokens,
                };
                const span = createSpan(ctx, channelId, `${event.provider}/${event.model}`, "model", startTime, now, {
                    "gen_ai.provider.name": event.provider,
                    "gen_ai.request.model": event.model,
                    "gen_ai.usage.input_tokens": inputTokens,
                    "gen_ai.usage.output_tokens": outputTokens,
                    "langfuse.observation.model.name": event.model,
                    "langfuse.observation.usage_details": JSON.stringify(usageDetails),
                    "langfuse.observation.metadata.model_provider": event.provider,
                }, llmInput, { assistantTexts: event.assistantTexts?.slice(0, 3) });
                if (llmSpanId) {
                    span.spanId = llmSpanId;
                }
                ctx.llmStartTime = undefined;
                ctx.llmSpanId = undefined;
                ctx.llmInput = undefined;
                lastLlmInput = undefined;
                lastLlmStartTime = undefined;
                lastLlmSpanId = undefined;
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] llm_output span created: spanId=${span.spanId}, parentSpanId=${span.parentSpanId}`);
                }
                await exporter.export(span);
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] Exported LLM span: ${event.provider}/${event.model}, duration=${now - startTime}ms, traceId=${ctx.traceId}`);
                }
            });
        }
        if (shouldHookEnabled("before_tool_call")) {
            api.on("before_tool_call", async (event, hookCtx) => {
                const rawChannelId = resolveChannelId(hookCtx);
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] before_tool_call hookCtx: ${JSON.stringify({
                        channelId: hookCtx.channelId,
                        sessionKey: hookCtx.sessionKey,
                        conversationId: hookCtx.conversationId,
                    })}, toolName=${event.toolName}`);
                }
                const { ctx, channelId } = getOrCreateContext(rawChannelId, undefined, "before_tool_call");
                pendingToolCall = {
                    toolName: event.toolName,
                    toolSpanId: generateId(16),
                    toolStartTime: Date.now(),
                    toolInput: event.params,
                    traceContext: ctx,
                    channelId,
                };
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] Tool call started: ${event.toolName}, spanId=${pendingToolCall.toolSpanId}, traceId=${ctx.traceId}`);
                }
            });
        }
        if (shouldHookEnabled("after_tool_call")) {
            api.on("after_tool_call", async (event, hookCtx) => {
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] after_tool_call hookCtx: ${JSON.stringify({
                        channelId: hookCtx.channelId,
                        sessionKey: hookCtx.sessionKey,
                        conversationId: hookCtx.conversationId,
                    })}, toolName=${event.toolName}`);
                }
                if (!pendingToolCall || pendingToolCall.toolName !== event.toolName) {
                    if (config.debug) {
                        api.logger.info(`[LangfuseTrace] Skipping after_tool_call: no pending tool or name mismatch, toolName=${event.toolName}, pending=${pendingToolCall?.toolName}`);
                    }
                    return;
                }
                const { toolName, toolSpanId, toolStartTime, toolInput, traceContext, channelId } = pendingToolCall;
                pendingToolCall = undefined;
                const now = Date.now();
                const span = createSpan(traceContext, channelId, toolName, "tool", toolStartTime, now, {
                    "tool.name": toolName,
                    "tool.duration_ms": event.durationMs || now - toolStartTime,
                    "tool.error": Boolean(event.error),
                }, toolInput, event.error ? { error: event.error } : event.result);
                span.spanId = toolSpanId;
                await exporter.export(span);
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] Exported tool span: ${toolName}, spanId=${toolSpanId}, duration=${now - toolStartTime}ms, traceId=${traceContext.traceId}`);
                }
            });
        }
        if (shouldHookEnabled("before_agent_start")) {
            api.on("before_agent_start", async (event, hookCtx) => {
                const rawChannelId = resolveChannelId(hookCtx);
                const agentId = hookCtx.agentId || event.agentId || "main";
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] before_agent_start hookCtx: ${JSON.stringify({
                        channelId: hookCtx.channelId,
                        sessionKey: hookCtx.sessionKey,
                        conversationId: hookCtx.conversationId,
                        agentId: hookCtx.agentId,
                    })}, event.agentId=${event.agentId}`);
                }
                const { ctx, channelId } = getOrCreateContext(rawChannelId, undefined, "before_agent_start");
                if (ctx.agentSpanId) {
                    if (config.debug) {
                        api.logger.info(`[LangfuseTrace] Agent span already started, skipping: ${agentId}, traceId=${ctx.traceId}`);
                    }
                    return;
                }
                const now = Date.now();
                ctx.agentStartTime = now;
                ctx.agentSpanId = generateId(16);
                const spanData = {
                    name: agentId,
                    type: "agent",
                    startTime: now,
                    attributes: {
                        "agent.id": agentId,
                        "session.id": channelId,
                        "run.id": ctx.runId,
                        "turn.id": ctx.turnId,
                    },
                    traceId: ctx.traceId,
                    spanId: ctx.agentSpanId,
                    parentSpanId: ctx.rootSpanStartTime ? ctx.rootSpanId : undefined,
                };
                await exporter.startSpan(spanData, ctx.agentSpanId);
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] Started agent span: ${agentId}, spanId=${ctx.agentSpanId}, traceId=${ctx.traceId}`);
                }
            });
        }
        if (shouldHookEnabled("agent_end")) {
            api.on("agent_end", async (event, hookCtx) => {
                const rawChannelId = resolveChannelId(hookCtx);
                if (config.debug) {
                    api.logger.info(`[LangfuseTrace] agent_end hookCtx: ${JSON.stringify({
                        channelId: hookCtx.channelId,
                        sessionKey: hookCtx.sessionKey,
                        conversationId: hookCtx.conversationId,
                    })}`);
                }
                const { ctx, channelId } = getOrCreateContext(rawChannelId, undefined, "agent_end");
                const now = Date.now();
                if (ctx.agentSpanId) {
                    exporter.endSpanById(ctx.agentSpanId, now, {
                        "agent.duration_ms": event.durationMs || 0,
                        "agent.message_count": event.messageCount || 0,
                        "agent.tool_call_count": event.toolCallCount || 0,
                        "agent.total_tokens": event.usage?.total || 0,
                    }, { usage: event.usage, cost: event.cost });
                    if (config.debug) {
                        api.logger.info(`[LangfuseTrace] Ended agent span: spanId=${ctx.agentSpanId}, duration=${event.durationMs}ms, traceId=${ctx.traceId}`);
                    }
                    ctx.agentSpanId = undefined;
                    ctx.agentStartTime = undefined;
                }
                const savedLastUserTraceContext = lastUserTraceContext;
                if (savedLastUserTraceContext) {
                    savedLastUserTraceContext.lastOutput = undefined;
                }
                const savedLastUserChannelId = lastUserChannelId;
                const originalChannelId = ctx.originalChannelId || savedLastUserChannelId || channelId;
                lastUserChannelId = undefined;
                lastUserTraceContext = undefined;
                if (savedLastUserChannelId) {
                    endTurn(savedLastUserChannelId);
                }
                if (originalChannelId && originalChannelId !== savedLastUserChannelId) {
                    endTurn(originalChannelId);
                }
                const rootCtx = savedLastUserTraceContext || ctx;
                const agentChannelId = channelId;
                if (rootCtx.rootSpanStartTime) {
                    const rootSpanId = rootCtx.rootSpanId;
                    const rootSpanStartTime = rootCtx.rootSpanStartTime;
                    const userInput = rootCtx.userInput;
                    const traceId = rootCtx.traceId;
                    setTimeout(async () => {
                        const agentCtx = getContextByChannel(agentChannelId);
                        const finalOutput = agentCtx?.lastOutput || rootCtx.lastOutput;
                        if (config.debug) {
                            api.logger.info(`[LangfuseTrace] Ending root span (delayed) with input=${userInput ? "present" : "missing"}, output=${finalOutput ? "present" : "missing"}`);
                        }
                        const endTime = Date.now();
                        exporter.endSpanById(rootSpanId, endTime, {
                            "request.duration_ms": endTime - rootSpanStartTime,
                        }, finalOutput, userInput);
                        if (config.debug) {
                            api.logger.info(`[LangfuseTrace] Ended root span: spanId=${rootSpanId}, duration=${endTime - rootSpanStartTime}ms, traceId=${traceId}`);
                        }
                        await exporter.flush();
                        exporter.endTrace();
                    }, 100);
                }
                else {
                    await exporter.flush();
                    exporter.endTrace();
                }
            });
        }
        api.logger.info(`[LangfuseTrace] Plugin activated (baseUrl: ${config.baseUrl}, environment: ${config.environment || "default"})`);
    },
};
export default langfuseTracePlugin;
