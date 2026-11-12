#!/usr/bin/env node
import { migrateTaskIds } from '../dist/task-id-migration.js';

const args=process.argv.slice(2);
const option=name=>{const index=args.indexOf(name);if(index<0||!args[index+1])throw new Error(`Required: ${name} PATH`);return args[index+1];};
try {
  const result=await migrateTaskIds(option('--database'),option('--backup'));
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
} catch(error) {
  process.stderr.write((error instanceof Error?error.message:String(error))+'\n');
  process.exitCode=1;
}
