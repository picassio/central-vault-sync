import { Notice, PluginSettingTab, type App, type SettingDefinitionItem } from 'obsidian';
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

  getSettingDefinitions(): SettingDefinitionItem[] {
    const state = this.controller.store.state;
    return [
      {
        type: 'group', heading: 'Connection and behavior', items: [
          { name: 'Server URL', desc: 'HTTPS URL of the authoritative vault server. HTTP is accepted only for loopback development.', control: { type: 'text', key: 'serverUrl', placeholder: 'https://vault.example.com' } },
          { name: 'Device name', desc: 'Shown in the server device list and conflict-copy names.', control: { type: 'text', key: 'deviceName' } },
          {
            name: 'Connection', desc: state.deviceId ? `Paired device ${state.deviceId}; cursor ${state.cursor}.` : 'Enter a one-time code created by a server administrator.',
            render: (setting) => {
              setting.addButton((button) => button.setButtonText('Test').onClick(async () => {
                try { new Notice(await this.controller.testConnection()); } catch (error) { new Notice(message(error)); }
              }));
              setting.addButton((button) => button.setDestructive().setButtonText('Unpair').setDisabled(!state.deviceId).onClick(async () => {
                await this.controller.unpair(); this.update();
              }));
            },
          },
          {
            name: 'One-time pairing code', desc: 'The code is exchanged once and is never saved or logged.',
            render: (setting) => {
              let code = '';
              setting.addText((text) => text.setPlaceholder('Paste code').onChange((value) => { code = value.trim(); }));
              setting.addButton((button) => button.setCta().setButtonText('Pair').setDisabled(Boolean(state.deviceId)).onClick(async () => {
                try { await this.controller.pair(code); new Notice('Central sync paired'); this.update(); }
                catch (error) { new Notice(message(error)); }
              }));
            },
          },
          { name: 'Paused', desc: 'Keep durable local queue markers but do not transfer changes.', control: { type: 'toggle', key: 'paused' } },
          { name: 'Fallback polling interval', desc: 'Seconds between ordered REST catch-up checks when no wake-up arrives.', control: { type: 'number', key: 'fallbackPollSeconds', min: 5, max: 300, step: 1 } },
          { name: 'Modify debounce', desc: 'Milliseconds to coalesce noisy editor write bursts. Default: 750 ms.', control: { type: 'number', key: 'modifyDebounceMs', min: 250, max: 10_000, step: 50 } },
          { name: 'Mobile large-file confirmation', desc: 'Ask before downloading a file at or above this size in MiB. Default: 100 MiB.', control: { type: 'number', key: 'mobileLargeFileMiB', min: 1, max: 10_240, step: 1 } },
          { name: 'Additional exclude globs', desc: 'Comma-separated stricter device exclusions. Server exclusions can never be re-included.', control: { type: 'textarea', key: 'excludeGlobs' } },
        ],
      },
      {
        type: 'group', heading: 'Status and diagnostics', items: [
          { name: 'Server-enforced exclusions', desc: `${this.app.vault.configDir}/**, .git/**, .trash/**, temporary/OS files, and internal sync metadata never synchronize.` },
          {
            name: 'Operations', desc: `${state.operations.length} durable operation(s), ${state.pendingPaths.length} path marker(s), ${state.applyIntents.length} apply intent(s).`,
            render: (setting) => {
              setting.addButton((button) => button.setCta().setButtonText('Sync now').setDisabled(!state.deviceId || state.paused).onClick(async () => {
                try { await this.controller.syncNow(); new Notice('Central sync complete'); this.update(); }
                catch (error) { new Notice(message(error)); }
              }));
              setting.addButton((button) => button.setButtonText('Copy redacted diagnostics').onClick(async () => {
                await navigator.clipboard.writeText(this.controller.diagnostics()); new Notice('Redacted diagnostics copied');
              }));
            },
          },
          { name: 'Mobile lifecycle', desc: 'Synchronization runs while the app is foregrounded. It cannot run while the operating system suspends the app.' },
          ...(state.lastError ? [{ name: 'Last error', desc: state.lastError }] : []),
        ],
      },
    ];
  }
}

function clamp(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.round(value))) : fallback;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
