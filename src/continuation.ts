import { spawn } from 'node:child_process';
import { Continuation } from './types.js';
export interface ContinuationAdapter { continue(input: string, continuation: Continuation): Promise<void>; }
export class CodexThreadContinuation implements ContinuationAdapter { constructor(private readonly command = 'codex') {} async continue(input: string, continuation: Continuation): Promise<void> { if (continuation.kind !== 'codex-thread') throw new Error('Continuation is not a Codex thread'); await new Promise<void>((resolve, reject) => { const child = spawn(this.command, ['resume', continuation.target, input]); child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`Codex continuation exited ${code}`))); }); } }
