export function authoritativeBranchPushArgs(options: {
  sourceRef: string;
  branch: string;
  remoteHeadSha?: string | null;
  remoteTreeMatchesBase?: boolean;
}): string[] {
  const refspec = `${options.sourceRef}:refs/heads/${options.branch}`;
  if (options.remoteHeadSha && options.remoteTreeMatchesBase) {
    return [
      'push',
      'origin',
      `--force-with-lease=refs/heads/${options.branch}:${options.remoteHeadSha}`,
      refspec,
    ];
  }
  return ['push', 'origin', refspec];
}
