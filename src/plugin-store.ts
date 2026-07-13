import type { Plugin } from 'obsidian';
import type {
  ClientApplyIntent,
  ClientDeviceIdentity,
  SyncClientPersistence,
  SyncEntry,
  SyncOperation,
} from '@webobsidian/sync-core';

export interface PendingPath {
  path: string;
  action: 'upsert' | 'rename' | 'delete';
  oldPath?: string;
  followUpAction?: 'upsert' | 'delete';
  observedAt: string;
}
export interface PluginState {
  schemaVersion: 1;
  serverUrl: string;
  deviceId: string | null;
  deviceName: string;
  vaultId: string | null;
  cursor: number;
  nextClientSequence: number;
  paused: boolean;
  fallbackPollSeconds: number;
  modifyDebounceMs: number;
  mobileLargeFileMiB: number;
  excludeGlobs: string[];
  operations: SyncOperation[];
  applyIntents: ClientApplyIntent[];
  entries: SyncEntry[];
  pendingPaths: PendingPath[];
  lastError: string | null;
}

export const DEFAULT_STATE: PluginState = {
  schemaVersion: 1,
  serverUrl: '', deviceId: null, deviceName: 'Obsidian', vaultId: null,
  cursor: 0, nextClientSequence: 1, paused: false,
  fallbackPollSeconds: 15, modifyDebounceMs: 750, mobileLargeFileMiB: 100,
  excludeGlobs: [], operations: [], applyIntents: [], entries: [], pendingPaths: [], lastError: null,
};

export class PluginStore implements SyncClientPersistence {
  state: PluginState = structuredClone(DEFAULT_STATE);
  private writes: Promise<void> = Promise.resolve();
  private readonly entriesByPath = new Map<string, SyncEntry>();
  private readonly entriesById = new Map<string, SyncEntry>();
  private readonly entryPositions = new Map<string, number>();
  private readonly secretId = 'central-vault-sync-token';
  constructor(private readonly plugin: Plugin) {}

  async load(): Promise<void> {
    const loaded = await this.plugin.loadData() as Partial<PluginState> | null;
    this.state = { ...structuredClone(DEFAULT_STATE), ...(loaded ?? {}), schemaVersion: 1 };
    this.state.operations ??= [];
    this.state.applyIntents ??= [];
    this.state.entries ??= [];
    this.state.pendingPaths ??= [];
    this.rebuildEntryIndexes();
  }
  async save(): Promise<void> {
    const snapshot = structuredClone(this.state);
    const write = this.writes.then(() => this.plugin.saveData(snapshot));
    this.writes = write.catch(() => undefined);
    return write;
  }
  async update(mutator: (state: PluginState) => void): Promise<void> {
    const entries = this.state.entries;
    mutator(this.state);
    if (this.state.entries !== entries) this.rebuildEntryIndexes();
    await this.save();
  }

  async getDevice(): Promise<(ClientDeviceIdentity & { token: string; vaultId: string }) | null> {
    const token = this.plugin.app.secretStorage.getSecret(this.secretId);
    if (!token || !this.state.deviceId || !this.state.vaultId) return null;
    return {
      deviceId: this.state.deviceId, deviceName: this.state.deviceName,
      token, vaultId: this.state.vaultId, cursor: this.state.cursor,
    };
  }
  setToken(token: string): void { this.plugin.app.secretStorage.setSecret(this.secretId, token); }
  clearToken(): void { this.plugin.app.secretStorage.setSecret(this.secretId, ''); }

  async putCursor(cursor: number) {
    if (cursor < this.state.cursor) throw new Error('cursor cannot move backwards');
    await this.update((state) => { state.cursor = cursor; });
  }
  async takeClientSequence(): Promise<number> {
    const sequence = this.state.nextClientSequence;
    await this.update((state) => { state.nextClientSequence = sequence + 1; });
    return sequence;
  }
  async operations() { return [...this.state.operations]; }
  async putOperation(operation: SyncOperation) {
    await this.update((state) => {
      const existing = state.operations.find((item) => item.idempotencyKey === operation.idempotencyKey);
      if (!existing) state.operations.push(operation);
      else if (JSON.stringify(existing) !== JSON.stringify(operation)) throw new Error('idempotency key payload changed');
    });
  }
  async removeOperation(idempotencyKey: string) {
    await this.update((state) => { state.operations = state.operations.filter((item) => item.idempotencyKey !== idempotencyKey); });
  }
  async putApplyIntent(intent: ClientApplyIntent) {
    await this.update((state) => {
      state.applyIntents = [...state.applyIntents.filter((item) => item.event.eventId !== intent.event.eventId), intent];
    });
  }
  async removeApplyIntent(eventId: string) {
    await this.update((state) => { state.applyIntents = state.applyIntents.filter((item) => item.event.eventId !== eventId); });
  }
  async applyIntents() { return [...this.state.applyIntents]; }

  entryByPath(path: string): SyncEntry | null { return this.entriesByPath.get(path) ?? null; }
  entryById(entryId: string): SyncEntry | null { return this.entriesById.get(entryId) ?? null; }
  async replaceEntries(entries: SyncEntry[]) { await this.update((state) => { state.entries = entries; }); }
  async putEntry(entry: SyncEntry) {
    const prior = this.entriesById.get(entry.entryId);
    const position = this.entryPositions.get(entry.entryId);
    if (position === undefined) {
      this.entryPositions.set(entry.entryId, this.state.entries.length);
      this.state.entries.push(entry);
    } else this.state.entries[position] = entry;
    if (prior && this.entriesByPath.get(prior.path)?.entryId === prior.entryId) this.entriesByPath.delete(prior.path);
    this.entriesById.set(entry.entryId, entry);
    if (!entry.deleted) this.entriesByPath.set(entry.path, entry);
    await this.save();
  }
  async queuePath(pending: PendingPath) {
    await this.update((state) => {
      const existing = state.pendingPaths.find((item) => item.path === pending.path);
      const merged = existing?.action === 'rename' && pending.action !== 'rename'
        ? {
            ...existing,
            observedAt: pending.observedAt,
            ...(pending.action === 'delete' ? { followUpAction: 'delete' as const } : {}),
          }
        : pending;
      state.pendingPaths = [...state.pendingPaths.filter((item) => item.path !== pending.path), merged];
    });
  }
  async removePendingPath(path: string) {
    await this.update((state) => { state.pendingPaths = state.pendingPaths.filter((item) => item.path !== path); });
  }

  private rebuildEntryIndexes(): void {
    this.entriesByPath.clear(); this.entriesById.clear(); this.entryPositions.clear();
    for (let index = 0; index < this.state.entries.length; index += 1) {
      const entry = this.state.entries[index]!;
      this.entriesById.set(entry.entryId, entry);
      this.entryPositions.set(entry.entryId, index);
      if (!entry.deleted) this.entriesByPath.set(entry.path, entry);
    }
  }
}
