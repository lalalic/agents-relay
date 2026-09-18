import { GatewayConfig } from './config.js';

/** Repeated verbatim in the `create_job` description so connector authors see it in the action surface. */
export const DATA_HANDLING_WARNING = 'Data handling warning: `intent`, `context`, and `requirements` become durable GitHub PR content (`Job.requirements`, `createdBy`, and the initial task `input`). Callers must not send secrets, credentials, tokens, or private data. Large or private payloads belong in artifact references owned by the caller. This design adds no encryption, redaction, or alternate storage.';

const ERROR_SCHEMA = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'retryable'],
      properties: {
        code: { type: 'string', enum: ['unauthorized', 'invalid_request', 'unknown_field', 'unknown_project', 'payload_too_large', 'unsupported_media_type', 'not_found', 'idempotency_conflict', 'capacity_exceeded', 'github_unavailable', 'internal'] },
        message: { type: 'string' },
        retryable: { type: 'boolean' },
      },
      additionalProperties: true,
    },
  },
} as const;

const CREATE_JOB_REQUEST = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'project', 'idempotency_key'],
  properties: {
    intent: { type: 'string', minLength: 1, maxLength: 4000, description: 'What the job should accomplish.' },
    project: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,31}$', description: 'Name of an allowlisted gateway project.' },
    idempotency_key: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$', description: 'Caller-chosen retry key. The same key always names the same job.' },
    context: { type: 'string', maxLength: 16000, description: 'Supporting prose. Durable PR content; never a secret.' },
    requirements: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 512 }, description: 'Recorded prose only; never selects capabilities, adapter, or routing.' },
    parent: {
      type: 'object',
      additionalProperties: false,
      properties: { job_id: { type: 'string', maxLength: 128 }, task_id: { type: 'string', maxLength: 128 } },
      description: 'Optional lineage metadata. Recorded only; no cross-PR dependency is created.',
    },
    agent: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', maxLength: 64 } }, description: 'Optional caller label.' },
  },
} as const;

const PR_SCHEMA = {
  type: 'object',
  properties: {
    repository: { type: 'string' },
    number: { type: 'integer' },
    branch: { type: 'string' },
    url: { type: 'string' },
  },
} as const;

const LINKS_SCHEMA = {
  type: 'object',
  properties: {
    self: { type: 'string' },
    status: { type: 'string', description: 'Alias for links.self.' },
    pr: { type: 'string' },
    dashboard: { type: 'string', description: 'Only present when the project config sets dashboard_url.' },
  },
} as const;

const CREATE_JOB_RESPONSE = {
  type: 'object',
  properties: {
    job_id: { type: 'string' },
    state: { type: 'string' },
    project: { type: 'string' },
    created: { type: 'boolean', description: 'true on 201; false when an identical request reuses the existing job.' },
    reconciled: { type: 'boolean', description: 'true when the first reconciliation finished inside create_timeout_ms.' },
    request_fingerprint: { type: 'string' },
    task_id: { type: ['string', 'null'] },
    title: { type: 'string' },
    pr: { ...PR_SCHEMA, description: 'The durable anchor pull request.' },
    links: LINKS_SCHEMA,
    poll_after_ms: { type: 'integer' },
  },
} as const;

const GET_JOB_RESPONSE = {
  type: 'object',
  properties: {
    job_id: { type: 'string' },
    project: { type: 'string' },
    state: { type: 'string' },
    terminal: { type: 'boolean' },
    updated_at: { type: 'string' },
    closed: { type: 'boolean', description: 'Reflects the PR state; a closed PR never mutates the durable job.' },
    title: { type: 'string' },
    request_fingerprint: { type: ['string', 'null'] },
    lineage: { type: ['object', 'null'], properties: { parent_job_id: { type: ['string', 'null'] }, parent_task_id: { type: ['string', 'null'] }, agent: { type: ['string', 'null'] } } },
    pr: PR_SCHEMA,
    tasks: {
      type: 'array',
      description: 'Bounded task summaries; task input, context, routing, and continuation are never returned.',
      items: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          state: { type: 'string' },
          attempt: { type: 'integer' },
          adapter: { type: 'string' },
          result_summary: { type: ['string', 'null'] },
          error: { type: ['string', 'null'] },
          thread_id: { type: ['string', 'null'] },
          updated_at: { type: 'string' },
        },
      },
    },
    links: LINKS_SCHEMA,
  },
} as const;

export function createOpenApiDocument(config: GatewayConfig): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Agents Relay action gateway',
      version: '1.0.0',
      description: 'Minimal connected action surface for hosted ChatGPT plugins/connectors: create one Agents Relay job, then read it. GitHub pull request markers remain the durable truth; the gateway stores no state of its own.',
    },
    servers: config.publicBaseUrl ? [{ url: config.publicBaseUrl }] : [],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      schemas: { Error: ERROR_SCHEMA },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      '/healthz': {
        get: {
          operationId: 'healthz',
          summary: 'Liveness probe',
          security: [],
          responses: { '204': { description: 'Ready. Unauthenticated, empty body.' } },
        },
      },
      '/v1/jobs': {
        post: {
          operationId: 'create_job',
          summary: 'Create one Agents Relay job',
          description: `Creates exactly one allowlisted-project job, anchors it to a draft pull request, and returns the durable job id. The caller never selects the repository, working directory, shell command, adapter, provider, model, capabilities, or routing. Retry with the same idempotency_key and an identical request to reuse the existing job; the same key with a different request returns 409 idempotency_conflict. ${DATA_HANDLING_WARNING}`,
          requestBody: { required: true, content: { 'application/json': { schema: CREATE_JOB_REQUEST } } },
          responses: {
            '201': { description: 'Job anchored and durable.', content: { 'application/json': { schema: CREATE_JOB_RESPONSE } } },
            '200': { description: 'Identical request reused the existing job.', content: { 'application/json': { schema: CREATE_JOB_RESPONSE } } },
            '400': { description: 'invalid_request, unknown_field, or unknown_project.', content: { 'application/json': { schema: ERROR_SCHEMA } } },
            '401': { description: 'unauthorized.', content: { 'application/json': { schema: ERROR_SCHEMA } } },
            '409': { description: 'idempotency_conflict.', content: { 'application/json': { schema: ERROR_SCHEMA } } },
            '413': { description: 'payload_too_large.', content: { 'application/json': { schema: ERROR_SCHEMA } } },
            '415': { description: 'unsupported_media_type.', content: { 'application/json': { schema: ERROR_SCHEMA } } },
            '429': { description: 'capacity_exceeded.', content: { 'application/json': { schema: ERROR_SCHEMA } } },
            '502': { description: 'github_unavailable.', content: { 'application/json': { schema: ERROR_SCHEMA } } },
          },
        },
      },
      '/v1/jobs/{job_id}': {
        get: {
          operationId: 'get_job',
          summary: 'Read one Agents Relay job',
          parameters: [{ name: 'job_id', in: 'path', required: true, schema: { type: 'string' } }],
          description: 'Bounded read of the durable job inside its anchor pull request. Never returns task input, context, routing, or credentials, and never mutates state.',
          responses: {
            '200': { description: 'Current durable job view.', content: { 'application/json': { schema: GET_JOB_RESPONSE } } },
            '401': { description: 'unauthorized.', content: { 'application/json': { schema: ERROR_SCHEMA } } },
            '404': { description: 'not_found.', content: { 'application/json': { schema: ERROR_SCHEMA } } },
            '502': { description: 'github_unavailable.', content: { 'application/json': { schema: ERROR_SCHEMA } } },
          },
        },
      },
    },
  };
}
