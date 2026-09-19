#!/usr/bin/env node
export function nextPatchVersion(current) {
  if (!current) return '1.0.0';
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current.trim());
  if (!match) throw new Error(`Unsupported npm version: ${current}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${nextPatchVersion(process.argv[2] ?? '')}\n`);
}
