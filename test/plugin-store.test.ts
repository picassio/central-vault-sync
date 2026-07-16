import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Text, type SyncEntry, type SyncEvent, type SyncOperation } from '@picassio/sync-core';
import { PluginStore } from '../src/plugin-store.js';

function fakePlugin(initial: unknown = null) {
  const secrets = new Map<string, string>();
  const writes: unknown[] = [];
  return {
    plugin: {
      app: { secretStorage: {
        getSecret: (key: string) => secrets.get(key) ?? null,
        setSecret: (key: string, value: string) => { secrets.set(key, value); },
      } },
      loadData: async () => initial,
      saveData: async (value: unknown) => { writes.push(structuredClone(value)); },
    } as never,
    secrets, writes,
  };
}

function event(sequence: number): SyncEvent {
  return {
    sequence, eventId: `event_plugin_store_${sequence}`, actor: { type: 'device', id: 'device_plugin_store_remote' },
    operation: 'modify', entryId: 'entry_plugin_store_1', path: 'Note.md', baseRevision: 1,
    revision: 2, hash: sha256Text('remote'), size: 6, occurredAt: '2026-07-13T00:00:00.000Z',
  };
}

test('device token remains only in SecretStorage and is never serialized with plugin state', async () => {
  const fake = fakePlugin();
  const store = new PluginStore(fake.plugin);
  await store.load();
  store.setToken('raw-device-token-that-must-never-be-saved');
  await store.update((state) => {
    state.deviceId = 'device_plugin_store_1'; state.deviceName = 'Desktop'; state.vaultId = 'vault_plugin_store_1';
  });
  assert.equal((await store.getDevice())?.token, 'raw-device-token-that-must-never-be-saved');
  assert.equal(JSON.stringify(fake.writes).includes('raw-device-token'), false);
  store.clearToken();
  assert.equal(await store.getDevice(), null);
});

test('client sequence and cursor are durable and strictly monotonic', async () => {
  const fake = fakePlugin();
  const store = new PluginStore(fake.plugin);
  await store.load();
  assert.equal(await store.takeClientSequence(), 1);
  assert.equal(await store.takeClientSequence(), 2);
  await store.putCursor(7);
  await assert.rejects(() => store.putCursor(6), /backwards/);
  assert.equal(store.state.cursor, 7);
  assert.equal(store.state.nextClientSequence, 3);
});

test('apply intents and blob-reference operations survive reload without storing note content', async () => {
  const fake = fakePlugin();
  const store = new PluginStore(fake.plugin);
  await store.load();
  const operation: SyncOperation = {
    operation: 'modify', entryId: 'entry_plugin_store_1', baseRevision: 1,
    clientSequence: 1, idempotencyKey: 'plugin-store-operation-1',
    content: { hash: sha256Text('private note body'), size: 17, blobHash: sha256Text('private note body') },
  };
  await store.putOperation(operation);
  await store.putApplyIntent({ event: event(2), createdAt: '2026-07-13T00:00:00.000Z' });
  const serialized = fake.writes.at(-1)!;
  assert.equal(JSON.stringify(serialized).includes('private note body'), false);

  const reloaded = new PluginStore(fakePlugin(serialized).plugin);
  await reloaded.load();
  assert.deepEqual(await reloaded.operations(), [operation]);
  assert.equal((await reloaded.applyIntents())[0]?.event.sequence, 2);
});

