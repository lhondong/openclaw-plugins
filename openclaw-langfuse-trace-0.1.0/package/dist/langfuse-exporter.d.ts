import type { LangfuseTraceConfig, OpenClawPluginApi, SpanData } from "./types.js";
export declare class LangfuseExporter {
    private api;
    private config;
    private provider;
    private tracer;
    private initialized;
    private initPromise;
    private currentRootSpan;
    private currentRootContext;
    private currentAgentSpan;
    private currentAgentContext;
    private openSpans;
    constructor(api: OpenClawPluginApi, config: LangfuseTraceConfig);
    private ensureInitialized;
    private initialize;
    startSpan(spanData: SpanData, spanId: string): Promise<void>;
    private doStartSpan;
    endSpanById(spanId: string, endTime?: number, additionalAttrs?: Record<string, string | number | boolean>, output?: unknown, input?: unknown): void;
    export(spanData: SpanData): Promise<void>;
    private setSpanInputOutput;
    endTrace(): void;
    private getSpanKind;
    private flattenAttributes;
    flush(): Promise<void>;
    dispose(): Promise<void>;
}
