import assert from 'node:assert/strict';
import test from 'node:test';
import { MarkdownView, TFile, TFolder } from 'obsidian';
import { sha256Bytes, sha256Text, type SyncEntry, type SyncEvent } from '@webobsidian/sync-core';
import { ObsidianSyncAdapter } from '../src/obsidian-adapter.js';
import { PluginStore } from '../src/plugin-store.js';

class FakeVault {
  nodes = new Map<string, TFile | TFolder>();
  bytes = new Map<string, Uint8Array>();
  getAbstractFileByPath(path: string) { return this.nodes.get(path) ?? null; }
  async createFolder(path: string) { const folder = new TFolder(); Object.assign(folder, { path, name: path.split('/').at(-1) }); this.nodes.set(path, folder); return folder; }
  async createBinary(path: string, value: ArrayBuffer) { const file = new TFile(); Object.assign(file, { path, name: path.split('/').at(-1), extension: path.split('.').at(-1) ?? '', stat: { size: value.byteLength, mtime: 0, ctime: 0 } }); this.nodes.set(path, file); this.bytes.set(path, new Uint8Array(value.slice(0))); return file; }
  async modifyBinary(file: TFile, value: ArrayBuffer) { this.bytes.set(file.path, new Uint8Array(value.slice(0))); }
  async rename(node: TFile | TFolder, to: string) {
    this.nodes.delete(node.path); const prior = node.path; node.path = to; this.nodes.set(to, node);
    const bytes = this.bytes.get(prior); if (bytes) { this.bytes.delete(prior); this.bytes.set(to, bytes); }
  }
  async read(file: TFile) { return new TextDecoder().decode(this.bytes.get(file.path) ?? new Uint8Array()); }
  async readBinary(file: TFile) { const bytes = this.bytes.get(file.path) ?? new Uint8Array(); return bytes.slice().buffer; }
}

function store() {
  const plugin = {
    app: { secretStorage: { getSecret: () => null, setSecret: () => {} } },
    loadData: async () => null, saveData: async () => {},
  } as never;
  return new PluginStore(plugin);
}
function entry(path: string, content: string, revision = 1): SyncEntry {
  return {
    entryId: 'entry_adapter_remote_1', path, kind: 'file', revision,
    hash: sha256Text(content), size: new TextEncoder().encode(content).byteLength,
    modifiedAt: '2026-07-13T00:00:00.000Z', deleted: false, sequence: revision,
  };
}
function modifyEvent(path: string, content: string): SyncEvent {
  return {
    sequence: 2, eventId: 'event_adapter_modify_2', actor: { type: 'device', id: 'device_adapter_remote' },
    operation: 'modify', entryId: 'entry_adapter_remote_1', path, baseRevision: 1, revision: 2,
    hash: sha256Text(content), size: new TextEncoder().encode(content).byteLength,
    occurredAt: '2026-07-13T00:00:01.000Z',
  };
}
function emptyWorkspace() { return { getLeavesOfType: () => [] } as never; }

test('mock Vault adapter bootstraps verified bytes and suppresses only the expected hash echo', async () => {
  const vault = new FakeVault();
  const persistence = store(); await persistence.load();
  const remote = 'remote body\n';
  const client = { async download() { return { bytes: new TextEncoder().encode(remote).buffer, hash: sha256Text(remote) }; } };
  const adapter = new ObsidianSyncAdapter(
    vault as never, { trashFile: async () => {} } as never, emptyWorkspace(), persistence, client as never,
    async () => true, () => {},
  );
  await adapter.bootstrap([entry('Folder/Note.md', remote)]);
  const file = vault.getAbstractFileByPath('Folder/Note.md');
  assert.ok(file instanceof TFile);
  assert.equal(await vault.read(file), remote);
  assert.equal(await adapter.consumeExpected('Folder/Note.md', sha256Text('wrong')), false);
  assert.equal(await adapter.consumeExpected('Folder/Note.md', sha256Text(remote)), true);
  assert.equal(persistence.entryByPath('Folder/Note.md')?.revision, 1);
});

