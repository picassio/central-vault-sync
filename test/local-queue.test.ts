import assert from 'node:assert/strict';
import { setTimeout as nodeSetTimeout } from 'node:timers';
import test from 'node:test';
import { TFile } from 'obsidian';
import { LocalMutationQueue } from '../src/local-queue';
import type { PendingPath, PluginState } from '../src/plugin-store';
import type { SyncOperation } from '@webobsidian/sync-core';

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

async function waitFor(check: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => nodeSetTimeout(resolve, 5));
  }
  throw new Error('condition timed out');
}
