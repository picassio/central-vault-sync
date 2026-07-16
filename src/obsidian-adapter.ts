import { MarkdownView, normalizePath, TFile, TFolder, type FileManager, type Vault, type Workspace } from 'obsidian';
import {
  assertServerPathAllowed,
  sha256Bytes,
  sha256Text,
  type ClientApplyIntent,
  type OperationResult,
  type SyncEntry,
  type SyncEvent,
  type SyncLocalAdapter,
} from '@picassio/sync-core';
import { PluginStore } from './plugin-store';
import { ProtocolClient } from './protocol-client';

const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'json', 'css', 'js', 'ts', 'tsx', 'jsx', 'html', 'xml', 'yaml', 'yml', 'csv', 'svg', 'canvas']);

export class ObsidianSyncAdapter implements SyncLocalAdapter {
  private expected = new Map<string, { hash: string | null; revision: number }>();
  constructor(
    private readonly vault: Vault,
    private readonly fileManager: FileManager,
    private readonly workspace: Workspace,
    private readonly store: PluginStore,
    private readonly client: ProtocolClient,
    private readonly approveLargeDownload: (path: string, size: number) => Promise<boolean>,
    private readonly conflictNotice: (result: OperationResult | string) => void,
  ) {}

  async bootstrap(entries: SyncEntry[]): Promise<void> {
    const protectedPaths = new Set([
      ...this.store.state.pendingPaths.flatMap((pending) => [pending.path, ...(pending.oldPath ? [pending.oldPath] : [])]),
      ...this.store.state.operations.flatMap((operation) => {
        if ('path' in operation && (operation.operation === 'create' || operation.operation === 'mkdir')) return [operation.path];
        if ('entryId' in operation) {
          const prior = this.store.entryById(operation.entryId);
          return prior ? [prior.path] : [];
        }
        return [];
      }),
    ]);
    const live = entries.filter((entry) => !entry.deleted).sort((a, b) => depth(a.path) - depth(b.path));
    for (const entry of live) if (!protectedPaths.has(entry.path)) await this.applyEntry(entry);
    await this.store.replaceEntries(entries);
  }

  async apply(event: SyncEvent): Promise<void> {
    if (this.store.state.paused) throw new Error('remote apply deferred while sync is paused');
    if (event.operation === 'delete' || event.operation === 'rmdir') {
      await this.remove(event.path, event.revision);
    } else if (event.operation === 'rename') {
      await this.rename(event.oldPath!, event.path, event.hash, event.revision);
    } else {
      await this.applyEntry({
        entryId: event.entryId, path: event.path,
        kind: event.operation === 'mkdir' ? 'directory' : 'file',
        revision: event.revision, hash: event.hash, size: event.size,
        modifiedAt: event.occurredAt, deleted: false, sequence: event.sequence,
      });
    }
    const prior = this.store.entryById(event.entryId);
    await this.store.putEntry({
      entryId: event.entryId, path: event.path,
      kind: event.operation === 'mkdir' || event.operation === 'rmdir' ? 'directory' : (prior?.kind ?? 'file'),
      revision: event.revision, hash: event.hash, size: event.size,
      modifiedAt: event.occurredAt,
      deleted: event.operation === 'delete' || event.operation === 'rmdir',
      sequence: event.sequence,
    });
  }
  async recover(intent: ClientApplyIntent): Promise<void> { await this.apply(intent.event); }
  async conflict(result: OperationResult): Promise<void> { this.conflictNotice(result); }

  async consumeExpected(path: string, hash: string | null): Promise<boolean> {
    const normalized = normalizePath(path);
    if (!this.expected.has(normalized)) return false;
    const expected = this.expected.get(normalized)!;
    if (expected.hash !== hash || !Number.isSafeInteger(expected.revision)) return false;
    this.expected.delete(normalized);
    return true;
  }

  async hashFile(file: TFile, includeContent = true): Promise<{ hash: string; size: number; text?: string; bytes?: ArrayBuffer }> {
    if (TEXT_EXTENSIONS.has(file.extension.toLowerCase())) {
      const text = await this.vault.read(file);
      const result = { hash: sha256Text(text), size: new TextEncoder().encode(text).byteLength };
      return includeContent ? { ...result, text } : result;
    }
    const bytes = await this.vault.readBinary(file);
    const result = { hash: sha256Bytes(new Uint8Array(bytes)), size: bytes.byteLength };
    return includeContent ? { ...result, bytes } : result;
  }

