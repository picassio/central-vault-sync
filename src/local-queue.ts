import { TFile, TFolder, normalizePath, type TAbstractFile, type Vault } from 'obsidian';
import {
  assertServerPathAllowed,
  isServerPathExcluded,
  type SyncOperation,
} from '@picassio/sync-core';
import { ObsidianSyncAdapter } from './obsidian-adapter';
import { PluginStore, samePendingPath, type PendingPath } from './plugin-store';
import { ProtocolClient } from './protocol-client';
import type { OrderedSyncClient } from '@picassio/sync-core';

const PREPARATION_CONCURRENCY = 4;
const CHECKPOINT_PATHS = 100;

export interface LocalQueueProgress {
  phase: 'scanning' | 'uploading';
  completedItems: number;
  totalItems: number;
  completedBytes: number;
  totalBytes: number;
}

type PreparedPath = {
  pending: PendingPath;
  bytes: number;
  operation: (clientSequence: number, idempotencyKey: string) => SyncOperation | null;
};

export class LocalMutationQueue {
  private timers = new Map<string, number>();
  private flushChain: Promise<void> = Promise.resolve();
  private activePreparations = 0;
  private preparationWaiters: Array<() => void> = [];
  constructor(
    private readonly vault: Vault,
    private readonly configDir: string,
    private readonly store: PluginStore,
    private readonly client: ProtocolClient,
    private readonly engine: OrderedSyncClient,
    private readonly adapter: ObsidianSyncAdapter,
    private readonly onError: (error: unknown) => void,
    private readonly onProgress: (progress: LocalQueueProgress) => void = () => {},
  ) {}

