import assert from 'node:assert/strict';
import { setTimeout as nodeSetTimeout } from 'node:timers';
import test from 'node:test';
import { TFile } from 'obsidian';
import { LocalMutationQueue } from '../src/local-queue';
import { PluginStore, type PendingPath, type PluginState } from '../src/plugin-store';
import type { SyncEntry, SyncOperation } from '@webobsidian/sync-core';

test('concurrent file uploads cannot overtake reserved client sequences', async () => {
  const first = Object.assign(new TFile(), { path: 'A.md', name: 'A.md', extension: 'md' });
  const second = Object.assign(new TFile(), { path: 'B.md', name: 'B.md', extension: 'md' });
  const files = new Map([[first.path, first], [second.path, second]]);
  const state = {
    paused: false, modifyDebounceMs: 0, excludeGlobs: [], pendingPaths: [], operations: [],
    nextClientSequence: 1,
  } as unknown as PluginState;
  const store = {
    state,
    async queuePath(pending: PendingPath) { state.pendingPaths = [...state.pendingPaths.filter((item) => item.path !== pending.path), pending]; },
    async removePendingPath(path: string) { state.pendingPaths = state.pendingPaths.filter((item) => item.path !== path); },
    async takeClientSequence() { const value = state.nextClientSequence; state.nextClientSequence += 1; return value; },
    entryByPath() { return null; },
  };
  let releaseFirst!: () => void; let markFirstStarted!: () => void;
  const firstUpload = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const hashes = { 'A.md': 'a'.repeat(64), 'B.md': 'b'.repeat(64) };
  const uploads: string[] = [];
  const client = {
    async upload(_bytes: ArrayBuffer, hash: string) {
      uploads.push(hash);
      if (hash === hashes['A.md']) { markFirstStarted(); await firstUpload; }
    },
  };
  const queued: SyncOperation[] = [];
  const engine = { async queue(operation: SyncOperation) { queued.push(operation); } };
  const adapter = {
    async hashFile(file: TFile) {
      const hash = hashes[file.path as keyof typeof hashes];
      return { hash, size: 1, bytes: new Uint8Array([file.path === 'A.md' ? 1 : 2]).buffer };
    },
    async consumeExpected() { return false; },
  };
  const queue = new LocalMutationQueue(
    { getAbstractFileByPath: (path: string) => files.get(path) ?? null } as never,
    '.config-test', store as never, client as never, engine as never, adapter as never, () => {},
  );

  await queue.observe('upsert', first);
  await queue.observe('upsert', second);
  await firstStarted;
  assert.equal(state.nextClientSequence, 1, 'a sequence is reserved only after its upload succeeds');
  assert.deepEqual(uploads, [hashes['A.md']], 'second path must wait while the first upload is pending');
  assert.equal(queued.length, 0);

  releaseFirst();
  await waitFor(() => queued.length === 2);
  assert.deepEqual(queued.map((operation) => operation.clientSequence), [1, 2]);
  assert.deepEqual(queued.map((operation) => 'path' in operation ? operation.path : ''), ['A.md', 'B.md']);
  assert.deepEqual(state.pendingPaths, []);
});

test('rename event bursts preserve identity and rehash destination content in sequence order', async () => {
  const oldHash = '1'.repeat(64); const newHash = '2'.repeat(64);
  const file = Object.assign(new TFile(), { path: 'New.md', name: 'New.md', extension: 'md' });
  const files = new Map([[file.path, file]]);
  const store = await projectedStore(projectedEntry('Old.md', oldHash));
  store.state.modifyDebounceMs = 0;
  const queued: SyncOperation[] = [];
  const queue = new LocalMutationQueue(
    { getAbstractFileByPath: (path: string) => files.get(path) ?? null } as never, '.config-test', store,
    { upload: async () => {} } as never, { queue: async (operation: SyncOperation) => { queued.push(operation); } } as never,
    { hashFile: async () => ({ hash: newHash, size: 1, bytes: new Uint8Array([2]).buffer }), consumeExpected: async () => false } as never,
    () => {},
  );

  await queue.observe('rename', file, 'Old.md');
  await queue.observe('upsert', file);
  await waitFor(() => queued.length === 2);
  assert.deepEqual(queued.map((operation) => operation.operation), ['rename', 'modify']);
  assert.deepEqual(queued.map((operation) => operation.clientSequence), [1, 2]);
  assert.equal('entryId' in queued[1]! ? queued[1].entryId : null, 'entry_rename_burst');
  assert.equal(store.state.pendingPaths.length, 0);
});

