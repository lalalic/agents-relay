import { timingSafeEqual } from 'node:crypto';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { GatewayActions, GatewayError } from './actions.js';
import { GatewayConfig } from './config.js';
import { createOpenApiDocument } from './openapi.js';

export type GatewayServerOptions = { config: GatewayConfig; actions: GatewayActions };
export type RunningGateway = { server: Server; port: number; close(): Promise<void> };

export async function startGatewayServer(options: GatewayServerOptions): Promise<RunningGateway> {
  const server = createServer((request, response) => { void handle(options, request, response); });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(options.config.port, options.config.bind, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.config.port;
  return { server, port, close: () => closeServer(server) };
}

export async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

export type ShutdownOptions = { server: Server; stops?: Array<() => Promise<void>>; exit?: (code: number) => void; log?: (message: string) => void };

/** SIGINT/SIGTERM stop: close the HTTP server, then every runtime the supervisor owns. */
export function installShutdown(options: ShutdownOptions): () => Promise<void> {
  const exit = options.exit ?? ((code: number): void => process.exit(code));
  const log = options.log ?? ((message: string): void => { process.stderr.write(`${message}\n`); });
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      await closeServer(options.server);
      for (const component of options.stops ?? []) await component();
    })().then(
      () => exit(0),
      (error: unknown) => {
        log(error instanceof Error ? error.message : String(error));
        exit(1);
      },
    );
    return stopping;
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  return stop;
}

async function handle(options: GatewayServerOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const pathname = new URL(request.url ?? '/', 'http://gateway.local').pathname;
    if (request.method === 'GET' && pathname === '/healthz') {
      sendJson(response, 204, null);
      return;
    }
    if (!isAuthorized(options.config.token, request.headers.authorization)) {
      throw new GatewayError(401, 'unauthorized', 'A valid bearer token is required', false);
    }
    if (request.method === 'GET' && pathname === '/v1/openapi.json') {
      sendJson(response, 200, createOpenApiDocument(options.config));
      return;
    }
    if (request.method === 'POST' && pathname === '/v1/jobs') {
      const outcome = await options.actions.createJob(await readJsonBody(options.config, request));
      sendJson(response, outcome.status, outcome.body);
      return;
    }
    if (request.method === 'GET' && pathname.startsWith('/v1/jobs/')) {
      const jobId = decodeURIComponent(pathname.slice('/v1/jobs/'.length));
      if (jobId.length === 0 || jobId.includes('/')) throw new GatewayError(404, 'not_found', 'No such route', false);
      const outcome = await options.actions.getJob(jobId);
      sendJson(response, outcome.status, outcome.body);
      return;
    }
    throw new GatewayError(404, 'not_found', `No route for ${request.method ?? 'GET'} ${pathname}`, false);
  } catch (error) {
    sendError(response, error);
  }
}

function isAuthorized(expected: string, header: string | undefined): boolean {
  const prefix = 'Bearer ';
  if (typeof header !== 'string' || !header.startsWith(prefix)) return false;
  const provided = Buffer.from(header.slice(prefix.length), 'utf8');
  const actual = Buffer.from(expected, 'utf8');
  if (provided.length !== actual.length) return false;
  return timingSafeEqual(provided, actual);
}

/** Reads at most `maxBodyBytes`; an oversized body is drained so the caller still receives 413. */
async function readJsonBody(config: GatewayConfig, request: IncomingMessage): Promise<unknown> {
  const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new GatewayError(415, 'unsupported_media_type', 'content-type must be application/json', false);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let exceeded = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (exceeded) continue;
    size += buffer.length;
    if (size > config.maxBodyBytes) {
      exceeded = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(buffer);
  }
  if (exceeded) throw new GatewayError(413, 'payload_too_large', `Request body exceeds ${config.maxBodyBytes} bytes`, false);
  if (size === 0) throw new GatewayError(400, 'invalid_request', 'Request body must be a JSON object', false);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new GatewayError(400, 'invalid_request', 'Request body must be valid JSON', false);
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  if (status === 204 || body === null) {
    response.writeHead(status);
    response.end();
    return;
  }
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

function sendError(response: ServerResponse, error: unknown): void {
  const gateway = error instanceof GatewayError ? error : new GatewayError(500, 'internal', error instanceof Error ? error.message : String(error), true);
  const payload: Record<string, unknown> = { code: gateway.code, message: gateway.message, retryable: gateway.retryable };
  if (gateway.extra) Object.assign(payload, gateway.extra);
  sendJson(response, gateway.status, { error: payload });
}
