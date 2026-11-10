import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const storeDirectory = mkdtempSync(join(tmpdir(), 'agents-relay-test-stores-'));
process.env.AGENTS_RELAY_STORE_DIR = storeDirectory;
// Keep the test suite isolated from the host's pre-cutover Events Bus config.
process.env.EVENTS_BUS_CONFIG = join(storeDirectory, 'events-runtime.json');
process.env.EVENTS_BUS_DATA_DIR = storeDirectory;
process.on('exit', () => rmSync(storeDirectory, { recursive: true, force: true }));