  private async applyEntry(entry: SyncEntry): Promise<void> {
    assertServerPathAllowed(entry.path);
    if (entry.kind === 'directory') {
      await this.ensureFolder(entry.path);
      this.expected.set(entry.path, { hash: null, revision: entry.revision });
      return;
    }
    if (!entry.hash) throw new Error(`file ${entry.path} has no hash`);
    if (entry.size > this.store.state.mobileLargeFileMiB * 1024 * 1024 && !(await this.approveLargeDownload(entry.path, entry.size))) {
      throw new Error(`large download awaiting approval: ${entry.path}`);
    }
    const existing = this.vault.getAbstractFileByPath(entry.path);
    if (existing instanceof TFile) {
      const current = await this.hashFile(existing);
      if (current.hash === entry.hash) { this.expected.set(entry.path, { hash: entry.hash, revision: entry.revision }); return; }
    }
    await this.assertNoLocalWork(entry.path, false);
    if (existing && !(existing instanceof TFile)) {
      throw new Error(`path kind collision: ${entry.path}`);
    }
    const downloaded = await this.client.download(entry.entryId, entry.revision);
    const actual = sha256Bytes(new Uint8Array(downloaded.bytes));
    if (actual !== entry.hash || downloaded.bytes.byteLength !== entry.size) throw new Error(`download verification failed: ${entry.path}`);
    await this.ensureParent(entry.path);
    this.expected.set(entry.path, { hash: entry.hash, revision: entry.revision });
    if (existing instanceof TFile) await this.vault.modifyBinary(existing, downloaded.bytes);
    else await this.vault.createBinary(entry.path, downloaded.bytes);
  }

  private async rename(from: string, to: string, hash: string | null, revision: number): Promise<void> {
    const source = this.vault.getAbstractFileByPath(from);
    const destination = this.vault.getAbstractFileByPath(to);
    if (!source && destination instanceof TFolder && hash === null) {
      this.expected.set(to, { hash, revision });
      return;
    }
    if (!source && destination instanceof TFile && hash) {
      if ((await this.hashFile(destination)).hash === hash) this.expected.set(to, { hash, revision });
      // The rename itself is already materialized. A differing destination is later local work and must
      // remain untouched while this metadata event advances the projection used by its follow-up modify.
      return;
    }
    await this.assertNoLocalWork(from, source instanceof TFolder);
    await this.assertNoLocalWork(to, destination instanceof TFolder);
    if (!source) return;
    if (destination && destination !== source) throw new Error(`rename destination exists: ${to}`);
    await this.ensureParent(to);
    this.expected.set(to, { hash, revision });
    await this.vault.rename(source, to);
  }
  private async remove(path: string, revision: number): Promise<void> {
    const target = this.vault.getAbstractFileByPath(path);
    if (!target) return;
    await this.assertNoLocalWork(path, target instanceof TFolder);
    this.expected.set(path, { hash: null, revision });
    await this.fileManager.trashFile(target);
  }
  private async assertNoLocalWork(path: string, subtree: boolean): Promise<void> {
    const matches = (candidate: string): boolean => candidate === path || (subtree && candidate.startsWith(`${path}/`));
    const pending = this.store.state.pendingPaths.some((item) => matches(item.path) || Boolean(item.oldPath && matches(item.oldPath)));
    const queued = this.store.state.operations.some((operation) => {
      if ('path' in operation && matches(operation.path)) return true;
      if ('entryId' in operation) {
        const entry = this.store.entryById(operation.entryId);
        if (entry && matches(entry.path)) return true;
      }
      return false;
    });
    if (pending || queued) throw new Error(`local changes pending for ${path}; remote apply deferred`);

    for (const leaf of this.workspace.getLeavesOfType('markdown')) {
      if (!(leaf.view instanceof MarkdownView) || !leaf.view.file || !matches(leaf.view.file.path)) continue;
      const diskFile = this.vault.getAbstractFileByPath(leaf.view.file.path);
      if (!(diskFile instanceof TFile) || !TEXT_EXTENSIONS.has(diskFile.extension.toLowerCase())) continue;
      const diskText = await this.vault.read(diskFile);
      if (leaf.view.editor.getValue() !== diskText) {
        throw new Error(`open editor has unsaved changes for ${leaf.view.file.path}; remote apply deferred`);
      }
    }
  }

  private async ensureParent(filePath: string): Promise<void> {
    const slash = filePath.lastIndexOf('/');
    if (slash > 0) await this.ensureFolder(filePath.slice(0, slash));
  }
  private async ensureFolder(folderPath: string): Promise<void> {
    let current = '';
    for (const segment of folderPath.split('/')) {
      current = current ? `${current}/${segment}` : segment;
      const found = this.vault.getAbstractFileByPath(current);
      if (found instanceof TFolder) continue;
      if (found) throw new Error(`folder path is occupied by a file: ${current}`);
      this.expected.set(current, { hash: null, revision: 0 });
      await this.vault.createFolder(current);
    }
  }
}

function depth(path: string): number { return path.split('/').length; }
