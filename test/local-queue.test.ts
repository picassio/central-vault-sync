import assert from 'node:assert/strict';
import test from 'node:test';
import { TFile, TFolder } from 'obsidian';
import { LocalMutationQueue } from '../src/local-queue';
import { PluginStore, type PendingPath } from '../src/plugin-store';
import { sha256Text, type SyncEntry } from '@picassio/sync-core';

function fakeStore() {
  const writes: unknown[] = [];
  const store = new PluginStore({
    app: { secretStorage: { getSecret: () => null, setSecret: () => {} } },
    loadData: async () => null,
    saveData: async (value: unknown) => { writes.push(structuredClone(value)); },
  } as never);
  return { store, writes };
}
function file(path: string, size = 1): TFile {
  return Object.assign(new TFile(), { path, name: path.split('/').at(-1), extension: 'md', stat: { size } });
}
function queueHarness(options: {
  files: Map<string, TFile | TFolder>;
  store: PluginStore;
  upload?: (bytes: ArrayBuffer, hash: string) => Promise<void>;
  hash?: (file: TFile, includeContent?: boolean) => Promise<{ hash: string; size: number; bytes: ArrayBuffer }>;
  onError?: (error: unknown) => void;
  onProgress?: ConstructorParameters<typeof LocalMutationQueue>[7];
  engineFlush?: () => Promise<void>;
}) {
  return new LocalMutationQueue(
    { getAbstractFileByPath: (path: string) => options.files.get(path) ?? null } as never,
    '.config-test', options.store,
    { upload: options.upload ?? (async () => {}) } as never,
    { flush: options.engineFlush ?? (async () => {}) } as never,
    {
      hashFile: options.hash ?? (async (target: TFile) => ({
        hash: sha256Text(target.path), size: target.stat.size, bytes: new Uint8Array(target.stat.size).buffer,
      })),
      consumeExpected: async () => false,
    } as never,
    options.onError ?? (() => {}),
    options.onProgress,
  );
}

test('initial preparation uses at most four uploads and allocates operations in deterministic path order', async () => {
  const { store } = fakeStore();
  await store.load();
  store.state.modifyDebounceMs = 10_000;
  const files = new Map(Array.from({ length: 12 }, (_, index) => {
    const target = file(`Note-${String(index).padStart(2, '0')}.md`);
    return [target.path, target] as const;
  }));
  let active = 0; let maximum = 0;
  const queue = queueHarness({
    files, store,
    upload: async () => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 2));
      active -= 1;
    },
  });

  await queue.reconcileAll([...files.values()]);
  await queue.flushAll();

  assert.equal(maximum, 4);
  assert.deepEqual(store.state.operations.map((operation) => operation.clientSequence), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.deepEqual(store.state.operations.map((operation) => 'path' in operation ? operation.path : null), [...files.keys()]);
  assert.equal(store.state.pendingPaths.length, 0);
  queue.dispose();
});

test('changed bootstrap checkpoints durable operations without publishing during the uploading phase', async () => {
  const { store } = fakeStore();
  await store.load();
  const files = new Map(Array.from({ length: 201 }, (_, index) => {
    const target = file(`Checkpoint-${String(index).padStart(3, '0')}.md`);
    return [target.path, target] as const;
  }));
  let flushes = 0;
  const queue = queueHarness({ files, store, engineFlush: async () => { flushes += 1; } });

  await queue.reconcileAll([...files.values()]);
  await queue.flushAll();

  assert.equal(flushes, 0);
  assert.equal(store.state.operations.length, 201);
  assert.equal(store.state.pendingPaths.length, 0);
  queue.dispose();
});

test('10k unchanged synthetic vault performs no pending-path persistence, operation allocation, or upload', async () => {
  const { store, writes } = fakeStore();
  await store.load();
  const entries: SyncEntry[] = Array.from({ length: 10_000 }, (_, index) => ({
    entryId: `entry_large_${index}`, path: `Large/Note-${index}.md`, kind: 'file', revision: 1,
    hash: sha256Text(`body-${index}`), size: 10, modifiedAt: '2026-07-16T00:00:00.000Z', deleted: false, sequence: index + 1,
  }));
  await store.replaceEntries(entries);
  writes.length = 0;
  const files = new Map(entries.map((entry, index) => {
    const target = file(entry.path, 10);
    return [target.path, target] as const;
  }));
  let uploads = 0; let activeHashes = 0; let maximumHashes = 0;
  const queue = queueHarness({
    files, store,
    upload: async () => { uploads += 1; },
    hash: async (target) => {
      activeHashes += 1; maximumHashes = Math.max(maximumHashes, activeHashes);
      await Promise.resolve();
      activeHashes -= 1;
      const index = Number(target.path.match(/(\d+)\.md$/u)?.[1]);
      return { hash: sha256Text(`body-${index}`), size: 10, bytes: new Uint8Array(10).buffer };
    },
  });

  await queue.reconcileAll([...files.values()]);

  assert.equal(writes.length, 0);
  assert.equal(store.state.pendingPaths.length, 0);
  assert.equal(store.state.operations.length, 0);
  assert.equal(store.state.nextClientSequence, 1);
  assert.equal(uploads, 0);
  assert.ok(maximumHashes <= 4);
  queue.dispose();
});

