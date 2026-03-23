export const SeverityNumber = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

export function registerLogFeatures(api) {
  if (api?.pluginConfig?.debug) {
    api.logger?.info?.(
      '[OpenClaw Langfuse Plugin] Structured OTLP log export is disabled because Langfuse only ingests traces on /api/public/otel/v1/traces.',
    );
  }
}
