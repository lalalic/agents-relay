#!/usr/bin/env node
import { runDaemon } from './relayd.js';

runDaemon(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
