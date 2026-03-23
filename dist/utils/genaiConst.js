export const GEN_AI_SYSTEM = 'gen_ai.system';
export const GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
export const GEN_AI_REQUEST_TYPE = 'gen_ai.request.type';
export const GEN_AI_RESPONSE_MODEL = 'gen_ai.response.model';
export const GEN_AI_REQUEST_MAX_TOKENS = 'gen_ai.request.max_tokens';
export const GEN_AI_REQUEST_TEMPERATURE = 'gen_ai.request.temperature';
export const GEN_AI_REQUEST_TOP_P = 'gen_ai.request.top_p';
export const GEN_AI_RESPONSE_FINISH_REASON = 'gen_ai.response.finish_reason';
export const GEN_AI_RESPONSE_STOP_REASON = 'gen_ai.response.stop_reason';
export const GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
export const GEN_AI_USAGE_TOTAL_TOKENS = 'gen_ai.usage.total_tokens';
export const GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS = 'gen_ai.usage.cache_creation_input_tokens';
export const GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS = 'gen_ai.usage.cache_read_input_tokens';
export const GEN_AI_IS_STREAMING = 'gen_ai.response.is_streaming';
export const GEN_AI_STREAMING_TIME_TO_FIRST_TOKEN = 'gen_ai.streaming.time_to_first_token';
export const GEN_AI_STREAMING_TIME_PER_OUTPUT_TOKEN = 'gen_ai.streaming.time_per_output_token';
export const GEN_AI_USER_ID = 'gen_ai.user.id';
export const GEN_AI_SESSION_ID = 'gen_ai.session.id';
export const GEN_AI_SPAN_KIND = 'gen_ai.span.kind';
export const GEN_AI_PROVIDER_NAME = 'gen_ai.provider.name';
export const GEN_AI_INPUT = 'gen_ai.input';
export const GEN_AI_OUTPUT = 'gen_ai.output';
export const GenAiSpanKind = {
    Root: 'root',
    Agent: 'agent',
    SubAgent: 'subagent',
    LLM: 'llm',
    Tool: 'tool',
};
export const getGenAiPromptRole = index => `gen_ai.prompt.${index}.role`;
export const getGenAiPromptContent = index => `gen_ai.prompt.${index}.content`;
export const getGenAiCompletionRole = index => `gen_ai.completion.${index}.role`;
export const getGenAiCompletionContent = index => `gen_ai.completion.${index}.content`;
