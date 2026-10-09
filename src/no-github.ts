import { GhApiClient } from './github-client.js';

/** No GitHub transport can escape the disabled adapter. */
export class DisabledGitHubClient extends GhApiClient {
  override async request(): Promise<never> { throw new Error('GitHub disabled by --no-github'); }
  override async graphql(): Promise<never> { throw new Error('GitHub disabled by --no-github'); }
  override async rateLimitSnapshot(): Promise<never> { throw new Error('GitHub disabled by --no-github'); }
  override async currentLogin(): Promise<never> { throw new Error('GitHub disabled by --no-github'); }
}
export function noGitHubMode(args: readonly string[] = process.argv.slice(2)): boolean {
  return args.includes('--no-github') || process.argv.includes('--no-github') || process.env.AGENTS_RELAY_NO_GITHUB === '1';
}
