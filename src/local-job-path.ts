import { homedir } from 'node:os';
import { join } from 'node:path';

export function relayStoreDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTS_RELAY_STORE_DIR || join(homedir(), '.agents-relay', 'stores');
}
