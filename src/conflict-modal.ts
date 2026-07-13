import { Modal, Notice, Setting, TFile, type App } from 'obsidian';
import type { Conflict } from '@webobsidian/sync-core';
import { PluginStore } from './plugin-store';
import { ProtocolClient } from './protocol-client';

export class ConflictModal extends Modal {
  constructor(app: App, private readonly client: ProtocolClient, private readonly store: PluginStore) { super(app); }
  onOpen(): void { this.titleEl.setText('Central sync conflicts'); void this.renderList(); }
  onClose(): void { this.contentEl.empty(); }

  private async renderList(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.createEl('p', { text: 'Resolving a conflict creates a normal server revision. No choice silently replaces both versions.' });
    try {
      const conflicts = (await this.client.conflicts()).filter((conflict) => conflict.status === 'unresolved');
      if (conflicts.length === 0) { this.contentEl.createEl('p', { text: 'No unresolved conflicts.' }); return; }
      for (const conflict of conflicts) {
        new Setting(this.contentEl)
          .setName(conflict.path)
          .setDesc(`${conflict.kind} · server revision ${conflict.currentRevision ?? 'deleted'} · ${new Date(conflict.createdAt).toLocaleString()}`)
          .addButton((button) => button.setButtonText('Compare and resolve').onClick(() => void this.renderConflict(conflict)));
      }
    } catch (error) { this.contentEl.createEl('p', { cls: 'central-sync-error', text: message(error) }); }
  }

  private async renderConflict(conflict: Conflict): Promise<void> {
    this.contentEl.empty();
    new Setting(this.contentEl).setName(conflict.path).setHeading();
    const binary = !/\.(md|markdown|txt|json|css|js|ts|tsx|jsx|html|xml|yaml|yml|csv|svg|canvas)$/i.test(conflict.path);
    let merged = '';
    if (binary) {
      this.contentEl.createEl('p', { text: 'Binary versions are never auto-merged. Both hashes remain downloadable through the synchronized conflict copy.' });
      this.contentEl.createEl('p', { text: `Server SHA-256: ${conflict.currentHash ?? 'deleted'}` });
      this.contentEl.createEl('p', { text: `Client SHA-256: ${conflict.submittedHash ?? 'unavailable'}` });
    } else {
      const [base, server, local] = await Promise.all([
        conflict.entryId && conflict.baseRevision !== null
          ? this.client.download(conflict.entryId, conflict.baseRevision).then((value) => decode(value.bytes)).catch(() => 'Base revision unavailable')
          : Promise.resolve('Base revision unavailable'),
        conflict.entryId && conflict.currentRevision !== null
          ? this.client.download(conflict.entryId, conflict.currentRevision).then((value) => decode(value.bytes)).catch(() => '')
          : Promise.resolve(''),
        this.localText(conflict),
      ]);
      merged = local || server;
      for (const [label, value] of [['Base version', base], ['Server version', server], ['Local/client version', local]] as const) {
        new Setting(this.contentEl).setName(label).addTextArea((area) => {
          area.setValue(value).setDisabled(true); area.inputEl.rows = 8;
        });
      }
      new Setting(this.contentEl).setName('Merged result').setDesc('Edit the exact text to commit as the next normal revision.').addTextArea((area) => {
        area.setValue(merged).onChange((value) => { merged = value; }); area.inputEl.rows = 12;
      });
    }
    new Setting(this.contentEl)
      .addButton((button) => button.setCta().setButtonText('Save merged').setDisabled(binary).onClick(() => void this.resolve(conflict, 'merged', merged)))
      .addButton((button) => button.setButtonText('Keep server').onClick(() => void this.resolve(conflict, 'keep-server')))
      .addButton((button) => button.setButtonText('Keep client').onClick(() => void this.resolve(conflict, 'keep-client')))
      .addButton((button) => button.setButtonText('Keep both').onClick(() => void this.resolve(conflict, 'copy')))
      .addButton((button) => button.setButtonText('Back').onClick(() => void this.renderList()));
  }

  private async resolve(conflict: Conflict, resolution: 'keep-server' | 'keep-client' | 'merged' | 'copy', merged?: string): Promise<void> {
    try {
      const sequence = await this.store.takeClientSequence();
      await this.client.resolveConflict(conflict.conflictId, resolution, sequence, `plugin-resolve-${sequence}-${randomId()}`, merged);
      new Notice(`Resolved ${conflict.path}`);
      await this.renderList();
    } catch (error) { new Notice(message(error)); }
  }
  private async localText(conflict: Conflict): Promise<string> {
    const path = conflict.conflictPath ?? conflict.path;
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? this.app.vault.read(file) : '';
  }
}

function decode(bytes: ArrayBuffer): string { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
function randomId(): string { return Array.from(crypto.getRandomValues(new Uint8Array(8)), (value) => value.toString(16).padStart(2, '0')).join(''); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