test('large projections use indexed path/id lookup and update rename/tombstone mappings', async () => {
  const store = new PluginStore(fakePlugin().plugin);
  await store.load();
  const entries: SyncEntry[] = Array.from({ length: 10_000 }, (_, index) => ({
    entryId: `entry_indexed_${index}`, path: `Folder/Note-${index}.md`, kind: 'file', revision: 1,
    hash: sha256Text(String(index)), size: String(index).length, modifiedAt: '2026-07-13T00:00:00.000Z',
    deleted: false, sequence: index + 1,
  }));
  await store.replaceEntries(entries);
  store.state.entries.find = () => { throw new Error('linear projection lookup'); };
  assert.equal(store.entryByPath('Folder/Note-9999.md')?.entryId, 'entry_indexed_9999');
  assert.equal(store.entryById('entry_indexed_9999')?.path, 'Folder/Note-9999.md');
  delete (store.state.entries as { find?: unknown }).find;

  const renamed = { ...entries[9999]!, path: 'Renamed.md', revision: 2, sequence: 10_001 };
  await store.putEntry(renamed);
  assert.equal(store.entryByPath('Folder/Note-9999.md'), null);
  assert.equal(store.entryByPath('Renamed.md')?.entryId, renamed.entryId);
  await store.putEntry({ ...renamed, deleted: true, hash: null, revision: 3, sequence: 10_002 });
  assert.equal(store.entryByPath('Renamed.md'), null);
  assert.equal(store.entryById(renamed.entryId)?.deleted, true);
  assert.equal(store.state.entries.length, 10_000);
});

test('batch path checkpoint and prepared-operation commit are atomic and ignore stale markers', async () => {
  const fake = fakePlugin();
  const store = new PluginStore(fake.plugin);
  await store.load();
  const first = { path: 'A.md', action: 'upsert' as const, observedAt: '2026-07-16T00:00:00.000Z' };
  const second = { path: 'B.md', action: 'upsert' as const, observedAt: '2026-07-16T00:00:00.000Z' };
  await store.queuePaths([first, second], true);
  assert.equal(fake.writes.length, 1);

  const newer = { ...second, observedAt: '2026-07-16T00:00:01.000Z' };
  await store.queuePath(newer);
  const committed = await store.commitPreparedPaths([first, second].map((pending) => ({
    pending,
    operation: (clientSequence: number, idempotencyKey: string): SyncOperation => ({
      operation: 'create', path: pending.path, kind: 'file', clientSequence, idempotencyKey,
      content: { hash: sha256Text(pending.path), size: pending.path.length, blobHash: sha256Text(pending.path) },
    }),
  })));

  assert.deepEqual(committed, [first]);
  assert.deepEqual(store.state.pendingPaths, [newer]);
  assert.equal(store.state.operations.length, 1);
  assert.equal(store.state.operations[0]?.clientSequence, 1);
  const durable = fake.writes.at(-1) as { pendingPaths: unknown[]; operations: unknown[]; nextClientSequence: number };
  assert.equal(durable.pendingPaths.length, 1);
  assert.equal(durable.operations.length, 1);
  assert.equal(durable.nextClientSequence, 2);
});

test('terminal operation batches are removed in one durable state write', async () => {
  const fake = fakePlugin();
  const store = new PluginStore(fake.plugin);
  await store.load();
  const { writes } = fake;
  const operations = [1, 2, 3].map((clientSequence) => ({
    operation: 'delete' as const, entryId: `entry_remove_${clientSequence}`, baseRevision: 1,
    clientSequence, idempotencyKey: `plugin-remove-operation-${clientSequence}`,
  }));
  store.state.operations = operations;
  writes.length = 0;

  await store.removeOperations(operations.slice(0, 2).map((operation) => operation.idempotencyKey));

  assert.deepEqual(store.state.operations.map((operation) => operation.clientSequence), [3]);
  assert.equal(writes.length, 1);
});

test('exact duplicate operation converges but changed idempotency payload is rejected', async () => {
  const store = new PluginStore(fakePlugin().plugin);
  await store.load();
  const operation: SyncOperation = {
    operation: 'mkdir', path: 'Folder', kind: 'directory', clientSequence: 1, idempotencyKey: 'plugin-store-idempotency-1',
  };
  await store.putOperation(operation);
  await store.putOperation(operation);
  await assert.rejects(() => store.putOperation({ ...operation, path: 'Other' }), /payload changed/);
  assert.equal((await store.operations()).length, 1);
});
