import { trace } from '@opentelemetry/api';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { hostname } from 'os';
import { createTraceHelpers } from './trace/index.js';
import { createDiagnosticsOtelService } from './openclawNative/service.js';
import {
  GEN_AI_INPUT,
  GEN_AI_OUTPUT,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_SESSION_ID,
  GEN_AI_SPAN_KIND,
  GEN_AI_SYSTEM,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_TOTAL_TOKENS,
  GEN_AI_USER_ID,
  GenAiSpanKind,
  getGenAiCompletionContent,
  getGenAiCompletionRole,
  getGenAiPromptContent,
  getGenAiPromptRole,
} from './utils/genaiConst.js';
import {
  LANGFUSE_AS_ROOT,
  LANGFUSE_ENVIRONMENT,
  LANGFUSE_OBSERVATION_INPUT,
  LANGFUSE_OBSERVATION_METADATA,
  LANGFUSE_OBSERVATION_MODEL,
  LANGFUSE_OBSERVATION_OUTPUT,
  LANGFUSE_OBSERVATION_STATUS_MESSAGE,
  LANGFUSE_OBSERVATION_TYPE,
  LANGFUSE_OBSERVATION_USAGE_DETAILS,
  LANGFUSE_RELEASE,
  LANGFUSE_SESSION_ID,
  LANGFUSE_SESSION_ID_COMPAT,
  LANGFUSE_TRACE_INPUT,
  LANGFUSE_TRACE_METADATA,
  LANGFUSE_TRACE_NAME,
  LANGFUSE_TRACE_OUTPUT,
  LANGFUSE_USER_ID,
  LANGFUSE_USER_ID_COMPAT,
  LangfuseObservationType,
} from './utils/langfuseConst.js';
import { LOG_PREFIX } from './trace/types.js';
import { resolveUserId } from './trace/span.js';
import { PLUGIN_VERSION } from './version.js';

const ROOT_END_DELAY_MS = 1000;
const AGENT_END_DELAY_MS = 300;