test('mock Vault adapter applies rename and delete idempotently while retaining tombstone projection', async () => {
  const vault = new FakeVault();
  const persistence = store(); await persistence.load();
  const content = 'rename me';
  const client = { async download() { return { bytes: new TextEncoder().encode(content).buffer, hash: sha256Text(content) }; } };
  const trash: string[] = [];
  const adapter = new ObsidianSyncAdapter(
    vault as never,
    { trashFile: async (file: TFile) => { trash.push(file.path); vault.nodes.delete(file.path); vault.bytes.delete(file.path); } } as never,
    emptyWorkspace(), persistence, client as never, async () => true, () => {},
  );
  await adapter.bootstrap([entry('Old.md', content)]);
  const renamed: SyncEvent = {
    sequence: 2, eventId: 'event_adapter_rename_2', actor: { type: 'device', id: 'device_adapter_remote' },
    operation: 'rename', entryId: 'entry_adapter_remote_1', oldPath: 'Old.md', path: 'New.md',
    baseRevision: 1, revision: 2, hash: sha256Text(content), size: content.length, occurredAt: '2026-07-13T00:00:01.000Z',
  };
  await adapter.apply(renamed);
  assert.equal(vault.getAbstractFileByPath('Old.md'), null);
  assert.equal(vault.getAbstractFileByPath('New.md') instanceof TFile, true);
  await adapter.apply({ ...renamed, sequence: 3, eventId: 'event_adapter_delete_3', operation: 'delete', oldPath: undefined, path: 'New.md', baseRevision: 2, revision: 3, hash: null, previousHash: sha256Text(content), size: 0 });
  assert.deepEqual(trash, ['New.md']);
  assert.equal(persistence.entryById('entry_adapter_remote_1')?.deleted, true);
});

test('download hash mismatch fails before writing canonical local bytes', async () => {
  const vault = new FakeVault();
  const persistence = store(); await persistence.load();
  const client = { async download() { const bytes = new TextEncoder().encode('tampered').buffer; return { bytes, hash: sha256Bytes(new Uint8Array(bytes)) }; } };
  const adapter = new ObsidianSyncAdapter(vault as never, { trashFile: async () => {} } as never, emptyWorkspace(), persistence, client as never, async () => true, () => {});
  await assert.rejects(() => adapter.bootstrap([entry('Safe.md', 'expected')]), /verification failed/);
  assert.equal(vault.getAbstractFileByPath('Safe.md'), null);
});

test('remote update cannot replace a durable local pending path', async () => {
  const vault = new FakeVault();
  const base = 'base\n'; const remote = 'remote\n';
  await vault.createBinary('Open.md', new TextEncoder().encode(base).buffer);
  const persistence = store(); await persistence.load();
  await persistence.replaceEntries([entry('Open.md', base)]);
  await persistence.queuePath({ path: 'Open.md', action: 'upsert', observedAt: '2026-07-13T00:00:00.500Z' });
  const client = { async download() { return { bytes: new TextEncoder().encode(remote).buffer, hash: sha256Text(remote) }; } };
  const adapter = new ObsidianSyncAdapter(
    vault as never, { trashFile: async () => {} } as never, emptyWorkspace(), persistence, client as never,
    async () => true, () => {},
  );

  await assert.rejects(() => adapter.apply(modifyEvent('Open.md', remote)), /local changes pending/);
  const file = vault.getAbstractFileByPath('Open.md'); assert.ok(file instanceof TFile);
  assert.equal(await vault.read(file), base);
  assert.equal(persistence.entryByPath('Open.md')?.revision, 1);
});

test('remote update cannot replace an unsaved open editor before its Vault event', async () => {
  const vault = new FakeVault();
  const base = 'base\n'; const remote = 'remote\n'; const local = 'unsaved local\n';
  const file = await vault.createBinary('Open.md', new TextEncoder().encode(base).buffer);
  const persistence = store(); await persistence.load();
  await persistence.replaceEntries([entry('Open.md', base)]);
  const view = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
    file, editor: { getValue: () => local },
  });
  const workspace = { getLeavesOfType: () => [{ view }] } as never;
  const client = { async download() { return { bytes: new TextEncoder().encode(remote).buffer, hash: sha256Text(remote) }; } };
  const adapter = new ObsidianSyncAdapter(
    vault as never, { trashFile: async () => {} } as never, workspace, persistence, client as never,
    async () => true, () => {},
  );

  await assert.rejects(() => adapter.apply(modifyEvent('Open.md', remote)), /open editor has unsaved changes/);
  assert.equal(await vault.read(file), base);
  assert.equal(view.editor.getValue(), local);
  assert.equal(persistence.entryByPath('Open.md')?.revision, 1);
});
