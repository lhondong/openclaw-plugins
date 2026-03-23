export const LANGFUSE_TRACE_NAME = 'langfuse.trace.name';
export const LANGFUSE_TRACE_INPUT = 'langfuse.trace.input';
export const LANGFUSE_TRACE_OUTPUT = 'langfuse.trace.output';
export const LANGFUSE_TRACE_METADATA = 'langfuse.trace.metadata';
export const LANGFUSE_TRACE_TAGS = 'langfuse.trace.tags';
export const LANGFUSE_TRACE_PUBLIC = 'langfuse.trace.public';
export const LANGFUSE_USER_ID = 'user.id';
export const LANGFUSE_SESSION_ID = 'session.id';
export const LANGFUSE_USER_ID_COMPAT = 'langfuse.user.id';
export const LANGFUSE_SESSION_ID_COMPAT = 'langfuse.session.id';
export const LANGFUSE_OBSERVATION_TYPE = 'langfuse.observation.type';
export const LANGFUSE_OBSERVATION_METADATA = 'langfuse.observation.metadata';
export const LANGFUSE_OBSERVATION_LEVEL = 'langfuse.observation.level';
export const LANGFUSE_OBSERVATION_STATUS_MESSAGE = 'langfuse.observation.status_message';
export const LANGFUSE_OBSERVATION_INPUT = 'langfuse.observation.input';
export const LANGFUSE_OBSERVATION_OUTPUT = 'langfuse.observation.output';
export const LANGFUSE_OBSERVATION_COMPLETION_START_TIME = 'langfuse.observation.completion_start_time';
export const LANGFUSE_OBSERVATION_MODEL = 'langfuse.observation.model.name';
export const LANGFUSE_OBSERVATION_MODEL_PARAMETERS = 'langfuse.observation.model.parameters';
export const LANGFUSE_OBSERVATION_USAGE_DETAILS = 'langfuse.observation.usage_details';
export const LANGFUSE_OBSERVATION_COST_DETAILS = 'langfuse.observation.cost_details';
export const LANGFUSE_OBSERVATION_PROMPT_NAME = 'langfuse.observation.prompt.name';
export const LANGFUSE_OBSERVATION_PROMPT_VERSION = 'langfuse.observation.prompt.version';
export const LANGFUSE_ENVIRONMENT = 'langfuse.environment';
export const LANGFUSE_RELEASE = 'langfuse.release';
export const LANGFUSE_VERSION = 'langfuse.version';
export const LANGFUSE_AS_ROOT = 'langfuse.internal.as_root';
export const LangfuseObservationType = {
    SPAN: 'span',
    GENERATION: 'generation',
    AGENT: 'agent',
    TOOL: 'tool',
    CHAIN: 'chain',
    RETRIEVER: 'retriever',
    EVALUATOR: 'evaluator',
    GUARDRAIL: 'guardrail',
    EMBEDDING: 'embedding',
};
