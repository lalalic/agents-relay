#!/usr/bin/env node
export function nextPublishVersion(current, baseline = '') {
  const parse = value => {
    if (!value) return null;
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value.trim());
    if (!match) throw new Error(`Unsupported npm version: ${value}`);
    return match.slice(1).map(Number);
  };
  const published = parse(current);
  const requested = parse(baseline);
  if (requested && (!published || requested[0] > published[0] || (requested[0] === published[0] && (requested[1] > published[1] || (requested[1] === published[1] && requested[2] > published[2]))))) return `${requested[0]}.${requested[1]}.${requested[2]}`;
  if (!published) return baseline.trim() || '1.0.0';
  return `${published[0]}.${published[1]}.${published[2] + 1}`;
}

export const nextPatchVersion = current => nextPublishVersion(current);

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${nextPublishVersion(process.argv[2] ?? '', process.argv[3] ?? '')}\n`);
}
