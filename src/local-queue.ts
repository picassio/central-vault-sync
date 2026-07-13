import { TFile, TFolder, normalizePath, type TAbstractFile, type Vault } from 'obsidian';
import {
  assertServerPathAllowed,
  isServerPathExcluded,
  type SyncOperation,
} from '@webobsidian/sync-core';
import { ObsidianSyncAdapter } from './obsidian-adapter';
import { PluginStore, type PendingPath } from './plugin-store';
import { ProtocolClient } from './protocol-client';
import type { OrderedSyncClient } from '@webobsidian/sync-core';

export class LocalMutationQueue {
  private timers = new Map<string, number>();
  constructor(
    private readonly vault: Vault,
    private readonly configDir: string,
    private readonly store: PluginStore,
    private readonly client: ProtocolClient,
    private readonly engine: OrderedSyncClient,
    private readonly adapter: ObsidianSyncAdapter,
    private readonly notice: (message: string) => void,
  ) {}

  async restore(): Promise<void> {
    for (const pending of [...this.store.state.pendingPaths]) this.schedule(pending, 0);
  }
  async observe(action: PendingPath['action'], file: TAbstractFile, oldPath?: string): Promise<void> {
    const path = normalizePath(file.path);
    if (path === this.configDir || path.startsWith(`${this.configDir}/`) || excluded(path, this.store.state.excludeGlobs)) return;
    const pending = { path, action, ...(oldPath ? { oldPath: normalizePath(oldPath) } : {}), observedAt: new Date().toISOString() };
    await this.store.queuePath(pending);
    this.schedule(pending, action === 'upsert' ? this.store.state.modifyDebounceMs : 0);
  }
  async flushAll(): Promise<void> {
    for (const handle of this.timers.values()) window.clearTimeout(handle);
    this.timers.clear();
    for (const pending of [...this.store.state.pendingPaths]) await this.flush(pending);
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
      void this.flush(pending).catch((error) => {
        this.notice(`Central Sync: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, delay));
  }

  private async flush(pending: PendingPath): Promise<void> {
    if (this.store.state.paused) return;
    assertServerPathAllowed(pending.path);
    let operation: SyncOperation | null = null;
    const clientSequence = await this.store.takeClientSequence();
    const idempotencyKey = `plugin-${clientSequence}-${randomId()}`;

    if (pending.action === 'delete') {
      const entry = this.store.entryByPath(pending.path);
      if (entry) operation = {
        operation: entry.kind === 'directory' ? 'rmdir' : 'delete', entryId: entry.entryId,
        baseRevision: entry.revision, clientSequence, idempotencyKey,
      };
    } else if (pending.action === 'rename') {
      const entry = pending.oldPath ? this.store.entryByPath(pending.oldPath) : null;
      if (entry) operation = {
        operation: 'rename', entryId: entry.entryId, baseRevision: entry.revision,
        path: pending.path, clientSequence, idempotencyKey,
      };
    } else {
      const file = this.vault.getAbstractFileByPath(pending.path);
      if (!file) {
        await this.store.removePendingPath(pending.path);
        return;
      }
      const entry = this.store.entryByPath(pending.path);
      if (file instanceof TFolder) {
        if (!entry) operation = { operation: 'mkdir', path: pending.path, kind: 'directory', clientSequence, idempotencyKey };
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
        operation = entry
          ? { operation: 'modify', entryId: entry.entryId, baseRevision: entry.revision, clientSequence, idempotencyKey, content: reference }
          : { operation: 'create', path: pending.path, kind: 'file', clientSequence, idempotencyKey, content: reference };
      }
    }
    if (operation) await this.engine.queue(operation);
    await this.store.removePendingPath(pending.path);
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
