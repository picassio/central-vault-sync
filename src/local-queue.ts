import { TFile, TFolder, normalizePath, type TAbstractFile, type Vault } from 'obsidian';
import {
  assertServerPathAllowed,
  isServerPathExcluded,
  type SyncOperation,
} from '@picassio/sync-core';
import { ObsidianSyncAdapter } from './obsidian-adapter';
import { PluginStore, type PendingPath } from './plugin-store';
import { ProtocolClient } from './protocol-client';
import type { OrderedSyncClient } from '@picassio/sync-core';

export class LocalMutationQueue {
  private timers = new Map<string, number>();
  private flushChain: Promise<void> = Promise.resolve();
  constructor(
    private readonly vault: Vault,
    private readonly configDir: string,
    private readonly store: PluginStore,
    private readonly client: ProtocolClient,
    private readonly engine: OrderedSyncClient,
    private readonly adapter: ObsidianSyncAdapter,
    private readonly onError: (error: unknown) => void,
  ) {}

  async restore(): Promise<void> {
    for (const pending of [...this.store.state.pendingPaths]) this.schedule(pending, 0);
  }
  async observe(action: PendingPath['action'], file: TAbstractFile, oldPath?: string): Promise<void> {
    const path = normalizePath(file.path);
    if (path === this.configDir || path.startsWith(`${this.configDir}/`) || excluded(path, this.store.state.excludeGlobs)) return;
    const pending = { path, action, ...(oldPath ? { oldPath: normalizePath(oldPath) } : {}), observedAt: new Date().toISOString() };
    await this.store.queuePath(pending);
    const queued = this.store.state.pendingPaths.find((item) => item.path === path) ?? pending;
    this.schedule(queued, queued.action === 'upsert' ? this.store.state.modifyDebounceMs : 0);
  }
  async reconcile(file: TAbstractFile): Promise<void> {
    const path = normalizePath(file.path);
    if (path === this.configDir || path.startsWith(`${this.configDir}/`) || excluded(path, this.store.state.excludeGlobs)) return;
    const pending = this.store.state.pendingPaths.find((item) => item.path === path);
    if (pending) { this.schedule(pending, 0); return; }
    const entry = this.store.entryByPath(path);
    if (file instanceof TFolder) {
      if (entry?.kind === 'directory') return;
      if (entry) throw new Error(`local path kind differs from server projection: ${path}`);
    } else if (file instanceof TFile && entry) {
      if (entry.kind !== 'file') throw new Error(`local path kind differs from server projection: ${path}`);
      if ((await this.adapter.hashFile(file)).hash === entry.hash) return;
    }
    await this.observe('upsert', file);
  }
  async flushAll(): Promise<void> {
    for (const handle of this.timers.values()) window.clearTimeout(handle);
    this.timers.clear();
    for (const pending of [...this.store.state.pendingPaths]) await this.runFlush(pending);
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
    const result = this.flushChain.then(() => this.flush(pending));
    this.flushChain = result.catch(() => undefined);
    return result;
  }

  private async flush(pending: PendingPath): Promise<void> {
    const current = this.store.state.pendingPaths.find((item) => item.path === pending.path);
    if (!current || current.observedAt !== pending.observedAt || current.action !== pending.action || current.oldPath !== pending.oldPath) return;
    if (this.store.state.paused) return;
    assertServerPathAllowed(pending.path);
    let operation: SyncOperation | null = null;

    if (pending.action === 'delete') {
      const entry = this.store.entryByPath(pending.path);
      if (entry) {
        const { clientSequence, idempotencyKey } = await this.operationIdentity();
        operation = {
          operation: entry.kind === 'directory' ? 'rmdir' : 'delete', entryId: entry.entryId,
          baseRevision: entry.revision, clientSequence, idempotencyKey,
        };
      }
    } else if (pending.action === 'rename') {
      const entry = pending.oldPath ? this.store.entryByPath(pending.oldPath) : null;
      if (entry) {
        const { clientSequence, idempotencyKey } = await this.operationIdentity();
        operation = pending.followUpAction === 'delete'
          ? {
              operation: entry.kind === 'directory' ? 'rmdir' : 'delete', entryId: entry.entryId,
              baseRevision: entry.revision, clientSequence, idempotencyKey,
            }
          : {
              operation: 'rename', entryId: entry.entryId, baseRevision: entry.revision,
              path: pending.path, clientSequence, idempotencyKey,
            };
      }
    } else {
      const file = this.vault.getAbstractFileByPath(pending.path);
      if (!file) {
        await this.store.removePendingPath(pending.path);
        return;
      }
      const entry = this.store.entryByPath(pending.path)
        ?? (pending.oldPath ? this.store.entryByPath(pending.oldPath) : null);
      if (file instanceof TFolder) {
        if (!entry) {
          const { clientSequence, idempotencyKey } = await this.operationIdentity();
          operation = { operation: 'mkdir', path: pending.path, kind: 'directory', clientSequence, idempotencyKey };
        }
      } else if (file instanceof TFile) {
        const content = await this.adapter.hashFile(file);
        if (await this.adapter.consumeExpected(pending.path, content.hash)) {
          await this.store.removePendingPath(pending.path);
          return;
        }
        if (entry?.hash === content.hash) {
          await this.store.removePendingPath(pending.path);
          return;
        }
        const reference = content.size === 0
          ? { hash: content.hash, size: 0, inlineText: '' }
          : { hash: content.hash, size: content.size, blobHash: content.hash };
        if (content.size > 0) {
          const bytes = content.bytes ?? new TextEncoder().encode(content.text).slice().buffer;
          await this.client.upload(bytes, content.hash);
        }
        const { clientSequence, idempotencyKey } = await this.operationIdentity();
        operation = entry
          ? { operation: 'modify', entryId: entry.entryId, baseRevision: entry.revision, clientSequence, idempotencyKey, content: reference }
          : { operation: 'create', path: pending.path, kind: 'file', clientSequence, idempotencyKey, content: reference };
      }
    }
    if (operation) await this.engine.queue(operation);
    await this.store.removePendingPath(pending.path);
    if (pending.action === 'rename') await this.queueRenameFollowUp(pending);
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

  private async operationIdentity(): Promise<{ clientSequence: number; idempotencyKey: string }> {
    const clientSequence = await this.store.takeClientSequence();
    return { clientSequence, idempotencyKey: `plugin-${clientSequence}-${randomId()}` };
  }
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
function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}
