import { randomBytes } from 'crypto';
import { context, trace, SpanKind } from '@opentelemetry/api';
import { ATTR_INPUT, ATTR_OUTPUT, ATTR_SPAN_TYPE, ATTR_SYSTEM_TAG, LOG_PREFIX, MAX_ATTR_LENGTH, } from './types.js';
const SPAN_TIMEOUT_MS = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 30 * 1000;
export function generateSpanId() {
    return randomBytes(8).toString('hex');
}
export function generateTraceId() {
    return randomBytes(16).toString('hex');
}
export function serializeForAttr(value) {
    const serialized = typeof value === 'string'
        ? value
        : JSON.stringify(value) ?? String(value);
    return serialized.substring(0, MAX_ATTR_LENGTH);
}
export function flattenAttributes(attributes, prefix = '') {
    const flattened = {};
    for (const [key, value] of Object.entries(attributes || {})) {
        if (value === undefined) {
            continue;
        }
        const nextKey = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            Object.assign(flattened, flattenAttributes(value, nextKey));
        }
        else {
            flattened[nextKey] = value;
        }
    }
    return flattened;
}
export function resolveUserId(sessionKey, conversationId, channelId) {
    if (channelId === 'webchat') {
        return channelId;
    }
    if (conversationId) {
        return conversationId;
    }
    if (sessionKey?.includes(':subagent:')) {
        return sessionKey.split(':subagent:')[0];
    }
    return 'unknown';
}
export function getSpanKind(type) {
    switch (type) {
        case 'entry':
        case 'gateway':
            return SpanKind.SERVER;
        case 'model':
        case 'tool':
            return SpanKind.CLIENT;
        default:
            return SpanKind.INTERNAL;
    }
}
export function createSpanData(name, type, startTime, endTime, attributes = {}, rootSpanOrNot) {
    return {
        name,
        type,
        startTime,
        endTime,
        attributes,
        rootSpanOrNot,
    };
}
function normalizeAttributeValue(value) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.filter(item => ['string', 'number', 'boolean'].includes(typeof item));
    }
    return serializeForAttr(value);
}
export function createSpanOperations(tracer, openSpans, pluginConfig, api) {
    const spanStartTimes = new Map();
    let cleanupInterval = null;
    function cleanupExpiredSpans() {
        const now = Date.now();
        const expiredSpanIds = [];
        for (const [spanId, startTime] of spanStartTimes.entries()) {
            if (now - startTime > SPAN_TIMEOUT_MS) {
                expiredSpanIds.push(spanId);
            }
        }
        for (const spanId of expiredSpanIds) {
            const span = openSpans.get(spanId);
            if (span) {
                const spanContext = span.spanContext();
                api.logger?.warn?.(`${LOG_PREFIX} Span timeout, cleaning up without export: spanId=${spanId}, trace=${spanContext.traceId}`);
            }
            openSpans.delete(spanId);
            spanStartTimes.delete(spanId);
        }
    }
    function startCleanupInterval() {
        if (cleanupInterval) {
            return;
        }
        cleanupInterval = setInterval(cleanupExpiredSpans, CLEANUP_INTERVAL_MS);
        cleanupInterval.unref?.();
        if (pluginConfig.debug) {
            api.logger?.info?.(`${LOG_PREFIX} Started span cleanup interval (check every ${CLEANUP_INTERVAL_MS / 1000}s, timeout after ${SPAN_TIMEOUT_MS / 1000}s)`);
        }
    }
    function stopCleanupInterval() {
        if (!cleanupInterval) {
            return;
        }
        clearInterval(cleanupInterval);
        cleanupInterval = null;
        if (pluginConfig.debug) {
            api.logger?.info?.(`${LOG_PREFIX} Stopped span cleanup interval`);
        }
    }
    function startSpan(spanData) {
        let parentContext = context.active();
        if (spanData.rootSpanOrNot !== 'rootSpan') {
            parentContext = trace.setSpanContext(context.active(), {
                traceId: spanData.rootSpanOrNot.traceId,
                spanId: spanData.rootSpanOrNot.parentSpanId,
                traceFlags: 0x1,
            });
            const parentSpan = openSpans.get(spanData.rootSpanOrNot.parentSpanId);
            if (parentSpan) {
                parentContext = trace.setSpan(context.active(), parentSpan);
            }
        }
        const { [ATTR_INPUT]: input, [ATTR_OUTPUT]: output, ...flatAttributes } = spanData.attributes || {};
        const normalizedAttributes = Object.fromEntries(Object.entries(flattenAttributes(flatAttributes)).map(([key, value]) => [
            key,
            normalizeAttributeValue(value),
        ]));
        const span = tracer.startSpan(spanData.name, {
            kind: getSpanKind(spanData.type),
            startTime: spanData.startTime,
            attributes: {
                [ATTR_SPAN_TYPE]: spanData.type,
                [ATTR_SYSTEM_TAG]: JSON.stringify({
                    library: 'openclaw-langfuse-plugin',
                    language: 'nodejs',
                }),
                ...normalizedAttributes,
            },
        }, parentContext);
        if (input !== undefined) {
            span.setAttribute(ATTR_INPUT, serializeForAttr(input));
        }
        if (output !== undefined) {
            span.setAttribute(ATTR_OUTPUT, serializeForAttr(output));
        }
        const spanContext = span.spanContext();
        openSpans.set(spanContext.spanId, span);
        spanStartTimes.set(spanContext.spanId, spanData.startTime);
        return {
            traceId: spanContext.traceId,
            spanId: spanContext.spanId,
        };
    }
    function endSpan(spanId, endTime, attributes) {
        const span = openSpans.get(spanId);
        if (!span) {
            if (pluginConfig.debug) {
                api.logger?.info?.(`${LOG_PREFIX} Span not found for ending: spanId=${spanId}`);
            }
            return;
        }
        for (const [key, value] of Object.entries(attributes || {})) {
            if (value === undefined || value === null) {
                continue;
            }
            if (key === ATTR_INPUT) {
                span.setAttribute(ATTR_INPUT, serializeForAttr(value));
            }
            else if (key === ATTR_OUTPUT) {
                span.setAttribute(ATTR_OUTPUT, serializeForAttr(value));
            }
            else {
                span.setAttribute(key, normalizeAttributeValue(value));
            }
        }
        span.end(endTime);
        openSpans.delete(spanId);
        spanStartTimes.delete(spanId);
    }
    function exportSpan(spanData) {
        const endTime = spanData.endTime ?? Date.now();
        const { spanId, traceId } = startSpan(spanData);
        endSpan(spanId, endTime, spanData.attributes);
        return {
            traceId,
            spanId,
        };
    }
    return {
        startSpan,
        endSpan,
        exportSpan,
        startCleanupInterval,
        stopCleanupInterval,
    };
}