test('scan/checkpoint failure retains durable checkpoints and a restart resumes without false completion', async () => {
  const { store } = fakeStore();
  await store.load();
  const files = new Map(Array.from({ length: 101 }, (_, index) => {
    const target = file(`Restart-${String(index).padStart(3, '0')}.md`);
    return [target.path, target] as const;
  }));
  await store.replaceEntries([...files.keys()].map((path, index) => ({
    entryId: `entry_restart_${index}`, path, kind: 'file' as const, revision: 1,
    hash: sha256Text('old'), size: 1, modifiedAt: '2026-07-16T00:00:00.000Z', deleted: false, sequence: index + 1,
  })));
  const snapshots: Array<{ completedItems: number; totalItems: number }> = [];
  const failing = queueHarness({
    files, store,
    hash: async (target) => {
      if (target.path === 'Restart-100.md') throw new Error('scan interrupted');
      return { hash: sha256Text(target.path), size: 1, bytes: new Uint8Array(1).buffer };
    },
    onProgress: (progress) => snapshots.push(progress),
  });

  await assert.rejects(() => failing.reconcileAll([...files.values()]), /scan interrupted/);
  assert.equal(store.state.pendingPaths.length, 100, 'the completed 100-path checkpoint remains durable');
  assert.ok(snapshots.at(-1)!.completedItems < snapshots.at(-1)!.totalItems, 'failure never reports completion');
  failing.dispose();

  const restarted = queueHarness({ files, store });
  await restarted.reconcileAll([...files.values()]);
  assert.equal(store.state.pendingPaths.length, 101, 'restart preserves the checkpoint and discovers the suffix');
  restarted.dispose();
});

test('a local edit arriving during upload preparation survives stale prepared work', async () => {
  const { store } = fakeStore();
  await store.load();
  store.state.modifyDebounceMs = 10_000;
  const target = file('Changing.md');
  const files = new Map([[target.path, target]]);
  const original: PendingPath = { path: target.path, action: 'upsert', observedAt: '2026-07-16T00:00:00.000Z' };
  await store.queuePath(original);
  let release!: () => void; let started!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const uploadStarted = new Promise<void>((resolve) => { started = resolve; });
  const queue = queueHarness({ files, store, upload: async () => { started(); await blocked; } });

  const flushing = queue.flushAll();
  await uploadStarted;
  const newer: PendingPath = { path: target.path, action: 'upsert', observedAt: '2026-07-16T00:00:01.000Z' };
  await store.queuePath(newer);
  release();
  await flushing;

  assert.deepEqual(store.state.pendingPaths, [newer]);
  assert.equal(store.state.operations.length, 0);
  assert.equal(store.state.nextClientSequence, 1);
  queue.dispose();
});

test('prepared path becomes a durable blob-reference operation in the same save that removes its marker', async () => {
  const { store, writes } = fakeStore();
  await store.load();
  const target = file('Crash-safe.md', 4);
  const files = new Map([[target.path, target]]);
  await store.queuePath({ path: target.path, action: 'upsert', observedAt: '2026-07-16T00:00:00.000Z' });
  writes.length = 0;
  const queue = queueHarness({ files, store });

  await queue.flushAll();

  assert.equal(writes.length, 1);
  const durable = writes[0] as { pendingPaths: PendingPath[]; operations: Array<{ content?: { inlineText?: string; blobHash?: string } }> };
  assert.equal(durable.pendingPaths.length, 0);
  assert.equal(durable.operations.length, 1);
  assert.ok(durable.operations[0]?.content?.blobHash);
  assert.equal(JSON.stringify(durable).includes('private note'), false);
});

test('rename then modify retains entry identity and ordered durable sequences', async () => {
  const { store } = fakeStore();
  await store.load();
  store.state.modifyDebounceMs = 10_000;
  await store.replaceEntries([{
    entryId: 'entry_rename', path: 'Old.md', kind: 'file', revision: 1, hash: sha256Text('old'), size: 3,
    modifiedAt: '2026-07-16T00:00:00.000Z', deleted: false, sequence: 1,
  }]);
  const target = file('New.md', 3);
  const files = new Map([[target.path, target]]);
  const queue = queueHarness({ files, store });
  await queue.observe('rename', target, 'Old.md');
  await queue.observe('upsert', target);
  await queue.flushAll();
  await queue.flushAll();

  assert.deepEqual(store.state.operations.map((operation) => operation.operation), ['rename', 'modify']);
  assert.deepEqual(store.state.operations.map((operation) => operation.clientSequence), [1, 2]);
  assert.equal('entryId' in store.state.operations[1]! ? store.state.operations[1].entryId : null, 'entry_rename');
  queue.dispose();
});

test('upload failure retains marker and does not consume a client sequence', async () => {
  const { store } = fakeStore();
  await store.load();
  const target = file('Offline.md');
  const files = new Map([[target.path, target]]);
  await store.queuePath({ path: target.path, action: 'upsert', observedAt: '2026-07-16T00:00:00.000Z' });
  const queue = queueHarness({ files, store, upload: async () => { throw new Error('network unavailable'); } });

  await assert.rejects(() => queue.flushAll(), /network unavailable/);
  assert.equal(store.state.pendingPaths.length, 1);
  assert.equal(store.state.operations.length, 0);
  assert.equal(store.state.nextClientSequence, 1);
});
