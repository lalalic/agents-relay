import { readFile } from 'node:fs/promises';
import { GhApiClient, GitHubAppAuthOptions } from './store.js';

function value(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? '' : '';
}

export type GitHubAuthContext = { client: GhApiClient; trustedAuthors: Set<string>; appAuth: boolean };
export type GitHubAppConfig = { appId: string; installationId: string; privateKeyFile: string };

export function githubAppConfig(args: readonly string[], env: NodeJS.ProcessEnv = process.env): GitHubAppConfig | null {
  const appId = value(args, '--github-app-id') || env.AGENTS_RELAY_GITHUB_APP_ID || '';
  const installationId = value(args, '--github-app-installation-id') || env.AGENTS_RELAY_GITHUB_APP_INSTALLATION_ID || '';
  const privateKeyFile = value(args, '--github-app-private-key-file') || env.AGENTS_RELAY_GITHUB_APP_PRIVATE_KEY_FILE || '';
  const configured = [appId, installationId, privateKeyFile].filter(Boolean).length;
  if (configured === 0) return null;
  if (configured !== 3) throw new Error('GitHub App auth requires app id, installation id, and private key file');
  return { appId, installationId, privateKeyFile };
}

export async function githubAuthContext(args: readonly string[], env: NodeJS.ProcessEnv = process.env, probeLogin = true): Promise<GitHubAuthContext> {
  const config = githubAppConfig(args, env);
  let options: GitHubAppAuthOptions | null = null;
  if (config) options = { appId: config.appId, installationId: config.installationId, privateKey: await readFile(config.privateKeyFile, 'utf8') };
  const client = new GhApiClient(options);
  const trustedAuthors = new Set<string>();
  if (probeLogin) trustedAuthors.add(await client.currentLogin());
  for (const author of (value(args, '--trusted-authors') || env.AGENTS_RELAY_TRUSTED_AUTHORS || '').split(',').map(item => item.trim()).filter(Boolean)) trustedAuthors.add(author);
  if (options && probeLogin) {
    const local = await client.localLogin();
    if (local) trustedAuthors.add(local);
  }
  return { client, trustedAuthors, appAuth: options !== null };
}
