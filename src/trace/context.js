import { LOG_PREFIX } from './types.js';
import { generateSpanId, generateTraceId } from './span.js';

const CONTEXT_TIMEOUT_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

export function createContextManager(pluginConfig, api) {
  const sessionMap = new Map();
  const conversationIdMap = new Map();
  const runIdMap = new Map();
  const toolCallMap = new Map();
  let cleanupInterval = null;

  function clearAllContextMaps() {
    sessionMap.clear();
    conversationIdMap.clear();
    runIdMap.clear();
    toolCallMap.clear();
  }

  function getValidValue(map, key, valueKey) {
    const record = map.get(key);

    if (!record) {
      return undefined;
    }

    if (record.expiresAt <= Date.now()) {
      map.delete(key);
      return undefined;
    }

    return record[valueKey];
  }

  function setExpiringValue(map, key, valueKey, value) {
    map.set(key, {
      [valueKey]: value,
      expiresAt: Date.now() + CONTEXT_TIMEOUT_MS,
    });
  }

  function getContextBySession(sessionKey) {
    return getValidValue(sessionMap, sessionKey, 'ctx');
  }

  function getContextByConversationId(conversationId) {
    return getValidValue(conversationIdMap, conversationId, 'ctx');
  }

  function getContextByRunId(runId) {
    return getValidValue(runIdMap, runId, 'ctx');
  }

  function setContextBySession(sessionKey, traceContext) {
    setExpiringValue(sessionMap, sessionKey, 'ctx', traceContext);
  }

  function setContextByConversationId(conversationId, traceContext) {
    setExpiringValue(conversationIdMap, conversationId, 'ctx', traceContext);
  }

  function setContextByRunId(runId, traceContext) {
    setExpiringValue(runIdMap, runId, 'ctx', traceContext);
  }

  function deleteContextBySession(sessionKey) {
    sessionMap.delete(sessionKey);
  }

  function deleteContextByConversationId(conversationId) {
    conversationIdMap.delete(conversationId);
  }

  function deleteContextByRunId(runId) {
    runIdMap.delete(runId);
  }

  function getToolCallInfo(toolCallId) {
    return getValidValue(toolCallMap, toolCallId, 'info');
  }

  function setToolCallInfo(toolCallId, info) {
    setExpiringValue(toolCallMap, toolCallId, 'info', info);
  }

  function deleteToolCallInfo(toolCallId) {
    toolCallMap.delete(toolCallId);
  }

  function createAPMContext(traceId = generateTraceId(), rootSpanId = generateSpanId()) {
    return {
      traceId,
      rootSpanId,
      rootSpanStartTime: Date.now(),
      allSessionMap: {},
    };
  }

  function createOrReuseContext(getter, setter, key, hookName, label) {
    let ctx = getter(key);
    let isNew = false;

    if (!ctx) {
      ctx = createAPMContext();
      setter(key, ctx);
      isNew = true;
      if (pluginConfig.debug) {
        api.logger?.info?.(`${LOG_PREFIX} NEW TraceContext by ${label}: ${key}, hook=${hookName}, traceId=${ctx.traceId}`);
      }
    } else if (pluginConfig.debug) {
      api.logger?.info?.(`${LOG_PREFIX} REUSE TraceContext by ${label}: ${key}, hook=${hookName}, traceId=${ctx.traceId}`);
    }

    return { ctx, isNew };
  }

  function getOrCreateContextBySession(sessionKey, hookName) {
    return createOrReuseContext(
      getContextBySession,
      setContextBySession,
      sessionKey,
      hookName,
      'sessionId',
    );
  }

  function getOrCreateContextByConversation(conversationId, hookName) {
    return createOrReuseContext(
      getContextByConversationId,
      setContextByConversationId,
      conversationId,
      hookName,
      'conversationId',
    );
  }

  function getOrCreateContextByRunId(runId, hookName) {
    return createOrReuseContext(
      getContextByRunId,
      setContextByRunId,
      runId,
      hookName,
      'runId',
    );
  }

  function cleanupExpiredContexts() {
    const now = Date.now();
    const sweepTargets = [
      [sessionMap, 'sessionId', 'ctx'],
      [conversationIdMap, 'conversationId', 'ctx'],
      [runIdMap, 'runId', 'ctx'],
      [toolCallMap, 'toolCallId', 'info'],
    ];

    for (const [map, label, valueKey] of sweepTargets) {
      for (const [key, record] of map.entries()) {
        if (record.expiresAt > now) {
          continue;
        }

        if (pluginConfig.debug) {
          const traceId = record[valueKey]?.traceId;
          api.logger?.warn?.(`${LOG_PREFIX} Context timeout, cleaning up: ${label}=${key}, traceId=${traceId}`);
        }

        map.delete(key);
      }
    }
  }

  function startCleanupInterval() {
    if (cleanupInterval) {
      return;
    }

    cleanupInterval = setInterval(cleanupExpiredContexts, CLEANUP_INTERVAL_MS);
    cleanupInterval.unref?.();

    if (pluginConfig.debug) {
      api.logger?.info?.(
        `${LOG_PREFIX} Started context cleanup interval (check every ${CLEANUP_INTERVAL_MS / 1000}s, timeout after ${CONTEXT_TIMEOUT_MS / 1000}s)`,
      );
    }
  }

  function stopCleanupInterval() {
    if (!cleanupInterval) {
      return;
    }

    clearInterval(cleanupInterval);
    cleanupInterval = null;

    if (pluginConfig.debug) {
      api.logger?.info?.(`${LOG_PREFIX} Stopped context cleanup interval`);
    }
  }

  return {
    getContextBySession,
    getContextByConversationId,
    getContextByRunId,
    setContextBySession,
    setContextByConversationId,
    setContextByRunId,
    deleteContextBySession,
    deleteContextByConversationId,
    deleteContextByRunId,
    getToolCallInfo,
    setToolCallInfo,
    deleteToolCallInfo,
    getOrCreateContextBySession,
    getOrCreateContextByConversation,
    getOrCreateContextByRunId,
    startCleanupInterval,
    stopCleanupInterval,
    createAPMContext,
    cleanAllContextMaps: clearAllContextMaps,
  };
}
