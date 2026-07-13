import { Notice, PluginSettingTab, Setting, type App } from 'obsidian';
import type { PluginState } from './plugin-store';

export interface SyncPluginController {
  app: App;
  store: { state: PluginState; save(): Promise<void> };
  pair(code: string): Promise<void>;
  unpair(): Promise<void>;
  testConnection(): Promise<string>;
  syncNow(): Promise<void>;
  diagnostics(): string;
}

type EditableKey = 'serverUrl' | 'deviceName' | 'paused' | 'fallbackPollSeconds' | 'modifyDebounceMs' | 'mobileLargeFileMiB' | 'excludeGlobs';

export class CentralSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly controller: SyncPluginController) { super(app, controller as never); }

  getControlValue(key: string): unknown {
    const state = this.controller.store.state;
    if (key === 'excludeGlobs') return state.excludeGlobs.join(', ');
    return state[key as EditableKey];
  }
  async setControlValue(key: string, value: unknown): Promise<void> {
    const state = this.controller.store.state;
    if (key === 'excludeGlobs') state.excludeGlobs = String(value).split(',').map((item) => item.trim()).filter(Boolean);
    else if (key === 'serverUrl') state.serverUrl = String(value).trim();
    else if (key === 'deviceName') state.deviceName = String(value).trim().slice(0, 128) || 'Obsidian';
    else if (key === 'paused') state.paused = Boolean(value);
    else if (key === 'fallbackPollSeconds') state.fallbackPollSeconds = clamp(Number(value), 5, 300, 15);
    else if (key === 'modifyDebounceMs') state.modifyDebounceMs = clamp(Number(value), 250, 10_000, 750);
    else if (key === 'mobileLargeFileMiB') state.mobileLargeFileMiB = clamp(Number(value), 1, 10_240, 100);
    await this.controller.store.save();
  }

  display(): void {
    const { containerEl } = this; const state = this.controller.store.state;
    containerEl.empty();
    new Setting(containerEl).setName('Connection and behavior').setHeading();
    new Setting(containerEl).setName('Server URL').setDesc('HTTPS URL of the authoritative vault server. HTTP is accepted only for loopback development.')
      .addText((text) => text.setPlaceholder('https://vault.example.com').setValue(state.serverUrl).onChange((value) => void this.setControlValue('serverUrl', value)));
    new Setting(containerEl).setName('Device name').setDesc('Shown in the server device list and conflict-copy names.')
      .addText((text) => text.setValue(state.deviceName).onChange((value) => void this.setControlValue('deviceName', value)));
    new Setting(containerEl).setName('Connection').setDesc(state.deviceId ? `Paired device ${state.deviceId}; cursor ${state.cursor}.` : 'Enter a one-time code created by a server administrator.')
      .addButton((button) => button.setButtonText('Test').onClick(async () => {
        try { new Notice(await this.controller.testConnection()); } catch (error) { new Notice(message(error)); }
      }))
      .addButton((button) => {
        button.setButtonText('Unpair').setDisabled(!state.deviceId).onClick(async () => { await this.controller.unpair(); this.display(); });
        button.buttonEl.addClass('mod-warning');
      });
    let code = '';
    new Setting(containerEl).setName('One-time pairing code').setDesc('The code is exchanged once and is never saved or logged.')
      .addText((text) => text.setPlaceholder('Paste code').onChange((value) => { code = value.trim(); }))
      .addButton((button) => button.setCta().setButtonText('Pair').setDisabled(Boolean(state.deviceId)).onClick(async () => {
        try { await this.controller.pair(code); new Notice('Central sync paired'); this.display(); } catch (error) { new Notice(message(error)); }
      }));
    new Setting(containerEl).setName('Paused').setDesc('Keep durable local queue markers but do not transfer changes.')
      .addToggle((toggle) => toggle.setValue(state.paused).onChange((value) => void this.setControlValue('paused', value)));
    this.numberSetting('Fallback polling interval', 'Seconds between ordered REST catch-up checks when no wake-up arrives.', 'fallbackPollSeconds', 5, 300, 1);
    this.numberSetting('Modify debounce', 'Milliseconds to coalesce noisy editor write bursts. Default: 750 ms.', 'modifyDebounceMs', 250, 10_000, 50);
    this.numberSetting('Mobile large-file confirmation', 'Ask before downloading a file at or above this size in MiB. Default: 100 MiB.', 'mobileLargeFileMiB', 1, 10_240, 1);
    new Setting(containerEl).setName('Additional exclude globs').setDesc('Comma-separated stricter device exclusions. Server exclusions can never be re-included.')
      .addTextArea((text) => text.setValue(state.excludeGlobs.join(', ')).onChange((value) => void this.setControlValue('excludeGlobs', value)));

    new Setting(containerEl).setName('Status and diagnostics').setHeading();
    new Setting(containerEl).setName('Server-enforced exclusions').setDesc(`${this.app.vault.configDir}/**, .git/**, .trash/**, temporary/OS files, and internal sync metadata never synchronize.`);
    new Setting(containerEl).setName('Operations').setDesc(`${state.operations.length} durable operation(s), ${state.pendingPaths.length} path marker(s), ${state.applyIntents.length} apply intent(s).`)
      .addButton((button) => button.setCta().setButtonText('Sync now').setDisabled(!state.deviceId || state.paused).onClick(async () => {
        try { await this.controller.syncNow(); new Notice('Central sync complete'); this.display(); } catch (error) { new Notice(message(error)); }
      }))
      .addButton((button) => button.setButtonText('Copy redacted diagnostics').onClick(async () => {
        await navigator.clipboard.writeText(this.controller.diagnostics()); new Notice('Redacted diagnostics copied');
      }));
    new Setting(containerEl).setName('Mobile lifecycle').setDesc('Synchronization runs while the app is foregrounded. It cannot run while the operating system suspends the app.');
    if (state.lastError) new Setting(containerEl).setName('Last error').setDesc(state.lastError);
  }

  private numberSetting(name: string, description: string, key: EditableKey, minimum: number, maximum: number, step: number): void {
    new Setting(this.containerEl).setName(name).setDesc(description).addText((text) => {
      text.inputEl.type = 'number'; text.inputEl.min = String(minimum); text.inputEl.max = String(maximum); text.inputEl.step = String(step);
      text.setValue(String(this.getControlValue(key))).onChange((value) => void this.setControlValue(key, value));
    });
  }
}

function clamp(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.round(value))) : fallback;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