test('rename immediately followed by delete collapses to deletion of the original identity', async () => {
  const file = Object.assign(new TFile(), { path: 'Transient.md', name: 'Transient.md', extension: 'md' });
  const files = new Map([[file.path, file]]);
  const store = await projectedStore(projectedEntry('Original.md', '3'.repeat(64)));
  store.state.modifyDebounceMs = 0;
  const queued: SyncOperation[] = [];
  const queue = new LocalMutationQueue(
    { getAbstractFileByPath: (path: string) => files.get(path) ?? null } as never, '.config-test', store,
    { upload: async () => {} } as never, { queue: async (operation: SyncOperation) => { queued.push(operation); } } as never,
    { hashFile: async () => ({ hash: '3'.repeat(64), size: 1, bytes: new Uint8Array([3]).buffer }), consumeExpected: async () => false } as never,
    () => {},
  );

  await queue.observe('rename', file, 'Original.md');
  files.delete(file.path);
  await queue.observe('delete', file);
  await waitFor(() => queued.length === 1);
  assert.equal(queued[0]?.operation, 'delete');
  assert.equal('entryId' in queued[0] ? queued[0].entryId : null, 'entry_rename_burst');
  assert.equal(store.state.pendingPaths.length, 0);
});

test('startup reconciliation does not persist or sequence unchanged projected files', async () => {
  const file = Object.assign(new TFile(), { path: 'Stable.md', name: 'Stable.md', extension: 'md' });
  const hash = 'd'.repeat(64);
  const state = {
    paused: false, modifyDebounceMs: 10_000, excludeGlobs: [], pendingPaths: [], operations: [],
    nextClientSequence: 1,
    entries: [{ entryId: 'entry_stable_projected', path: 'Stable.md', kind: 'file', revision: 1, hash, size: 1,
      modifiedAt: '2026-07-13T00:00:00.000Z', deleted: false, sequence: 1 }],
  } as unknown as PluginState;
  let queueWrites = 0;
  const store = {
    state,
    async queuePath(pending: PendingPath) { queueWrites += 1; state.pendingPaths = [pending]; },
    async removePendingPath(path: string) { state.pendingPaths = state.pendingPaths.filter((item) => item.path !== path); },
    async takeClientSequence() { const value = state.nextClientSequence; state.nextClientSequence += 1; return value; },
    entryByPath(path: string) { return state.entries.find((entry) => !entry.deleted && entry.path === path) ?? null; },
  };
  let localHash = hash;
  const queue = new LocalMutationQueue(
    { getAbstractFileByPath: () => file } as never, '.config-test', store as never,
    { upload: async () => {} } as never, { queue: async () => {} } as never,
    { hashFile: async () => ({ hash: localHash, size: 1, bytes: new Uint8Array([1]).buffer }), consumeExpected: async () => false } as never,
    () => {},
  );

  await queue.reconcile(file);
  assert.equal(queueWrites, 0);
  assert.equal(state.nextClientSequence, 1);
  assert.equal(state.pendingPaths.length, 0);

  localHash = 'e'.repeat(64);
  await queue.reconcile(file);
  assert.equal(queueWrites, 1);
  assert.equal(state.pendingPaths[0]?.path, 'Stable.md');
  assert.equal(state.nextClientSequence, 1);
  queue.dispose();
});

test('runtime upload failure reports offline work without consuming its sequence or marker', async () => {
  const file = Object.assign(new TFile(), { path: 'Offline.md', name: 'Offline.md', extension: 'md' });
  const state = {
    paused: false, modifyDebounceMs: 0, excludeGlobs: [], pendingPaths: [], operations: [],
    nextClientSequence: 1,
  } as unknown as PluginState;
  const store = {
    state,
    async queuePath(pending: PendingPath) { state.pendingPaths = [pending]; },
    async removePendingPath(path: string) { state.pendingPaths = state.pendingPaths.filter((item) => item.path !== path); },
    async takeClientSequence() { const value = state.nextClientSequence; state.nextClientSequence += 1; return value; },
    entryByPath() { return null; },
  };
  let reportError!: (error: unknown) => void;
  const reported = new Promise<unknown>((resolve) => { reportError = resolve; });
  const queue = new LocalMutationQueue(
    { getAbstractFileByPath: () => file } as never,
    '.config-test', store as never,
    { upload: async () => { throw new Error('network unavailable'); } } as never,
    { queue: async () => { throw new Error('operation must not be queued'); } } as never,
    { hashFile: async () => ({ hash: 'c'.repeat(64), size: 1, bytes: new Uint8Array([1]).buffer }), consumeExpected: async () => false } as never,
    reportError,
  );

  await queue.observe('upsert', file);
  const error = await reported;
  assert.match(error instanceof Error ? error.message : '', /network unavailable/);
  assert.equal(state.nextClientSequence, 1);
  assert.equal(state.operations.length, 0);
  assert.equal(state.pendingPaths.length, 1);
  assert.equal(state.pendingPaths[0]?.path, 'Offline.md');
});

function projectedEntry(path: string, hash: string): SyncEntry {
  return {
    entryId: 'entry_rename_burst', path, kind: 'file', revision: 1, hash, size: 1,
    modifiedAt: '2026-07-13T00:00:00.000Z', deleted: false, sequence: 1,
  };
}
async function projectedStore(entry: SyncEntry): Promise<PluginStore> {
  const store = new PluginStore({
    app: { secretStorage: { getSecret: () => null, setSecret: () => {} } },
    loadData: async () => null, saveData: async () => {},
  } as never);
  await store.load();
  await store.replaceEntries([entry]);
  return store;
}

async function waitFor(check: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => nodeSetTimeout(resolve, 5));
  }
  throw new Error('condition timed out');
}
