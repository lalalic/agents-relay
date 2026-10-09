import { mkdirSync, readFileSync, rmSync, writeFileSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';

type MergeLock = { pid: number; host: string; startedAt: string; targetRef: string };
const sleep = (ms: number): void => {
  // Synchronous delivery API; Atomics.wait only blocks this worker's thread.
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0, ms);
};

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Cross-process atomic directory lock in the shared Git common directory. */
export function withLocalMergeLock<T>(
  commonDir: string, targetRef: string, action: () => T,
  timeoutMs = 15000,
): T {
  const digest = createHash('sha256').update(targetRef).digest('hex').slice(0, 24);
  const path = join(commonDir, 'agents-relay-merge-' + digest + '.lockdir');
  const ownerPath = join(path, 'owner.json');
  const recoveryGuard = path + '.recovery';
  const guardOwnerPath = join(recoveryGuard, 'owner.json');
  const incompleteGraceMs = 3000;
  const deadline = Date.now() + timeoutMs;
  const owner: MergeLock = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), targetRef };
  while (true) {
    try {
      mkdirSync(path);
      writeFileSync(ownerPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Reap a crashed recovery owner, or a crash between mkdir and owner write.
      // Renaming the orphan into a private quarantine keeps cleanup out of the
      // active path. A grace period protects slow owner-file initialization.
      const orphaned = (directory: string, metadata: string): boolean => {
        try {
          const age = Date.now() - statSync(directory).mtimeMs;
          if (age < incompleteGraceMs) return false;
          try {
            const previous = JSON.parse(readFileSync(metadata, 'utf8')) as MergeLock;
            return previous.host === hostname() && Number.isInteger(previous.pid)
              && !processAlive(previous.pid);
          } catch { return true; }
        } catch { return false; }
      };
      if (orphaned(recoveryGuard, guardOwnerPath)) {
        const quarantine = recoveryGuard + '.orphan-' + process.pid + '-' + createHash('sha256').update(owner.startedAt).digest('hex').slice(0, 10);
        try { renameSync(recoveryGuard, quarantine); rmSync(quarantine, { recursive: true, force: true }); }
        catch { /* another recovery contender may already have moved it */ }
      }
      let guarded = false;
      try {
        mkdirSync(recoveryGuard);
        guarded = true;
        writeFileSync(guardOwnerPath, JSON.stringify(owner), {flag: 'wx', mode: 0o600});
        if (orphaned(path, ownerPath)) rmSync(path, {recursive: true, force: true});
      } catch { /* A live lock or incomplete initialization must be preserved. */ }
      finally {
        if (guarded) {
          try {
            const current = JSON.parse(readFileSync(guardOwnerPath, 'utf8')) as MergeLock;
            if (current.pid === owner.pid && current.startedAt === owner.startedAt && current.host === owner.host)
              rmSync(recoveryGuard, {recursive: true, force: true});
          } catch { /* keep unknown guard */ }
        }
      }
      if (Date.now() >= deadline) throw new Error('Local merge target locked: ' + targetRef);
      sleep(50);
    }
  }
  try { return action(); }
  finally {
    // Never release a lock now owned by a different process.
    try {
      const current = JSON.parse(readFileSync(ownerPath, 'utf8')) as MergeLock;
      if (current.pid === owner.pid && current.host === owner.host && current.startedAt === owner.startedAt)
        rmSync(path, { recursive: true, force: true });
    } catch { /* preserve any unknown lock */ }
  }
}
