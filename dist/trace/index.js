import { LOG_PREFIX } from './types.js';
import { createSpanData, createSpanOperations, } from './span.js';
import { createContextManager } from './context.js';
export { createSpanData, generateSpanId, generateTraceId } from './span.js';
export function createTraceHelpers(options) {
    const { tracer, openSpans, pluginConfig, api, tracerProvider, meterProvider, loggerProvider, } = options;
    const spanOperations = createSpanOperations(tracer, openSpans, pluginConfig, api);
    const contextManager = createContextManager(pluginConfig, api);
    async function flush() {
        try {
            await tracerProvider?.forceFlush?.();
            await meterProvider?.forceFlush?.();
            await loggerProvider?.forceFlush?.();
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            api.logger?.warn?.(`${LOG_PREFIX} Flush failed: ${message}`);
        }
    }
    return {
        ...spanOperations,
        ...contextManager,
        createSpanData,
        startContextCleanupInterval: contextManager.startCleanupInterval,
        stopContextCleanupInterval: contextManager.stopCleanupInterval,
        flush,
    };
}