function joinUrl(baseUrl, suffix) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}${suffix}`;
}

function buildBasicAuthHeader(publicKey, secretKey) {
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;
}

function safeJson(value) {
  if (value === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function isNonEmptyObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function sanitizeObject(value) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    return value
      .map(item => sanitizeObject(item))
      .filter(item => item !== undefined);
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entryValue]) => [key, sanitizeObject(entryValue)])
        .filter(([, entryValue]) => entryValue !== undefined),
    );
  }

  return value;
}

function normalizeContent(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === 'string') {
          return item;
        }

        if (item?.type === 'text') {
          return item.text ?? '';
        }

        return safeJson(item);
      })
      .filter(Boolean)
      .join('\n');
  }

  return safeJson(value);
}

function createUsageDetails(usage) {
  if (!usage) {
    return undefined;
  }

  const normalized = {};

  if (usage.input !== undefined) {
    normalized.input = usage.input;
  }

  if (usage.output !== undefined) {
    normalized.output = usage.output;
  }

  if (usage.total !== undefined) {
    normalized.total = usage.total;
  }

  if (usage.cacheRead !== undefined) {
    normalized.cache_read = usage.cacheRead;
  }

  if (usage.cacheWrite !== undefined) {
    normalized.cache_write = usage.cacheWrite;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function createTraceAttributes({
  name,
  input,
  output,
  userId,
  sessionId,
  metadata,
  environment,
}) {
  const attributes = {
    [LANGFUSE_TRACE_NAME]: name,
    [LANGFUSE_AS_ROOT]: true,
    [LANGFUSE_ENVIRONMENT]: environment,
    [LANGFUSE_RELEASE]: PLUGIN_VERSION,
  };

  if (input !== undefined) {
    attributes[LANGFUSE_TRACE_INPUT] = input;
  }

  if (output !== undefined) {
    attributes[LANGFUSE_TRACE_OUTPUT] = output;
  }

  if (userId) {
    attributes[LANGFUSE_USER_ID] = userId;
    attributes[LANGFUSE_USER_ID_COMPAT] = userId;
  }

  if (sessionId) {
    attributes[LANGFUSE_SESSION_ID] = sessionId;
    attributes[LANGFUSE_SESSION_ID_COMPAT] = sessionId;
  }

  if (isNonEmptyObject(metadata)) {
    attributes[LANGFUSE_TRACE_METADATA] = sanitizeObject(metadata);
  }

  return attributes;
}

function createObservationAttributes({
  type,
  input,
  output,
  model,
  metadata,
  usageDetails,
  statusMessage,
}) {
  const attributes = {
    [LANGFUSE_OBSERVATION_TYPE]: type,
  };

  if (input !== undefined) {
    attributes[LANGFUSE_OBSERVATION_INPUT] = input;
  }

  if (output !== undefined) {
    attributes[LANGFUSE_OBSERVATION_OUTPUT] = output;
  }

  if (model) {
    attributes[LANGFUSE_OBSERVATION_MODEL] = model;
  }

  if (isNonEmptyObject(metadata)) {
    attributes[LANGFUSE_OBSERVATION_METADATA] = sanitizeObject(metadata);
  }

  if (usageDetails) {
    attributes[LANGFUSE_OBSERVATION_USAGE_DETAILS] = usageDetails;
  }

  if (statusMessage) {
    attributes[LANGFUSE_OBSERVATION_STATUS_MESSAGE] = statusMessage;
  }

  return attributes;
}

function parseCronSessionKey(sessionKey) {
  if (typeof sessionKey !== 'string') {
    return null;
  }

  const trimmed = sessionKey.trim();
  if (!trimmed) {
    return null;
  }

  const runMarker = ':run:';
  const runMarkerIndex = trimmed.indexOf(runMarker);
  const baseSessionKey = runMarkerIndex >= 0 ? trimmed.slice(0, runMarkerIndex) : trimmed;
  const runSessionId =
    runMarkerIndex >= 0 ? trimmed.slice(runMarkerIndex + runMarker.length).trim() : undefined;
  const cronMarker = baseSessionKey.startsWith('cron:') ? 'cron:' : ':cron:';
  const cronIndex = baseSessionKey.indexOf(cronMarker);

  if (cronIndex < 0) {
    return null;
  }

  const jobIdStart = cronIndex + cronMarker.length;
  const jobId = baseSessionKey.slice(jobIdStart).trim();

  if (!jobId) {
    return null;
  }

  return {
    sessionKey: trimmed,
    baseSessionKey,
    jobId,
    runSessionId: runSessionId || undefined,
    isRunSession: Boolean(runSessionId),
  };
}

function resolveCronContext({ sessionKey, trigger }) {
  const parsed = parseCronSessionKey(sessionKey);

  if (parsed) {
    return parsed;
  }

  if (trigger === 'cron') {
    return {
      sessionKey,
      baseSessionKey: sessionKey,
      jobId: undefined,
      runSessionId: undefined,
      isRunSession: false,
    };
  }

  return null;
}

function createCronMetadata(cronContext) {
  if (!cronContext) {
    return undefined;
  }

  const metadata = {
    runKind: 'cron',
    isRunSession: cronContext.isRunSession,
  };

  if (cronContext.jobId) {
    metadata.jobId = cronContext.jobId;
  }

  if (cronContext.sessionKey) {
    metadata.sessionKey = cronContext.sessionKey;
  }

  if (cronContext.baseSessionKey) {
    metadata.baseSessionKey = cronContext.baseSessionKey;
  }

  if (cronContext.runSessionId) {
    metadata.runSessionId = cronContext.runSessionId;
  }

  return metadata;
}

function createCronAttributes(cronContext) {
  if (!cronContext) {
    return {};
  }

  const attributes = {
    'openclaw.run_kind': 'cron',
    'openclaw.cron.is_run_session': cronContext.isRunSession,
  };

  if (cronContext.jobId) {
    attributes['openclaw.cron.job_id'] = cronContext.jobId;
  }

  if (cronContext.sessionKey) {
    attributes['openclaw.cron.session_key'] = cronContext.sessionKey;
  }

  if (cronContext.baseSessionKey) {
    attributes['openclaw.cron.base_session_key'] = cronContext.baseSessionKey;
  }

  if (cronContext.runSessionId) {
    attributes['openclaw.cron.run_session_id'] = cronContext.runSessionId;
  }

  return attributes;
}

function getRequestUserId(sessionKey, conversationId, channelId) {
  return resolveUserId(sessionKey, conversationId, channelId);
}

function buildPromptHistory(event) {
  const prompts = [];

  if (event.systemPrompt) {
    prompts.push({ role: 'system', content: event.systemPrompt });
  }

  if (Array.isArray(event.historyMessages) && event.historyMessages.length > 0) {
    prompts.push(...event.historyMessages.slice(-20));
  }

  if (event.prompt) {
    prompts.push({ role: 'user', content: event.prompt });
  }

  return prompts;
}

function withDetailedAttributes(enabled, attributes) {
  return enabled ? attributes : {};
}

function resolveTraceExporterConfig(pluginConfig, logger) {
  if (pluginConfig.langfuseBaseUrl && pluginConfig.langfusePublicKey && pluginConfig.langfuseSecretKey) {
    return {
      url: joinUrl(pluginConfig.langfuseBaseUrl, '/api/public/otel/v1/traces'),
      headers: {
        Authorization: buildBasicAuthHeader(
          pluginConfig.langfusePublicKey,
          pluginConfig.langfuseSecretKey,
        ),
        ...(pluginConfig.headers || {}),
      },
      mode: 'langfuse',
    };
  }

  if (pluginConfig.endpoint) {
    logger?.warn?.(
      `${LOG_PREFIX} pluginConfig.endpoint is deprecated. Prefer langfuseBaseUrl/langfusePublicKey/langfuseSecretKey.`,
    );

    return {
      url: pluginConfig.endpoint,
      headers: pluginConfig.headers || {},
      mode: 'legacy-endpoint',
    };
  }

  return null;
}

function createSessionState(traceContext, sessionKey) {
  if (!traceContext.allSessionMap[sessionKey]) {
    traceContext.allSessionMap[sessionKey] = {
      totalSessionAncestorSpanId: traceContext.rootSpanId,
    };
  }

  return traceContext.allSessionMap[sessionKey];
}

function collectContextKeys(traceContext) {
  return {
    sessionKeys: Object.keys(traceContext.allSessionMap || {}),
    runIds: Array.from(traceContext.runIds || []),
    toolCallIds: Array.from(traceContext.toolCallIds || []),
  };
}

const langfuseOpenClawPlugin = {
  id: 'openclaw-langfuse-trace',
  name: 'Langfuse OpenClaw Observability Plugin',
  version: PLUGIN_VERSION,
  description: 'Report OpenClaw traces to Langfuse via OpenTelemetry',
  register(api) {
    const pluginConfig = api.pluginConfig || {};
    const exporterConfig = resolveTraceExporterConfig(pluginConfig, api.logger);

    if (!exporterConfig) {
      api.logger?.warn?.(
        `${LOG_PREFIX} Missing Langfuse configuration. Set langfuseBaseUrl/langfusePublicKey/langfuseSecretKey.`,
      );
      return;
    }

    const debugEnabled = pluginConfig.debug === true;
    const allowDetailedReport = pluginConfig.allowUserDetailInfoReport !== false;
    const environment = pluginConfig.environment || process.env.LANGFUSE_TRACING_ENVIRONMENT || 'default';
    const serviceName = pluginConfig.serviceName || process.env.OTEL_SERVICE_NAME || 'openclaw';
    const serviceInstanceId = `${serviceName}@${hostname()}:${process.pid}`;
    const openSpans = new Map();
    let lastUserTraceContext;

    const logDebug = message => {
      if (debugEnabled) {
        api.logger?.info?.(`${LOG_PREFIX} ${message}`);
      }
    };

    const resource = resourceFromAttributes({
      'service.name': serviceName,
      'service.instance.id': serviceInstanceId,
      'host.name': hostname(),
      'api.version': api.version,
      [GEN_AI_SYSTEM]: 'openclaw',
      [LANGFUSE_ENVIRONMENT]: environment,
      [LANGFUSE_RELEASE]: PLUGIN_VERSION,
      ...(pluginConfig.extraResourceAttributes || {}),
    });

    const tracerProvider = new NodeTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter(exporterConfig))],
    });

    tracerProvider.register();

    const tracer = trace.getTracer('openclaw-langfuse-plugin', PLUGIN_VERSION);
    const traceHelpers = createTraceHelpers({
      tracer,
      openSpans,
      pluginConfig,
      api,
      tracerProvider,
    });

    const {
      startSpan,
      endSpan,
      exportSpan,
      flush,
      getContextBySession,
      getContextByConversationId,
      getContextByRunId,
      getToolCallInfo,
      setContextBySession,
      setContextByConversationId,
      setContextByRunId,
      setToolCallInfo,
      deleteContextBySession,
      deleteContextByConversationId,
      deleteContextByRunId,
      deleteToolCallInfo,
      createSpanData,
      startCleanupInterval,
      stopCleanupInterval,
      startContextCleanupInterval,
      stopContextCleanupInterval,
      createAPMContext,
      cleanAllContextMaps,
    } = traceHelpers;

    function rememberRunId(traceContext, runId) {
      if (!runId) {
        return;
      }

      traceContext.runIds ??= new Set();
      traceContext.runIds.add(runId);
      setContextByRunId(runId, traceContext);
    }

    function rememberToolCallId(traceContext, toolCallId) {
      if (!toolCallId) {
        return;
      }

      traceContext.toolCallIds ??= new Set();
      traceContext.toolCallIds.add(toolCallId);
    }

    function cleanupTraceContext(traceContext) {
      if (!traceContext) {
        return;
      }

      if (traceContext.currentMessageSendEndTimer) {
        clearTimeout(traceContext.currentMessageSendEndTimer);
        traceContext.currentMessageSendEndTimer = undefined;
      }

      if (traceContext.conversationId) {
        deleteContextByConversationId(traceContext.conversationId);
      }

      const { sessionKeys, runIds, toolCallIds } = collectContextKeys(traceContext);

      for (const sessionKey of sessionKeys) {
        deleteContextBySession(sessionKey);
      }

      for (const runId of runIds) {
        deleteContextByRunId(runId);
      }

      for (const toolCallId of toolCallIds) {
        deleteToolCallInfo(toolCallId);
      }

      traceContext.allSessionMap = {};

      if (lastUserTraceContext === traceContext) {
        lastUserTraceContext = undefined;
      }
    }

    function maybeEndRootSpan(traceContext, endTime = Date.now()) {
      if (!traceContext) {
        return false;
      }

      const hasActiveAgent = Object.values(traceContext.allSessionMap || {}).some(
        sessionState => Boolean(sessionState?.currentAgent),
      );

      if (hasActiveAgent) {
        logDebug('Skipping root span end because an agent is still active');
        return false;
      }

      if (!openSpans.has(traceContext.rootSpanId)) {
        cleanupTraceContext(traceContext);
        return false;
      }

      const cronContext = traceContext.cronContext;
      endSpan(traceContext.rootSpanId, endTime, {
        'request.duration_ms': endTime - traceContext.rootSpanStartTime,
        [LANGFUSE_TRACE_INPUT]: traceContext.initialInput,
        [LANGFUSE_TRACE_OUTPUT]: traceContext.finalOutput,
        [LANGFUSE_TRACE_METADATA]: {
          conversationId: traceContext.conversationId,
          channelId: traceContext.channelId,
          eventFrom: traceContext.eventFrom,
          ...(createCronMetadata(cronContext) ? { cron: createCronMetadata(cronContext) } : {}),
        },
        ...createCronAttributes(cronContext),
        ...withDetailedAttributes(allowDetailedReport, {
          [GEN_AI_INPUT]: traceContext.initialInput,
          [GEN_AI_OUTPUT]: traceContext.finalOutput,
        }),
      });

      cleanupTraceContext(traceContext);
      void flush();
      return true;
    }

    function scheduleRootSpanEnd(traceContext, endTime) {
      if (!traceContext) {
        return;
      }

      if (traceContext.currentMessageSendEndTimer) {
        clearTimeout(traceContext.currentMessageSendEndTimer);
      }

      traceContext.currentMessageSendEndTimer = setTimeout(() => {
        maybeEndRootSpan(traceContext, endTime);
      }, ROOT_END_DELAY_MS);
      traceContext.currentMessageSendEndTimer.unref?.();
    }

    function createRootRequestContext({
      now,
      traceName = 'openclaw_request',
      sessionKey,
      sessionId,
      conversationId,
      channelId,
      input,
      eventFrom,
      metadata = {},
    }) {
      const userId = getRequestUserId(sessionKey, conversationId, channelId);
      const cronContext = resolveCronContext({ sessionKey, trigger: eventFrom });
      const rootAttributes = {
        ...createTraceAttributes({
          name: traceName,
          input,
          userId,
          sessionId,
          metadata: {
            ...metadata,
            conversationId,
            channelId,
            eventFrom,
            ...(createCronMetadata(cronContext) ? { cron: createCronMetadata(cronContext) } : {}),
          },
          environment,
        }),
        ...createObservationAttributes({
          type: LangfuseObservationType.SPAN,
          input,
          metadata: {
            traceName,
            ...(createCronMetadata(cronContext) ? { cron: createCronMetadata(cronContext) } : {}),
          },
        }),
        [GEN_AI_SPAN_KIND]: GenAiSpanKind.Root,
        [GEN_AI_SYSTEM]: 'openclaw',
        ...createCronAttributes(cronContext),
        ...withDetailedAttributes(allowDetailedReport, {
          [GEN_AI_INPUT]: input,
          'conversation.id': conversationId,
          'channel.id': channelId,
          'session.key': sessionKey,
          'event.from': eventFrom,
        }),
      };

      const { traceId, spanId } = startSpan(
        createSpanData(traceName, 'entry', now, undefined, rootAttributes, 'rootSpan'),
      );

      const traceContext = createAPMContext(traceId, spanId);
      traceContext.rootSpanStartTime = now;
      traceContext.initialInput = input;
      traceContext.conversationId = conversationId;
      traceContext.channelId = channelId;
      traceContext.eventFrom = eventFrom;
      traceContext.cronContext = cronContext ?? traceContext.cronContext;

      if (sessionKey) {
        setContextBySession(sessionKey, traceContext);
      }

      if (conversationId) {
        setContextByConversationId(conversationId, traceContext);
      }

      lastUserTraceContext = traceContext;

      logDebug(`Started root request span: traceId=${traceId}, spanId=${spanId}`);
      return traceContext;
    }

    function ensureTraceContext({
      sessionKey,
      sessionId,
      conversationId,
      channelId,
      input,
      eventFrom,
      traceName,
      metadata,
    }) {
      let traceContext =
        (sessionKey && getContextBySession(sessionKey)) ||
        (conversationId && getContextByConversationId(conversationId)) ||
        lastUserTraceContext;

      if (!traceContext) {
        traceContext = createRootRequestContext({
          now: Date.now(),
          traceName,
          sessionKey,
          sessionId,
          conversationId,
          channelId,
          input,
          eventFrom,
          metadata,
        });
      }

      if (sessionKey) {
        setContextBySession(sessionKey, traceContext);
      }

      if (conversationId) {
        setContextByConversationId(conversationId, traceContext);
      }

      traceContext.conversationId ??= conversationId;
      traceContext.channelId ??= channelId;
      traceContext.initialInput ??= input;
      traceContext.eventFrom ??= eventFrom;
      traceContext.cronContext ??= resolveCronContext({ sessionKey, trigger: eventFrom });

      return traceContext;
    }

    function ensureLiveTraceContext({
      traceName = 'openclaw_request',
      sessionKey,
      sessionId,
      conversationId,
      channelId,
      runId,
      input,
      eventFrom,
      metadata = {},
    }) {
      let traceContext =
        (runId && getContextByRunId(runId)) ||
        (sessionKey && getContextBySession(sessionKey)) ||
        (conversationId && getContextByConversationId(conversationId)) ||
        lastUserTraceContext;

      if (!traceContext || !openSpans.has(traceContext.rootSpanId)) {
        traceContext = createRootRequestContext({
          now: Date.now(),
          traceName,
          sessionKey,
          sessionId,
          conversationId,
          channelId,
          input,
          eventFrom,
          metadata,
        });
      }

      if (sessionKey) {
        setContextBySession(sessionKey, traceContext);
      }

      if (conversationId) {
        setContextByConversationId(conversationId, traceContext);
      }

      if (runId) {
        rememberRunId(traceContext, runId);
      }

      traceContext.conversationId ??= conversationId;
      traceContext.channelId ??= channelId;

      if (input !== undefined && traceContext.initialInput === undefined) {
        traceContext.initialInput = input;
      }

      if (eventFrom !== undefined && traceContext.eventFrom === undefined) {
        traceContext.eventFrom = eventFrom;
      }

      traceContext.cronContext ??= resolveCronContext({ sessionKey, trigger: eventFrom });

      return traceContext;
    }

    function exportChildSpan({
      name,
      type,
      startTime = Date.now(),
      endTime = startTime,
      parentTraceId,
      parentSpanId,
      attributes,
    }) {
      return exportSpan(
        createSpanData(name, type, startTime, endTime, attributes, {
          traceId: parentTraceId,
          parentSpanId,
        }),
      );
    }

    if (pluginConfig.openclawNativeMetrics !== false && typeof api.registerService === 'function') {
      api.registerService(createDiagnosticsOtelService(pluginConfig));
    }

    startCleanupInterval();
    startContextCleanupInterval();

    api.logger?.info?.(
      `${LOG_PREFIX} Initialized. exporter=${exporterConfig.mode}, url=${exporterConfig.url}`,
    );

    api.on('gateway_start', async event => {
      const now = Date.now();
      exportSpan(
        createSpanData(
          'gateway_start',
          'gateway',
          now,
          now,
          {
            ...createTraceAttributes({
              name: 'gateway_start',
              metadata: { port: event.port },
              environment,
            }),
            ...createObservationAttributes({
              type: LangfuseObservationType.SPAN,
              metadata: { port: event.port },
            }),
            'gateway.port': event.port,
          },
          'rootSpan',
        ),
      );
    });

    api.on('gateway_stop', async (event, runtimeContext) => {
      const now = Date.now();

      exportSpan(
        createSpanData(
          'gateway_stop',
          'gateway',
          now,
          now,
          {
            ...createTraceAttributes({
              name: 'gateway_stop',
              metadata: { port: runtimeContext.port, reason: event.reason },
              environment,
            }),
            ...createObservationAttributes({
              type: LangfuseObservationType.SPAN,
              statusMessage: event.reason,
            }),
            'gateway.port': runtimeContext.port,
            'gateway.stop_reason': event.reason,
          },
          'rootSpan',
        ),
      );

      stopCleanupInterval();
      stopContextCleanupInterval();

      if (lastUserTraceContext) {
        maybeEndRootSpan(lastUserTraceContext, now);
      }

      cleanAllContextMaps();
      openSpans.clear();
      await tracerProvider.shutdown();
    });

    api.on('session_start', async (event, runtimeContext) => {
      const sessionKey = event.sessionKey ?? event.sessionId;
      const existingContext = sessionKey ? getContextBySession(sessionKey) : lastUserTraceContext;
      const now = Date.now();
      const cronContext =
        existingContext?.cronContext ??
        resolveCronContext({ sessionKey, trigger: runtimeContext.trigger });

      exportSpan(
        createSpanData(
          'session_start',
          'entry',
          now,
          now,
          {
            ...createObservationAttributes({
              type: LangfuseObservationType.SPAN,
              metadata: {
                resumedFrom: event.resumedFrom,
                ...(createCronMetadata(cronContext) ? { cron: createCronMetadata(cronContext) } : {}),
              },
            }),
            ...createCronAttributes(cronContext),
            ...withDetailedAttributes(allowDetailedReport, {
              [GEN_AI_SESSION_ID]: event.sessionId,
              'session.key': event.sessionKey,
              'session.resumed_from': event.resumedFrom,
              'session.agent_id': runtimeContext.agentId,
            }),
          },
          existingContext
            ? { traceId: existingContext.traceId, parentSpanId: existingContext.rootSpanId }
            : 'rootSpan',
        ),
      );
    });

    api.on('session_end', async (event, runtimeContext) => {
      const sessionKey = event.sessionKey ?? event.sessionId;
      let traceContext = sessionKey ? getContextBySession(sessionKey) : lastUserTraceContext;
      const now = Date.now();
      const cronContext =
        traceContext?.cronContext ??
        resolveCronContext({ sessionKey, trigger: runtimeContext.trigger });

      const exported = exportSpan(
        createSpanData(
          'session_end',
          'entry',
          now,
          now,
          {
            ...createObservationAttributes({
              type: LangfuseObservationType.SPAN,
              metadata: {
                durationMs: event.durationMs,
                messageCount: event.messageCount,
                ...(createCronMetadata(cronContext) ? { cron: createCronMetadata(cronContext) } : {}),
              },
            }),
            ...createCronAttributes(cronContext),
            ...withDetailedAttributes(allowDetailedReport, {
              [GEN_AI_SESSION_ID]: event.sessionId,
              'session.key': event.sessionKey,
              'session.agent_id': runtimeContext.agentId,
              'session.duration_ms': event.durationMs ?? 0,
              'session.message_count': event.messageCount ?? 0,
            }),
          },
          traceContext
            ? { traceId: traceContext.traceId, parentSpanId: traceContext.rootSpanId }
            : 'rootSpan',
        ),
      );

      if (!traceContext && sessionKey) {
        traceContext = createAPMContext(exported.traceId, exported.spanId);
        setContextBySession(sessionKey, traceContext);
      }
    });

    api.on('message_received', async (event, runtimeContext) => {
      const now = Date.now();
      const conversationId = runtimeContext.conversationId ?? event.from;
      const existingContext = conversationId ? getContextByConversationId(conversationId) : undefined;

      if (existingContext) {
        maybeEndRootSpan(existingContext, now);
      }

      const traceContext = createRootRequestContext({
        now,
        traceName: 'openclaw_request',
        conversationId,
        channelId: runtimeContext.channelId,
        input: event.content,
        eventFrom: event.from,
        metadata: {
          source: 'message_received',
        },
      });

      exportChildSpan({
        name: 'message_received',
        type: 'message',
        startTime: now,
        endTime: now,
        parentTraceId: traceContext.traceId,
        parentSpanId: traceContext.rootSpanId,
        attributes: {
          ...createObservationAttributes({
            type: LangfuseObservationType.SPAN,
            input: event.content,
            metadata: {
              from: event.from,
              conversationId: runtimeContext.conversationId,
              channelId: runtimeContext.channelId,
            },
          }),
          ...withDetailedAttributes(allowDetailedReport, {
            'message.from': event.from,
            'event.content': event.content,
            'conversation.id': runtimeContext.conversationId,
            'channel.id': runtimeContext.channelId,
          }),
        },
      });
    });

    api.on('message_sending', async (event, runtimeContext) => {
      const now = Date.now();
      const conversationId = runtimeContext.conversationId ?? event.to;
      const traceContext = ensureLiveTraceContext({
        traceName: 'openclaw_request',
        conversationId,
        channelId: runtimeContext.channelId,
        input: event.content,
        eventFrom: event.to,
        metadata: { source: 'message_sending' },
      });

      traceContext.conversationId ??= runtimeContext.conversationId ?? conversationId;
      traceContext.channelId ??= runtimeContext.channelId;

      if (traceContext.currentMessageSendEndTimer) {
        clearTimeout(traceContext.currentMessageSendEndTimer);
        traceContext.currentMessageSendEndTimer = undefined;
      }

      const { spanId } = startSpan(
        createSpanData(
          'message_send',
          'message',
          now,
          undefined,
          {
            ...createObservationAttributes({
              type: LangfuseObservationType.SPAN,
              output: event.content,
              metadata: {
                to: event.to,
                conversationId: runtimeContext.conversationId,
                channelId: runtimeContext.channelId,
              },
            }),
            ...withDetailedAttributes(allowDetailedReport, {
              'event.to': event.to,
              'event.content': event.content,
              'conversation.id': runtimeContext.conversationId,
              'channel.id': runtimeContext.channelId,
            }),
          },
          { traceId: traceContext.traceId, parentSpanId: traceContext.rootSpanId },
        ),
      );

      traceContext.currentMessageSend = {
        spanId,
        startTime: now,
      };
    });

    api.on('message_sent', async (event, runtimeContext) => {
      const now = Date.now();
      const conversationId = runtimeContext.conversationId ?? event.to;
      const traceContext = ensureLiveTraceContext({
        traceName: 'openclaw_request',
        conversationId,
        channelId: runtimeContext.channelId,
        input: event.content,
        eventFrom: event.to,
        metadata: { source: 'message_sent' },
      });
      const activeMessageSend = traceContext.currentMessageSend;

      traceContext.finalOutput = event.content ?? traceContext.finalOutput;

      if (activeMessageSend) {
        endSpan(activeMessageSend.spanId, now, {
          ...createObservationAttributes({
            type: LangfuseObservationType.SPAN,
            output: event.content,
            statusMessage: event.error,
            metadata: {
              success: event.success,
              to: event.to,
              conversationId: runtimeContext.conversationId,
              channelId: runtimeContext.channelId,
            },
          }),
          ...withDetailedAttributes(allowDetailedReport, {
            'event.success': event.success,
            'event.error': event.error,
            'event.to': event.to,
            'event.content': event.content,
            'conversation.id': runtimeContext.conversationId,
            'channel.id': runtimeContext.channelId,
          }),
        });

        traceContext.currentMessageSend = undefined;
      } else {
        exportChildSpan({
          name: 'message_send',
          type: 'message',
          startTime: now,
          endTime: now,
          parentTraceId: traceContext.traceId,
          parentSpanId: traceContext.rootSpanId,
          attributes: {
            ...createObservationAttributes({
              type: LangfuseObservationType.SPAN,
              output: event.content,
              statusMessage: event.error,
              metadata: {
                success: event.success,
                to: event.to,
              },
            }),
            ...withDetailedAttributes(allowDetailedReport, {
              'event.success': event.success,
              'event.error': event.error,
              'event.to': event.to,
              'event.content': event.content,
              'conversation.id': runtimeContext.conversationId,
              'channel.id': runtimeContext.channelId,
            }),
          },
        });
      }

      scheduleRootSpanEnd(traceContext, now);
    });

    api.on('llm_input', async (event, runtimeContext) => {
      const sessionKey = runtimeContext.sessionKey ?? runtimeContext.sessionId ?? 'system/unknown';
      const traceContext = ensureLiveTraceContext({
        traceName: 'openclaw_request',
        sessionKey,
        sessionId: runtimeContext.sessionId ?? event.sessionId,
        conversationId: runtimeContext.conversationId,
        channelId: runtimeContext.channelId,
        runId: event.runId,
        input: event.prompt ?? event.systemPrompt,
        eventFrom: runtimeContext.trigger,
        metadata: { source: 'llm_input' },
      });
      const cronContext = traceContext.cronContext;
      const sessionState = createSessionState(traceContext, sessionKey);
      const parentSpanId = sessionState.currentAgent?.agentSpanId ?? traceContext.rootSpanId;
      const promptHistory = buildPromptHistory(event);
      const promptAttributes = promptHistory.reduce((attributes, message, index) => {
        const content = normalizeContent(message.content);
        attributes[getGenAiPromptRole(index)] = message.role ?? '';
        attributes[getGenAiPromptContent(index)] = content;
        return attributes;
      }, {});

      rememberRunId(traceContext, event.runId);

      const now = Date.now();
      const userId = getRequestUserId(runtimeContext.sessionKey, traceContext.conversationId, runtimeContext.channelId);

      const { spanId } = startSpan(
        createSpanData(
          `llm:${event.provider}/${event.model}`,
          'model',
          now,
          undefined,
          {
            ...createObservationAttributes({
              type: LangfuseObservationType.GENERATION,
              input: promptHistory,
              model: event.model,
              metadata: {
                provider: event.provider,
                runId: event.runId,
                imagesCount: event.imagesCount,
                ...(createCronMetadata(cronContext) ? { cron: createCronMetadata(cronContext) } : {}),
              },
            }),
            [GEN_AI_SPAN_KIND]: GenAiSpanKind.LLM,
            [GEN_AI_PROVIDER_NAME]: event.provider,
            [GEN_AI_REQUEST_MODEL]: event.model,
            [GEN_AI_SYSTEM]: 'openclaw',
            ...createCronAttributes(cronContext),
            ...promptAttributes,
            ...withDetailedAttributes(allowDetailedReport, {
              [GEN_AI_SESSION_ID]: event.sessionId,
              [GEN_AI_USER_ID]: userId,
              'session.key': runtimeContext.sessionKey,
              'channel.id': runtimeContext.channelId,
              'run.id': event.runId,
              'event.workspace_dir': runtimeContext.workspaceDir,
            }),
          },
          { traceId: traceContext.traceId, parentSpanId },
        ),
      );

      sessionState.currentLlmInvoke = {
        spanId,
        startTime: now,
      };
    });

    api.on('llm_output', async (event, runtimeContext) => {
      const sessionKey = runtimeContext.sessionKey ?? runtimeContext.sessionId ?? 'system/unknown';
      const traceContext = ensureLiveTraceContext({
        traceName: 'openclaw_request',
        sessionKey,
        sessionId: runtimeContext.sessionId ?? event.sessionId,
        conversationId: runtimeContext.conversationId,
        channelId: runtimeContext.channelId,
        runId: event.runId,
        eventFrom: runtimeContext.trigger,
        metadata: { source: 'llm_output' },
      });
      const cronContext = traceContext.cronContext;
      const sessionState = createSessionState(traceContext, sessionKey);
      const llmInvoke = sessionState.currentLlmInvoke;
      const assistantOutput = (event.assistantTexts || []).join('\n\n------------\n\n');
      const usageDetails = createUsageDetails(event.usage);
      const userId = getRequestUserId(runtimeContext.sessionKey, traceContext.conversationId, runtimeContext.channelId);
      const attributes = {
        ...createObservationAttributes({
          type: LangfuseObservationType.GENERATION,
          output: assistantOutput,
          model: event.model,
          usageDetails,
          metadata: {
            provider: event.provider,
            runId: event.runId,
            ...(createCronMetadata(cronContext) ? { cron: createCronMetadata(cronContext) } : {}),
          },
        }),
        [GEN_AI_SPAN_KIND]: GenAiSpanKind.LLM,
        [GEN_AI_PROVIDER_NAME]: event.provider,
        [GEN_AI_RESPONSE_MODEL]: event.model,
        ...createCronAttributes(cronContext),
        [GEN_AI_USAGE_INPUT_TOKENS]: event.usage?.input,
        [GEN_AI_USAGE_OUTPUT_TOKENS]: event.usage?.output,
        [GEN_AI_USAGE_TOTAL_TOKENS]: event.usage?.total,
        [GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: event.usage?.cacheRead,
        [GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]: event.usage?.cacheWrite,
        [getGenAiCompletionRole(0)]: event.lastAssistant?.role || 'assistant',
        [getGenAiCompletionContent(0)]: assistantOutput,
        ...withDetailedAttributes(allowDetailedReport, {
          [GEN_AI_SESSION_ID]: event.sessionId ?? runtimeContext.sessionId,
          [GEN_AI_USER_ID]: userId,
          'session.key': runtimeContext.sessionKey,
          'event.run_id': event.runId,
        }),
      };

      traceContext.finalOutput = assistantOutput || traceContext.finalOutput;
      sessionState.lastAssistantMsg = assistantOutput;

      if (llmInvoke) {
        endSpan(llmInvoke.spanId, Date.now(), attributes);
        sessionState.currentLlmInvoke = undefined;
      } else {
        exportChildSpan({
          name: `llm:${event.provider}/${event.model}`,
          type: 'model',
          parentTraceId: traceContext.traceId,
          parentSpanId: sessionState.currentAgent?.agentSpanId ?? traceContext.rootSpanId,
          attributes,
        });
      }

      scheduleRootSpanEnd(traceContext, Date.now());
    });

    api.on('before_tool_call', async (event, runtimeContext) => {
      const runId = event.runId ?? runtimeContext.runId;
      const toolCallId = event.toolCallId ?? runtimeContext.toolCallId;
      const sessionKey = runtimeContext.sessionKey ?? runtimeContext.sessionId ?? 'system/unknown';
      const traceContext = ensureLiveTraceContext({
        traceName: 'openclaw_request',
        sessionKey,
        sessionId: runtimeContext.sessionId,
        conversationId: runtimeContext.conversationId,
        channelId: runtimeContext.channelId,
        runId,
        input: event.params,
        eventFrom: runtimeContext.trigger,
        metadata: { source: 'before_tool_call', toolName: event.toolName },
      });
      const cronContext = traceContext.cronContext;

      const sessionState = createSessionState(traceContext, sessionKey);
      const parentSpanId =
        sessionState.currentLlmInvoke?.spanId ??
        sessionState.currentAgent?.agentSpanId ??
        sessionState.totalSessionAncestorSpanId ??
        traceContext.rootSpanId;
      const now = Date.now();
      const userId = getRequestUserId(runtimeContext.sessionKey, traceContext.conversationId, traceContext.channelId);

      const { spanId } = startSpan(
        createSpanData(
          event.toolName,
          'tool',
          now,
          undefined,
          {
            ...createObservationAttributes({
              type: LangfuseObservationType.TOOL,
              input: event.params,
              metadata: {
                toolName: event.toolName,
                toolCallId,
                runId,
                ...(createCronMetadata(cronContext) ? { cron: createCronMetadata(cronContext) } : {}),
              },
            }),
            [GEN_AI_SPAN_KIND]: GenAiSpanKind.Tool,
            ...createCronAttributes(cronContext),
            ...withDetailedAttributes(allowDetailedReport, {
              [GEN_AI_SESSION_ID]: runtimeContext.sessionId,
              [GEN_AI_USER_ID]: userId,
              [GEN_AI_INPUT]: event.params,
              'tool.name': event.toolName,
              'tool.call_id': toolCallId,
              'run.id': runId,
            }),
          },
          { traceId: traceContext.traceId, parentSpanId },
        ),
      );

      if (toolCallId) {
        setToolCallInfo(toolCallId, {
          spanId,
          parentSpanId,
          traceId: traceContext.traceId,
          startTime: now,
        });
        rememberToolCallId(traceContext, toolCallId);
      }
    });

    api.on('after_tool_call', async (event, runtimeContext) => {
      const toolCallId = event.toolCallId ?? runtimeContext.toolCallId;
      const runId = event.runId ?? runtimeContext.runId;
      const storedToolCall = toolCallId ? getToolCallInfo(toolCallId) : undefined;
      const sessionKey = runtimeContext.sessionKey ?? runtimeContext.sessionId ?? 'system/unknown';
      const traceContext = ensureLiveTraceContext({
        traceName: 'openclaw_request',
        sessionKey,
        sessionId: runtimeContext.sessionId,
        conversationId: runtimeContext.conversationId,
        channelId: runtimeContext.channelId,
        runId,
        input: event.params,
        eventFrom: runtimeContext.trigger,
        metadata: { source: 'after_tool_call', toolName: event.toolName },
      });
      const cronContext = traceContext.cronContext;
      const sessionState = createSessionState(traceContext, sessionKey);
      const resultPayload = event.error ? { error: event.error } : event.result;
      const userId = getRequestUserId(runtimeContext.sessionKey, traceContext.conversationId, traceContext.channelId);
      const attributes = {
        ...createObservationAttributes({
          type: LangfuseObservationType.TOOL,
          input: event.params,
          output: resultPayload,
          statusMessage: event.error,
          metadata: {
            toolName: event.toolName,
            toolCallId,
            runId,
            ...(createCronMetadata(cronContext) ? { cron: createCronMetadata(cronContext) } : {}),
          },
        }),
        [GEN_AI_SPAN_KIND]: GenAiSpanKind.Tool,
        ...createCronAttributes(cronContext),
        ...withDetailedAttributes(allowDetailedReport, {
          [GEN_AI_SESSION_ID]: runtimeContext.sessionId,
          [GEN_AI_USER_ID]: userId,
          [GEN_AI_INPUT]: event.params,
          [GEN_AI_OUTPUT]: resultPayload,
          'tool.name': event.toolName,
          'tool.error': event.error,
        }),
      };

      if (storedToolCall) {
        endSpan(storedToolCall.spanId, Date.now(), attributes);
      } else {
        exportChildSpan({
          name: event.toolName,
          type: 'tool',
          parentTraceId: traceContext.traceId,
          parentSpanId:
            sessionState.currentAgent?.agentSpanId ??
            sessionState.totalSessionAncestorSpanId ??
            traceContext.rootSpanId,
          attributes,
        });
      }
    });

    api.on('tool_result_persist', (event, runtimeContext) => {
      const sessionKey = runtimeContext.sessionKey ?? 'system/unknown';
      const traceContext = ensureLiveTraceContext({
        traceName: 'openclaw_request',
        sessionKey,
        sessionId: runtimeContext.sessionId,
        conversationId: runtimeContext.conversationId,
        channelId: runtimeContext.channelId,
        input: event.message,
        eventFrom: runtimeContext.trigger,
        metadata: { source: 'tool_result_persist', toolName: event.toolName },
      });
      const sessionState = createSessionState(traceContext, sessionKey);
      const toolCallId = event.toolCallId ?? runtimeContext.toolCallId;
      const storedToolCall = toolCallId ? getToolCallInfo(toolCallId) : undefined;
      const parentSpanId =
        storedToolCall?.spanId ??
        sessionState.currentAgent?.agentSpanId ??
        sessionState.totalSessionAncestorSpanId ??
        traceContext.rootSpanId;

      exportChildSpan({
        name: event.toolName ? `tool_result_persist.${event.toolName}` : 'tool_result_persist',
        type: 'tool',
        parentTraceId: traceContext.traceId,
        parentSpanId,
        attributes: {
          ...createObservationAttributes({
            type: LangfuseObservationType.TOOL,
            output: event.message,
            metadata: {
              toolName: event.toolName,
              toolCallId,
              synthetic: event.isSynthetic,
            },
          }),
          ...withDetailedAttributes(allowDetailedReport, {
            'tool.name': event.toolName,
            'tool.call_id': toolCallId,
            'tool.is_synthetic': event.isSynthetic,
            'tool.persist_message': event.message,
          }),
        },
      });
    });

    api.on('before_model_resolve', async (event, runtimeContext) => {
      const sessionKey = runtimeContext.sessionKey ?? runtimeContext.sessionId ?? 'system/unknown';
      const traceContext = ensureTraceContext({
        sessionKey,
        sessionId: runtimeContext.sessionId,
        conversationId: runtimeContext.conversationId,
        channelId: runtimeContext.channelId,
        input: event.prompt,
        eventFrom: runtimeContext.trigger,
        traceName: 'openclaw_request',
        metadata: { source: 'before_model_resolve' },
      });
      const cronContext = traceContext.cronContext;

      traceContext.channelId = runtimeContext.channelId;
      traceContext.conversationId ??= runtimeContext.conversationId;

      const sessionState = createSessionState(traceContext, sessionKey);
      const parentSpanId = sessionState.totalSessionAncestorSpanId ?? traceContext.rootSpanId;
      const agentId = runtimeContext.agentId || 'mainAgent';
      const isSubAgent = String(runtimeContext.sessionKey || '').includes('subagent');
      const userId = getRequestUserId(runtimeContext.sessionKey, traceContext.conversationId, runtimeContext.channelId);
      const now = Date.now();

      const { spanId } = startSpan(
        createSpanData(
          agentId,
          'agent',
          now,
          undefined,
          {
            ...createObservationAttributes({
              type: LangfuseObservationType.AGENT,
              input: event.prompt,
              metadata: {
                agentId,
                trigger: runtimeContext.trigger,
                messageProvider: runtimeContext.messageProvider,
                isSubAgent,
                ...(createCronMetadata(cronContext) ? { cron: createCronMetadata(cronContext) } : {}),
              },
            }),
            [GEN_AI_SPAN_KIND]: isSubAgent ? GenAiSpanKind.SubAgent : GenAiSpanKind.Agent,
            ...createCronAttributes(cronContext),
            ...withDetailedAttributes(allowDetailedReport, {
              [GEN_AI_INPUT]: event.prompt,
              [GEN_AI_SESSION_ID]: runtimeContext.sessionId,
              [GEN_AI_USER_ID]: userId,
              'agent.id': agentId,
              'session.key': runtimeContext.sessionKey,
              'channel.id': runtimeContext.channelId,
              'message_provider': runtimeContext.messageProvider,
              trigger: runtimeContext.trigger,
            }),
          },
          { traceId: traceContext.traceId, parentSpanId },
        ),
      );

      sessionState.currentAgent = {
        runId: '',
        agentId,
        agentSpanId: spanId,
        agentStartTime: now,
      };
    });

    api.on('agent_end', async (event, runtimeContext) => {
      const sessionKey = runtimeContext.sessionKey ?? runtimeContext.sessionId ?? 'system/unknown';
      const traceContext = ensureLiveTraceContext({
        traceName: 'openclaw_request',
        sessionKey,
        sessionId: runtimeContext.sessionId,
        conversationId: runtimeContext.conversationId,
        channelId: runtimeContext.channelId,
        eventFrom: runtimeContext.trigger,
        metadata: { source: 'agent_end' },
      });
      const cronContext = traceContext.cronContext;
      const sessionState = createSessionState(traceContext, sessionKey);
      const currentAgent = sessionState.currentAgent;

      if (!currentAgent) {
        return;
      }

      sessionState.currentAgent = undefined;

      setTimeout(() => {
        endSpan(currentAgent.agentSpanId, Date.now(), {
          ...createObservationAttributes({
            type: LangfuseObservationType.AGENT,
            output: sessionState.lastAssistantMsg,
            statusMessage: event.error,
            metadata: {
              success: event.success,
              messages: event.messages,
              ...(createCronMetadata(cronContext) ? { cron: createCronMetadata(cronContext) } : {}),
            },
          }),
          ...createCronAttributes(cronContext),
          ...withDetailedAttributes(allowDetailedReport, {
            [GEN_AI_OUTPUT]: sessionState.lastAssistantMsg,
            'agent.messages': event.messages,
            'agent.error': event.error,
            'agent.is_success': event.success,
          }),
        });

        sessionState.lastAssistantMsg = undefined;
        scheduleRootSpanEnd(traceContext, Date.now());
      }, AGENT_END_DELAY_MS);
    });

    api.on('after_compaction', async (event, runtimeContext) => {
      const traceContext =
        (runtimeContext.sessionKey && getContextBySession(runtimeContext.sessionKey)) ||
        (runtimeContext.conversationId && getContextByConversationId(runtimeContext.conversationId)) ||
        lastUserTraceContext;

      if (!traceContext || !openSpans.has(traceContext.rootSpanId)) {
        logDebug('Skipping compaction export because there is no active trace context');
        return;
      }

      const now = Date.now();
      exportChildSpan({
        name: 'compaction',
        type: 'compaction',
        startTime: now,
        endTime: now,
        parentTraceId: traceContext.traceId,
        parentSpanId: traceContext.rootSpanId,
        attributes: {
          ...createObservationAttributes({
            type: LangfuseObservationType.SPAN,
            metadata: {
              sessionKey: runtimeContext.sessionKey,
              agentId: runtimeContext.agentId,
              sessionFile: event.sessionFile,
              compactedCount: event.compactedCount,
              messageCount: event.messageCount,
              tokenCount: event.tokenCount,
            },
          }),
          ...withDetailedAttributes(allowDetailedReport, {
            'session.session_key': runtimeContext.sessionKey,
            'session.agent_id': runtimeContext.agentId,
            'compaction.session_file': event.sessionFile,
            'compaction.compacted_count': event.compactedCount,
            'compaction.message_count': event.messageCount,
            'compaction.token_count': event.tokenCount,
          }),
        },
      });
    });

    api.on('subagent_spawning', async (event, runtimeContext) => {
      const childSessionKey = event.childSessionKey;
      const requesterSessionKey = runtimeContext.requesterSessionKey;
      let traceContext = requesterSessionKey ? getContextBySession(requesterSessionKey) : undefined;

      if (!traceContext && event.requester?.to) {
        traceContext = getContextByConversationId(event.requester.to);
      }

      if (!traceContext) {
        return;
      }

      setContextBySession(childSessionKey, traceContext);

      const now = Date.now();
      const { spanId } = startSpan(
        createSpanData(
          'subagent_spawn',
          'subagent',
          now,
          undefined,
          {
            ...createObservationAttributes({
              type: LangfuseObservationType.AGENT,
              metadata: {
                label: event.label,
                mode: event.mode,
                childSessionKey,
                requesterSessionKey,
                agentId: event.agentId,
                threadRequested: event.threadRequested,
              },
            }),
            ...withDetailedAttributes(allowDetailedReport, {
              'subagent.label': event.label,
              'subagent.mode': event.mode,
              'subagent.child_session_key': childSessionKey,
              'subagent.requester_session_key': requesterSessionKey,
              'subagent.agent_id': event.agentId,
              'subagent.thread_requested': event.threadRequested,
            }),
          },
          { traceId: traceContext.traceId, parentSpanId: traceContext.rootSpanId },
        ),
      );

      traceContext.allSessionMap[childSessionKey] = {
        totalSessionAncestorSpanId: spanId,
        currentSpawn: {
          spawnSessionSpanId: spanId,
          spawnSessionStartTime: now,
        },
      };
    });

    api.on('subagent_spawned', async (event, runtimeContext) => {
      const childSessionKey = event.childSessionKey;
      let traceContext = getContextBySession(childSessionKey);

      if (!traceContext && event.requester?.to) {
        traceContext = getContextByConversationId(event.requester.to);
      }

      if (!traceContext && runtimeContext.requesterSessionKey) {
        traceContext = getContextBySession(runtimeContext.requesterSessionKey);
      }

      if (!traceContext) {
        return;
      }

      setContextBySession(childSessionKey, traceContext);
      rememberRunId(traceContext, event.runId);

      const childState = createSessionState(traceContext, childSessionKey);
      const now = Date.now();

      if (childState.currentSpawn?.spawnSessionSpanId) {
        endSpan(childState.currentSpawn.spawnSessionSpanId, now, {
          'subagent.run_id': event.runId,
        });
      } else {
        exportChildSpan({
          name: 'subagent_spawn',
          type: 'subagent',
          startTime: now,
          endTime: now,
          parentTraceId: traceContext.traceId,
          parentSpanId: traceContext.rootSpanId,
          attributes: {
            ...createObservationAttributes({
              type: LangfuseObservationType.AGENT,
              metadata: {
                label: event.label,
                mode: event.mode,
                childSessionKey,
                requesterSessionKey: runtimeContext.requesterSessionKey,
                agentId: event.agentId,
                runId: event.runId,
              },
            }),
          },
        });
      }

      const lifecycleParentSpanId =
        createSessionState(traceContext, runtimeContext.requesterSessionKey || childSessionKey).currentAgent
          ?.agentSpanId ?? traceContext.rootSpanId;
      const { spanId } = startSpan(
        createSpanData(
          'subagent_lifecycle',
          'subagent',
          now,
          undefined,
          {
            ...createObservationAttributes({
              type: LangfuseObservationType.AGENT,
              metadata: {
                childSessionKey,
                runId: event.runId,
                agentId: event.agentId,
              },
            }),
            ...withDetailedAttributes(allowDetailedReport, {
              'subagent.child_session_key': childSessionKey,
              'subagent.run_id': event.runId,
              'subagent.agent_id': event.agentId,
            }),
          },
          { traceId: traceContext.traceId, parentSpanId: lifecycleParentSpanId },
        ),
      );

      childState.totalSessionAncestorSpanId = spanId;
      childState.currentSpawn = undefined;
    });

    api.on('subagent_delivery_target', async event => {
      let traceContext = getContextBySession(event.childSessionKey);

      if (!traceContext && event.requesterSessionKey) {
        traceContext = getContextBySession(event.requesterSessionKey);
      }

      if (!traceContext && event.requesterOrigin?.to) {
        traceContext = getContextByConversationId(event.requesterOrigin.to);
      }

      if (!traceContext) {
        return;
      }

      const childState = createSessionState(traceContext, event.childSessionKey);

      exportChildSpan({
        name: 'subagent_delivery_target',
        type: 'subagent',
        parentTraceId: traceContext.traceId,
        parentSpanId: childState.totalSessionAncestorSpanId ?? traceContext.rootSpanId,
        attributes: {
          ...createObservationAttributes({
            type: LangfuseObservationType.AGENT,
            metadata: {
              childSessionKey: event.childSessionKey,
              childRunId: event.childRunId,
              requesterSessionKey: event.requesterSessionKey,
            },
          }),
          ...withDetailedAttributes(allowDetailedReport, {
            'subagent.child_session_key': event.childSessionKey,
            'subagent.child_run_id': event.childRunId,
            'subagent.requester_session_key': event.requesterSessionKey,
          }),
        },
      });
    });

    api.on('subagent_ended', async event => {
      const traceContext = getContextBySession(event.targetSessionKey);

      if (!traceContext) {
        return;
      }

      const childState = createSessionState(traceContext, event.targetSessionKey);

      if (!childState.totalSessionAncestorSpanId) {
        return;
      }

      endSpan(childState.totalSessionAncestorSpanId, Date.now(), {
        ...createObservationAttributes({
          type: LangfuseObservationType.AGENT,
          statusMessage: event.reason,
          metadata: {
            outcome: event.outcome,
            error: event.error,
            sendFarewell: event.sendFarewell,
            runId: event.runId,
          },
        }),
        ...withDetailedAttributes(allowDetailedReport, {
          'subagent.ended_reason': event.reason,
          'subagent.ended_outcome': event.outcome,
          'subagent.ended_error': event.error,
          'subagent.send_farewell': event.sendFarewell,
          'subagent.run_id': event.runId,
        }),
      });
    });

    if (typeof api.registerHook === 'function') {
      api.registerHook(
        ['command:new', 'command:reset', 'command:stop'],
        async payload => {
          try {
            const action = payload?.action || 'unknown';
            const sessionKey = payload?.sessionKey || 'unknown';
            const traceContext = getContextBySession(sessionKey);
            const now = Date.now();

            exportSpan(
              createSpanData(
                `openclaw.command.${action}`,
                'command',
                now,
                now,
                {
                  ...createObservationAttributes({
                    type: LangfuseObservationType.SPAN,
                    metadata: {
                      action,
                      sessionKey,
                      source: payload?.context?.commandSource || 'unknown',
                    },
                  }),
                  ...withDetailedAttributes(allowDetailedReport, {
                    'openclaw.command.action': action,
                    'openclaw.command.session_key': sessionKey,
                    'openclaw.command.source': payload?.context?.commandSource || 'unknown',
                  }),
                },
                traceContext
                  ? { traceId: traceContext.traceId, parentSpanId: traceContext.rootSpanId }
                  : 'rootSpan',
              ),
            );
          } catch (error) {
            logDebug(`Error processing command event: ${error}`);
          }
        },
        {
          name: 'langfuse-command-events',
          description: 'Records session command spans for Langfuse',
        },
      );
    }
  },
};

export default langfuseOpenClawPlugin;