  async restore(): Promise<void> {
    for (const pending of [...this.store.state.pendingPaths]) this.schedule(pending, 0);
  }
  async observe(action: PendingPath['action'], file: TAbstractFile, oldPath?: string): Promise<void> {
    const path = normalizePath(file.path);
    if (this.isExcluded(path)) return;
    const pending = { path, action, ...(oldPath ? { oldPath: normalizePath(oldPath) } : {}), observedAt: new Date().toISOString() };
    await this.store.queuePath(pending);
    const queued = this.store.state.pendingPaths.find((item) => item.path === path) ?? pending;
    this.schedule(queued, queued.action === 'upsert' ? this.store.state.modifyDebounceMs : 0);
  }
  async reconcile(file: TAbstractFile): Promise<void> {
    const [pending] = await this.inspectLocal([file]);
    if (!pending) return;
    await this.store.queuePaths([pending], true);
    const queued = this.store.state.pendingPaths.find((item) => item.path === pending.path);
    if (queued) this.schedule(queued, 0);
  }
  async reconcileAll(files: TAbstractFile[]): Promise<void> {
    const included = files.filter((file) => !this.isExcluded(normalizePath(file.path)));
    const totalBytes = included.reduce((total, file) => total + fileSize(file), 0);
    let completedItems = 0;
    let completedBytes = 0;
    this.onProgress({ phase: 'scanning', completedItems, totalItems: included.length, completedBytes, totalBytes });
    const pendingByPath = new Map(this.store.state.pendingPaths.map((pending) => [pending.path, pending]));
    for (let offset = 0; offset < included.length; offset += CHECKPOINT_PATHS) {
      const checkpoint = included.slice(offset, offset + CHECKPOINT_PATHS);
      const inspected = await mapBounded(checkpoint, PREPARATION_CONCURRENCY, async (file) => {
        const [pending] = await this.inspectLocal([file], pendingByPath);
        completedItems += 1;
        completedBytes += fileSize(file);
        this.onProgress({ phase: 'scanning', completedItems, totalItems: included.length, completedBytes, totalBytes });
        return pending;
      });
      const changed = inspected.filter((pending): pending is PendingPath => Boolean(pending));
      await this.store.queuePaths(changed, true);
      for (const pending of changed) if (!pendingByPath.has(pending.path)) pendingByPath.set(pending.path, pending);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }
  async flushAll(): Promise<void> {
    for (const handle of this.timers.values()) window.clearTimeout(handle);
    this.timers.clear();
    const pending = [...this.store.state.pendingPaths];
    let completedItems = 0;
    let completedBytes = 0;
    const totalBytes = pending.reduce((total, item) => {
      const target = this.vault.getAbstractFileByPath(item.path);
      return total + (target ? fileSize(target) : 0);
    }, 0);
    this.onProgress({ phase: 'uploading', completedItems, totalItems: pending.length, completedBytes, totalBytes });
    for (let offset = 0; offset < pending.length; offset += CHECKPOINT_PATHS) {
      const checkpoint = pending.slice(offset, offset + CHECKPOINT_PATHS);
      const currentByPath = new Map(this.store.state.pendingPaths.map((item) => [item.path, item]));
      const prepared = await mapBounded(checkpoint, PREPARATION_CONCURRENCY, async (item) => {
        const result = await this.prepareBounded(item, currentByPath.get(item.path));
        completedItems += 1;
        completedBytes += result?.bytes ?? 0;
        this.onProgress({ phase: 'uploading', completedItems, totalItems: pending.length, completedBytes, totalBytes });
        return result;
      });
      await this.commit(prepared.filter((item): item is PreparedPath => Boolean(item)));
      // Blob bytes are released after each bounded checkpoint. Durable operation descriptors contain only
      // hashes/references and remain queued so the publishing phase can report real server acknowledgements.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }
  dispose(): void {
    for (const handle of this.timers.values()) window.clearTimeout(handle);
    this.timers.clear();
  }

  private schedule(pending: PendingPath, delay: number): void {
    const prior = this.timers.get(pending.path);
    if (prior !== undefined) window.clearTimeout(prior);
    this.timers.set(pending.path, window.setTimeout(() => {
      this.timers.delete(pending.path);
      void this.runFlush(pending).catch((error) => { this.onError(error); });
    }, delay));
  }

  private runFlush(pending: PendingPath): Promise<void> {
    const result = this.flushChain.then(async () => {
      const prepared = await this.prepareBounded(pending);
      if (prepared) await this.commit([prepared]);
      await this.engine.flush();
    });
    this.flushChain = result.catch(() => undefined);
    return result;
  }

  private async inspectLocal(
    files: TAbstractFile[],
    pendingByPath?: ReadonlyMap<string, PendingPath>,
  ): Promise<Array<PendingPath | null>> {
    return Promise.all(files.map(async (file) => {
      const path = normalizePath(file.path);
      if (this.isExcluded(path)) return null;
      const pending = pendingByPath
        ? pendingByPath.get(path)
        : this.store.state.pendingPaths.find((item) => item.path === path);
      if (pending) return pending;
      const entry = this.store.entryByPath(path);
      if (file instanceof TFolder) {
        if (entry?.kind === 'directory') return null;
        if (entry) throw new Error(`local path kind differs from server projection: ${path}`);
      } else if (file instanceof TFile && entry) {
        if (entry.kind !== 'file') throw new Error(`local path kind differs from server projection: ${path}`);
        if ((await this.adapter.hashFile(file, false)).hash === entry.hash) return null;
      }
      return { path, action: 'upsert', observedAt: new Date().toISOString() };
    }));
  }

  private async prepareBounded(pending: PendingPath, expectedCurrent?: PendingPath): Promise<PreparedPath | null> {
    if (this.activePreparations < PREPARATION_CONCURRENCY) this.activePreparations += 1;
    else await new Promise<void>((resolve) => { this.preparationWaiters.push(resolve); });
    try { return await this.prepare(pending, expectedCurrent); }
    finally {
      const next = this.preparationWaiters.shift();
      if (next) next();
      else this.activePreparations -= 1;
    }
  }

  private async prepare(pending: PendingPath, expectedCurrent?: PendingPath): Promise<PreparedPath | null> {
    const current = expectedCurrent ?? this.store.state.pendingPaths.find((item) => item.path === pending.path);
    if (!current || !samePendingPath(current, pending) || this.store.state.paused) return null;
    assertServerPathAllowed(pending.path);

    if (pending.action === 'delete') {
      const entry = this.store.entryByPath(pending.path);
      return {
        pending, bytes: 0,
        operation: (clientSequence, idempotencyKey) => entry ? {
          operation: entry.kind === 'directory' ? 'rmdir' : 'delete', entryId: entry.entryId,
          baseRevision: entry.revision, clientSequence, idempotencyKey,
        } : null,
      };
    }
    if (pending.action === 'rename') {
      const entry = pending.oldPath ? this.store.entryByPath(pending.oldPath) : null;
      return {
        pending, bytes: 0,
        operation: (clientSequence, idempotencyKey) => !entry ? null : pending.followUpAction === 'delete'
          ? {
              operation: entry.kind === 'directory' ? 'rmdir' : 'delete', entryId: entry.entryId,
              baseRevision: entry.revision, clientSequence, idempotencyKey,
            }
          : {
              operation: 'rename', entryId: entry.entryId, baseRevision: entry.revision,
              path: pending.path, clientSequence, idempotencyKey,
            },
      };
    }

    const file = this.vault.getAbstractFileByPath(pending.path);
    if (!file) return { pending, bytes: 0, operation: () => null };
    const entry = this.store.entryByPath(pending.path)
      ?? (pending.oldPath ? this.store.entryByPath(pending.oldPath) : null);
    if (file instanceof TFolder) {
      return {
        pending, bytes: 0,
        operation: (clientSequence, idempotencyKey) => entry ? null
          : { operation: 'mkdir', path: pending.path, kind: 'directory', clientSequence, idempotencyKey },
      };
    }
    if (!(file instanceof TFile)) return { pending, bytes: 0, operation: () => null };

    const content = await this.adapter.hashFile(file);
    if (await this.adapter.consumeExpected(pending.path, content.hash) || entry?.hash === content.hash) {
      return { pending, bytes: content.size, operation: () => null };
    }
    const reference = content.size === 0
      ? { hash: content.hash, size: 0, inlineText: '' }
      : { hash: content.hash, size: content.size, blobHash: content.hash };
    if (content.size > 0) {
      const bytes = content.bytes ?? new TextEncoder().encode(content.text).slice().buffer;
      await this.client.upload(bytes, content.hash);
    }
    return {
      pending, bytes: content.size,
      operation: (clientSequence, idempotencyKey) => entry
        ? { operation: 'modify', entryId: entry.entryId, baseRevision: entry.revision, clientSequence, idempotencyKey, content: reference }
        : { operation: 'create', path: pending.path, kind: 'file', clientSequence, idempotencyKey, content: reference },
    };
  }

  private async commit(prepared: PreparedPath[]): Promise<void> {
    const committed = await this.store.commitPreparedPaths(prepared);
    for (const pending of committed) if (pending.action === 'rename') await this.queueRenameFollowUp(pending);
  }

  private async queueRenameFollowUp(pending: PendingPath): Promise<void> {
    if (pending.followUpAction === 'delete') return;
    const file = this.vault.getAbstractFileByPath(pending.path);
    const action = pending.followUpAction ?? (file instanceof TFile ? 'upsert' : null);
    if (!action) return;
    const followUp: PendingPath = {
      path: pending.path, action,
      ...(action === 'upsert' && pending.oldPath ? { oldPath: pending.oldPath } : {}),
      observedAt: new Date().toISOString(),
    };
    await this.store.queuePath(followUp);
    const queued = this.store.state.pendingPaths.find((item) => item.path === followUp.path) ?? followUp;
    this.schedule(queued, action === 'upsert' ? this.store.state.modifyDebounceMs : 0);
  }

  private isExcluded(path: string): boolean {
    return path === this.configDir || path.startsWith(`${this.configDir}/`) || excluded(path, this.store.state.excludeGlobs);
  }
}

async function mapBounded<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && failure === undefined) {
      const index = next;
      next += 1;
      try { results[index] = await task(items[index]!); }
      catch (error) { failure = error; }
    }
  }));
  if (failure !== undefined) throw failure instanceof Error
    ? failure
    : new Error(typeof failure === 'string' ? failure : 'bounded task failed');
  return results;
}
function fileSize(file: TAbstractFile): number {
  return file instanceof TFile && Number.isFinite(file.stat?.size) ? Math.max(0, file.stat.size) : 0;
}
function excluded(path: string, globs: string[]): boolean {
  if (isServerPathExcluded(path)) return true;
  return globs.some((glob) => globRegex(glob).test(path));
}
function globRegex(glob: string): RegExp {
  let pattern = '';
  const normalized = glob.normalize('NFC');
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === '*' && normalized[index + 1] === '*') { pattern += '.*'; index += 1; }
    else if (character === '*') pattern += '[^/]*';
    else if (character === '?') pattern += '[^/]';
    else pattern += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`, 'u');
}
