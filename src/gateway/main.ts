#!/usr/bin/env node
import { isEntrypoint } from '../cli.js';
import { NatsEventBus } from '../events.js';
import { EventRecord } from '../types.js';
import { GatewayConfig, loadGatewayConfig } from './config.js';
import { GhCliClient } from './github.js';
import { createEventSink } from './events.js';
import { JobSupervisor, RecoveryReport } from './supervisor.js';
import { createActions } from './actions.js';
import { RunningGateway, installShutdown, startGatewayServer } from './server.js';

export type GatewayRuntime = RunningGateway & { config: GatewayConfig; supervisor: JobSupervisor; recovery: RecoveryReport; stop(): Promise<void> };

export function gatewayEventBus(config: GatewayConfig): NatsEventBus | undefined {
  return config.events.enabled ? new NatsEventBus(config.events.natsUrl, config.events.subjectPrefix) : undefined;
}

/** Existing CLI convention: events are mirrored to stderr so an operator sees the same stream the bus carries. */
export function gatewayEmit(event: EventRecord): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

export async function startGateway(config: GatewayConfig): Promise<GatewayRuntime> {
  const client = new GhCliClient();
  const eventBus = gatewayEventBus(config);
  const emit = gatewayEmit;
  const events = createEventSink({ eventBus, emit });
  const supervisor = new JobSupervisor({ config, client, eventBus, emit });
  const recovery = await supervisor.recover();
  const actions = createActions({ config, client, supervisor, events });
  const gateway = await startGatewayServer({ config, actions });
  const stop = installShutdown({ server: gateway.server, stops: [(): Promise<void> => supervisor.stop()] });
  process.stdout.write(`Agents Relay gateway listening on http://${config.bind}:${gateway.port} (recovered ${recovery.recovered}/${recovery.discovered} open relay PRs)\n`);
  return { ...gateway, config, supervisor, recovery, stop };
}

export async function runGateway(argv: readonly string[], env: Record<string, string | undefined>): Promise<GatewayRuntime> {
  return startGateway(loadGatewayConfig(env, argv));
}

if (isEntrypoint(import.meta.url)) {
  runGateway(process.argv.slice(2), process.env).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
