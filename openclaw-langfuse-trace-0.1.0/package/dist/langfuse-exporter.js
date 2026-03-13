import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Resource } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_INSTANCE_ID, ATTR_SERVICE_NAME, } from "@opentelemetry/semantic-conventions";
import { hostname } from "node:os";
import { basename } from "node:path";
const LANGFUSE_OTLP_PATH = "/api/public/otel/v1/traces";
const MAX_OBSERVATION_PAYLOAD_SIZE = 3_200_000;
function normalizeBaseUrl(baseUrl = "https://cloud.langfuse.com") {
    return baseUrl.replace(/\/+$/, "");
}
function getLangfuseTracesUrl(baseUrl) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (normalized.endsWith("/v1/traces")) {
        return normalized;
    }
    if (normalized.endsWith("/api/public/otel")) {
        return `${normalized}/v1/traces`;
    }
    return `${normalized}${LANGFUSE_OTLP_PATH}`;
}
function createBasicAuthHeader(publicKey, secretKey) {
    const credentials = `${publicKey}:${secretKey}`;
    return `Basic ${Buffer.from(credentials).toString("base64")}`;
}
function serializeValue(value) {
    return typeof value === "string" ? value : JSON.stringify(value);
}
export class LangfuseExporter {
    api;
    config;
    provider = null;
    tracer = null;
    initialized = false;
    initPromise = null;
    currentRootSpan = null;
    currentRootContext = null;
    currentAgentSpan = null;
    currentAgentContext = null;
    openSpans = new Map();
    constructor(api, config) {
        this.api = api;
        this.config = config;
    }
    async ensureInitialized() {
        if (this.initialized) {
            return;
        }
        if (this.initPromise) {
            return this.initPromise;
        }
        this.initPromise = this.initialize();
        await this.initPromise;
    }
    async initialize() {
        this.api.logger.info("[LangfuseTrace] Initializing exporter...");
        const instanceName = this.config.serviceName || basename(process.cwd()) || "openclaw-agent";
        const instanceId = `${instanceName}@${hostname()}:${process.pid}`;
        const resource = new Resource({
            [ATTR_SERVICE_NAME]: this.config.serviceName,
            [ATTR_SERVICE_INSTANCE_ID]: instanceId,
            "host.name": hostname(),
            ...(this.config.environment
                ? { "deployment.environment": this.config.environment }
                : {}),
        });
        const tracesUrl = getLangfuseTracesUrl(this.config.baseUrl);
        const authorization = createBasicAuthHeader(this.config.publicKey, this.config.secretKey);
        this.api.logger.info(`[LangfuseTrace] Using baseUrl=${normalizeBaseUrl(this.config.baseUrl)}, tracesUrl=${tracesUrl}, environment=${this.config.environment || "default"}`);
        const exporter = new OTLPTraceExporter({
            url: tracesUrl,
            headers: {
                Authorization: authorization,
            },
        });
        const provider = new BasicTracerProvider({ resource });
        provider.addSpanProcessor(new BatchSpanProcessor(exporter, {
            maxQueueSize: 100,
            maxExportBatchSize: this.config.batchSize || 10,
            scheduledDelayMillis: this.config.batchInterval || 5_000,
        }));
        this.provider = provider;
        this.tracer = provider.getTracer("openclaw-langfuse-trace", "0.1.0");
        this.initialized = true;
        this.api.logger.info("[LangfuseTrace] Exporter initialized");
    }
    async startSpan(spanData, spanId) {
        try {
            await this.ensureInitialized();
            this.doStartSpan(spanData, spanId);
        }
        catch (error) {
            this.api.logger.error(`[LangfuseTrace] Failed to start span: ${error}`);
        }
    }
    doStartSpan(spanData, spanId) {
        if (!this.tracer) {
            return;
        }
        const spanKind = this.getSpanKind(spanData.type);
        const isRoot = !spanData.parentSpanId;
        const isAgent = spanData.type === "agent";
        let parentContext;
        if (isRoot) {
            this.currentRootSpan = null;
            this.currentRootContext = null;
            this.currentAgentSpan = null;
            this.currentAgentContext = null;
            parentContext = context.active();
        }
        else if (isAgent) {
            parentContext = this.currentRootContext || context.active();
        }
        else {
            parentContext = this.currentAgentContext || this.currentRootContext || context.active();
        }
        const systemTagRuntime = JSON.stringify({
            language: "nodejs",
            library: "openclaw",
        });
        const span = this.tracer.startSpan(spanData.name, {
            kind: spanKind,
            startTime: spanData.startTime,
            attributes: {
                "openclaw.span_type": spanData.type,
                "openclaw.system_tag_runtime": systemTagRuntime,
                ...this.flattenAttributes(spanData.attributes),
            },
        }, parentContext);
        if (isRoot) {
            span.setAttribute("langfuse.trace.name", spanData.name);
            this.currentRootSpan = span;
            this.currentRootContext = trace.setSpan(context.active(), span);
            if (this.config.debug) {
                const spanContext = span.spanContext();
                this.api.logger.info(`[LangfuseTrace] Created ROOT span: name=${spanData.name}, traceId=${spanContext.traceId}, spanId=${spanContext.spanId}`);
            }
        }
        if (isAgent) {
            this.currentAgentSpan = span;
            this.currentAgentContext = trace.setSpan(this.currentRootContext || context.active(), span);
            if (this.config.debug) {
                const spanContext = span.spanContext();
                this.api.logger.info(`[LangfuseTrace] Created AGENT span: name=${spanData.name}, traceId=${spanContext.traceId}, spanId=${spanContext.spanId}`);
            }
        }
        this.setSpanInputOutput(span, spanData, isRoot);
        this.openSpans.set(spanId, span);
        if (this.config.debug && !isRoot && !isAgent) {
            const spanContext = span.spanContext();
            this.api.logger.info(`[LangfuseTrace] Started span: name=${spanData.name}, type=${spanData.type}, traceId=${spanContext.traceId}, spanId=${spanContext.spanId}`);
        }
    }
    endSpanById(spanId, endTime, additionalAttrs, output, input) {
        const span = this.openSpans.get(spanId);
        if (!span) {
            if (this.config.debug) {
                this.api.logger.info(`[LangfuseTrace] Span not found for ending: spanId=${spanId}`);
            }
            return;
        }
        if (additionalAttrs) {
            for (const [key, value] of Object.entries(additionalAttrs)) {
                if (value !== undefined && value !== null) {
                    span.setAttribute(key, value);
                }
            }
        }
        const isRootSpan = span === this.currentRootSpan;
        if (input !== undefined) {
            const inputString = serializeValue(input).substring(0, MAX_OBSERVATION_PAYLOAD_SIZE);
            span.setAttribute("langfuse.observation.input", inputString);
            if (isRootSpan) {
                span.setAttribute("langfuse.trace.input", inputString);
            }
        }
        if (output !== undefined) {
            const outputString = serializeValue(output).substring(0, MAX_OBSERVATION_PAYLOAD_SIZE);
            span.setAttribute("langfuse.observation.output", outputString);
            if (isRootSpan) {
                span.setAttribute("langfuse.trace.output", outputString);
            }
        }
        span.setStatus({ code: SpanStatusCode.OK });
        span.end(endTime || Date.now());
        this.openSpans.delete(spanId);
        if (this.config.debug) {
            const spanContext = span.spanContext();
            this.api.logger.info(`[LangfuseTrace] Ended span: spanId=${spanId}, traceId=${spanContext.traceId}`);
        }
    }
    async export(spanData) {
        await this.ensureInitialized();
        if (!this.tracer) {
            return;
        }
        const spanKind = this.getSpanKind(spanData.type);
        const isRoot = !spanData.parentSpanId;
        const isAgent = spanData.type === "agent";
        let parentContext;
        if (isRoot) {
            this.currentRootSpan = null;
            this.currentRootContext = null;
            parentContext = context.active();
        }
        else if (isAgent) {
            parentContext = this.currentRootContext || context.active();
        }
        else {
            parentContext = this.currentAgentContext || this.currentRootContext || context.active();
        }
        const systemTagRuntime = JSON.stringify({
            language: "nodejs",
            library: "openclaw",
        });
        const span = this.tracer.startSpan(spanData.name, {
            kind: spanKind,
            startTime: spanData.startTime,
            attributes: {
                "openclaw.span_type": spanData.type,
                "openclaw.system_tag_runtime": systemTagRuntime,
                ...this.flattenAttributes(spanData.attributes),
            },
        }, parentContext);
        if (isRoot) {
            span.setAttribute("langfuse.trace.name", spanData.name);
            this.currentRootSpan = span;
            this.currentRootContext = trace.setSpan(context.active(), span);
            if (this.config.debug) {
                const spanContext = span.spanContext();
                this.api.logger.info(`[LangfuseTrace] Created ROOT span: name=${spanData.name}, traceId=${spanContext.traceId}, spanId=${spanContext.spanId}`);
            }
        }
        this.setSpanInputOutput(span, spanData, isRoot);
        const hasError = spanData.attributes.error === true || spanData.attributes["tool.error"] === true;
        span.setStatus({ code: hasError ? SpanStatusCode.ERROR : SpanStatusCode.OK });
        span.end(spanData.endTime || Date.now());
        if (this.config.debug) {
            const spanContext = span.spanContext();
            this.api.logger.info(`[LangfuseTrace] Created span: name=${spanData.name}, type=${spanData.type}, traceId=${spanContext.traceId}, spanId=${spanContext.spanId}, isRoot=${isRoot}`);
        }
    }
    setSpanInputOutput(span, spanData, isRootSpan = false) {
        if (spanData.input !== undefined) {
            const inputString = serializeValue(spanData.input).substring(0, MAX_OBSERVATION_PAYLOAD_SIZE);
            span.setAttribute("langfuse.observation.input", inputString);
            if (isRootSpan) {
                span.setAttribute("langfuse.trace.input", inputString);
            }
        }
        if (spanData.output !== undefined) {
            const outputString = serializeValue(spanData.output).substring(0, MAX_OBSERVATION_PAYLOAD_SIZE);
            span.setAttribute("langfuse.observation.output", outputString);
            if (isRootSpan) {
                span.setAttribute("langfuse.trace.output", outputString);
            }
        }
    }
    endTrace() {
        this.currentRootSpan = null;
        this.currentRootContext = null;
        this.currentAgentSpan = null;
        this.currentAgentContext = null;
        this.openSpans.clear();
        if (this.config.debug) {
            this.api.logger.info("[LangfuseTrace] Trace ended, context cleared");
        }
    }
    getSpanKind(type) {
        switch (type) {
            case "entry":
            case "gateway":
                return SpanKind.SERVER;
            case "model":
            case "tool":
                return SpanKind.CLIENT;
            default:
                return SpanKind.INTERNAL;
        }
    }
    flattenAttributes(attributes) {
        const result = {};
        for (const [key, value] of Object.entries(attributes)) {
            if (value !== undefined && value !== null) {
                result[key] = value;
            }
        }
        return result;
    }
    async flush() {
        if (this.provider) {
            await this.provider.forceFlush();
        }
    }
    async dispose() {
        if (this.provider) {
            await this.provider.shutdown();
        }
    }
}
