import { LOG_PREFIX } from '../trace/types.js';

export function createDiagnosticsOtelService(pluginConfig) {
  let warned = false;

  return {
    id: 'openclaw-langfuse-diagnostics-disabled',
    async start(api) {
      if (warned) {
        return;
      }

      warned = true;
      api.logger?.warn?.(
        `${LOG_PREFIX} OpenClaw native metrics/log diagnostics were requested, but Langfuse OTLP ingestion accepts traces only. Diagnostics export is disabled.`,
      );

      if (pluginConfig?.debug) {
        api.logger?.info?.(
          `${LOG_PREFIX} Keep using the standard OpenClaw hooks for traces. Metrics/log exporters were intentionally removed for Langfuse compatibility.`,
        );
      }
    },
    async stop() {},
  };
}
