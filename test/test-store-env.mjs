import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const storeDirectory = mkdtempSync(join(tmpdir(), 'agents-relay-test-stores-'));
process.env.AGENTS_RELAY_STORE_DIR = storeDirectory;
process.on('exit', () => rmSync(storeDirectory, { recursive: true, force: true }));
