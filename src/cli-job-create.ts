import { allocateEntityId, isGeneratedEntityId } from './job-task-id-sequence.js';
import type { Job, Priority } from './types.js';
import { type GitHubClient, type PullRequest } from './store.js';
import { openLocalManagedStore } from './local-managed-store.js';
import { createJobEntity, createTaskEntity } from './workflow/entity-creation.js';
import { parseAgentGraph } from './agent-graph.js';
import { taskOverallTimeoutMs } from './types.js';
import { isAbsolute, resolve } from 'node:path';
import { normalizeThreadId } from './reviewer-thread.js';
import { discoverLocalRelayStoreSnapshots, relayStoreDirectory } from './relay-store.js';
import { validateProjectRoot } from './workspace.js';
import { resolveRepositoryProjectPath } from './workspace.js';

/** Create a local SQLite-authoritative Job; external PR metadata is optional compatibility data. */
export async function ensureManagedGitHubJob(
  _client: GitHubClient,
  repositoryName: string,
  _trustedAuthors: ReadonlySet<string>,
  options: {
    id?: string; idempotencyKey?: string; title?: string; objective?: string; projectRoot?: string; projectPath?: string; githubRepo?: string;
    priority?: Priority;
    tag?: Job['tag']; reviewEnabled?: boolean; autoMerge?: boolean; continuation?: Job['continuation'];
    coordinator?: { graph: string; input: string; outputPath: string; projectRoot: string; workspaceRoot: string; sharedRoot?: string; globalRoot?: string };
    prNumber?: number; head?: string; base?: string; body?: string;
    reviewerThreadId?: string; creatorThreadId?: string; implementationThreadId?: string;
    storeDirectory?: string; noGitHub?: boolean; persist?: boolean; localMergeSource?: string; localMergeTarget?: string;
  },
): Promise<{ job: Job; pr: PullRequest }> {
  if (options.id && !/^[1-9][0-9]*$/.test(options.id)) throw new Error('Job ID must be a positive decimal integer');
  if(options.coordinator){
    const c=options.coordinator;
    if(!c.graph?.trim()||!c.input?.trim())throw Error('Coordinator requires nonempty graph and input');
    parseAgentGraph(c.graph);
    if(!isAbsolute(c.outputPath)||!isAbsolute(c.projectRoot)||!isAbsolute(c.workspaceRoot) ||
      (c.sharedRoot!==undefined&&!isAbsolute(c.sharedRoot)) ||
      (c.globalRoot!==undefined&&!isAbsolute(c.globalRoot)))
      throw Error('Coordinator paths must be absolute');
  }
  const directory = options.storeDirectory ?? relayStoreDirectory();
  const projectRoot = await validateProjectRoot(resolve(options.projectRoot ?? options.coordinator?.projectRoot ?? process.cwd()), repositoryName);
  if (options.projectPath) resolveRepositoryProjectPath(projectRoot, options.projectPath);
  const githubRepo = options.githubRepo;
  if (githubRepo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepo)) throw new Error('githubRepo must be OWNER/REPO');
  const knownJobs = (await discoverLocalRelayStoreSnapshots(directory)).flatMap(snapshot => snapshot.jobs);
  const identityCollision = knownJobs.find(job => job.repository === repositoryName && job.projectRoot && job.projectRoot !== projectRoot);
  if (identityCollision) throw new Error(`Local repository identity collision ${repositoryName}: Job ${identityCollision.id} binds ${identityCollision.projectRoot}, requested ${projectRoot}`);
  const id = options.id || allocateEntityId(directory, repositoryName, 'job', options.idempotencyKey, new Set(knownJobs.map(job => job.id)));
  const requestedNumber = options.prNumber ?? 0;
  if (!Number.isInteger(requestedNumber) || requestedNumber < 0) throw new Error('Invalid external PR binding number');
  const placeholder: PullRequest = { number: requestedNumber, title: options.title ?? id,
    body: options.body ?? options.objective ?? '', state: 'OPEN', head: options.head ?? '', base: options.base ?? '' };
  const alreadyKnown = knownJobs.filter(job => job.id === id);
  if (alreadyKnown.length > 1) throw new Error('Duplicate immutable Job ID across SQLite stores: ' + id);
  if (alreadyKnown.length === 1) {
    const existing = alreadyKnown[0];
    if (existing.repository !== repositoryName || existing.projectRoot !== projectRoot || (options.prNumber !== undefined && existing.prNumber !== requestedNumber)) throw new Error('Immutable Job ID is already bound to a different local repository, project root, or external PR');
    if (!options.id && !options.idempotencyKey) throw new Error('Automatically allocated Job ID unexpectedly belongs to an existing Job');
    if (options.idempotencyKey && ((options.objective && options.objective !== existing.objective) || (options.projectPath && options.projectPath !== existing.projectPath) || (options.title && options.title !== existing.title))) throw new Error('Job idempotency key reused for a different Job definition');
    if(options.coordinator){const task=existing.tasks.find(task=>task.id==='coordinator');
      if(!task||task.agentGraph!==options.coordinator.graph||task.input!==options.coordinator.input||
         task.output?.kind!=='file'||task.output.path!==options.coordinator.outputPath||
         existing.graphStartContext?.projectPath!==options.coordinator.projectRoot)
        throw Error('Coordinator idempotency key reused for a different Graph or Run');
    }
    return { job: existing, pr: { ...placeholder, number: existing.prNumber } };
  }
  if (options.id && isGeneratedEntityId(id, repositoryName, 'job')) throw new Error('Reserved auto-generated Job ID cannot be assigned manually');
  const pr = placeholder;
  const number = pr.number;
  const local = openLocalManagedStore(repositoryName, number, {
    directory, jobId: id, noGitHub: true,
  });
  try {
    const existing = await local.relay.loadJob(id);
    if (existing) return { job: existing, pr };
    const now = new Date().toISOString();
    const localMergeSource = options.localMergeSource ?? (options.head ? `refs/heads/${options.head}` : undefined);
    if (options.localMergeTarget && options.localMergeTarget !== 'refs/heads/main') throw new Error('Local merge target must always be main');
    if (options.base && options.base !== 'main') throw new Error('Job base must always be main');
    const job = createJobEntity({
      id,
      title: options.title || pr.title || 'Agents Relay job',
      objective: options.objective || pr.body || undefined,
      projectPath: options.projectPath,
      projectRoot,
      ...(githubRepo ? { githubRepo } : {}),
      description: pr.body || undefined,
      priority: options.priority ?? 'P2',
      tag: options.tag,
      autoMerge: options.autoMerge ?? true,
      ...(localMergeSource ? { localMerge: { sourceRef: localMergeSource, targetRef: 'refs/heads/main', status: 'pending' as const } } : {}),
      reviewEnabled: options.reviewEnabled ?? true,
      ...(options.reviewerThreadId
        ? { reviewerThreadId: normalizeThreadId(options.reviewerThreadId, 'reviewer thread ID') }
        : {}),
      ...(options.creatorThreadId
        ? { creatorThreadId: normalizeThreadId(options.creatorThreadId, 'creator thread ID') }
        : {}),
      ...(options.implementationThreadId
        ? { implementationThreadId: normalizeThreadId(options.implementationThreadId, 'implementation thread ID') }
        : {}),
      prNumber: pr.number,
      repository: repositoryName,
      continuation: options.continuation ?? null,
      createdAt: now,
      updatedAt: now,
      tasks: [],
      ...(options.coordinator ? {graphStartContext:{projectPath:options.coordinator.projectRoot,
        workspaceRoot:options.coordinator.workspaceRoot,
        ...(options.coordinator.sharedRoot?{sharedRoot:options.coordinator.sharedRoot}:{}),
        ...(options.coordinator.globalRoot?{globalRoot:options.coordinator.globalRoot}:{}),
        noGitHub:options.noGitHub===true}} : {}),
    });
    if(options.coordinator){
      const c=options.coordinator;
      job.tasks.push(createTaskEntity(job,{jobId:id,id:'coordinator',title:'Coordinator',
        parentTaskId:null,kind:'work',agentGraph:c.graph,input:c.input,
        output:{kind:'file',path:c.outputPath},adapter:'codex',capabilities:[],
        dependencies:[],attempt:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,
        executionId:null,threadId:null,result:null,error:null,
        timeoutMs:taskOverallTimeoutMs('L'),createdAt:now,updatedAt:now}));
    }
    if (options.persist !== false) {
      if (local.store.createJobIfAbsent) await local.store.createJobIfAbsent(job);
      else await local.store.saveJob(job);
    }

    return { job: options.persist === false ? job : await local.store.load(id), pr };
  } finally {
    local.relay.close();
  }
}
