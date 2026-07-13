import { Modal, Notice, Platform, Plugin, Setting, TFile, type TAbstractFile } from 'obsidian';
import { OrderedSyncClient, type OperationResult, type SyncConnectionStatus } from '@picassio/sync-core';
import { LocalMutationQueue } from './local-queue';
import { ObsidianSyncAdapter } from './obsidian-adapter';
import { PluginStore } from './plugin-store';
import { ProtocolClient, validateServerUrl } from './protocol-client';
import { CentralSyncSettingTab } from './settings';
import { ConflictModal } from './conflict-modal';

export default class CentralVaultSyncPlugin extends Plugin {
  store!: PluginStore;
  private client: ProtocolClient | null = null;
  private adapter: ObsidianSyncAdapter | null = null;
  private engine: OrderedSyncClient | null = null;
  private localQueue: LocalMutationQueue | null = null;
  private statusEl!: HTMLElement;
  private status: SyncConnectionStatus = 'disabled';
  private lag = 0;
  private conflicts = 0;
  private pendingRetry: number | null = null;
  private active = false;
  private starting: Promise<void> | null = null;

  async onload(): Promise<void> {
    this.active = true;
    this.store = new PluginStore(this);
    await this.store.load();
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('central-sync-status');
    this.statusEl.setAttr('tabindex', '0');
    this.statusEl.onClickEvent(() => this.syncNow().catch((error) => new Notice(message(error))));
    this.registerDomEvent(this.statusEl, 'keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') void this.syncNow().catch((error) => new Notice(message(error)));
    });
    this.addSettingTab(new CentralSyncSettingTab(this.app, this));
    this.registerCommands();
    this.registerVaultEvents();
    this.registerForegroundEvents();
    this.renderStatus();
    if (await this.store.getDevice()) {
      this.setStatus('syncing', 0);
      this.app.workspace.onLayoutReady(() => {
        if (this.active) void this.startClient().catch((error) => this.handleStartError(error));
      });
    }
  }

  onunload(): void {
    this.active = false;
    if (this.pendingRetry !== null) window.clearTimeout(this.pendingRetry);
    this.pendingRetry = null;
    void this.localQueue?.flushAll().catch(() => {});
    this.localQueue?.dispose();
    this.engine?.stop();
  }

  async pair(code: string): Promise<void> {
    if (!code) throw new Error('Enter a one-time pairing code');
    const serverUrl = validateServerUrl(this.store.state.serverUrl);
    const deviceId = this.store.state.deviceId ?? `obs_${randomId(24)}`;
    const paired = await ProtocolClient.pair(serverUrl, code, deviceId, this.store.state.deviceName);
    this.store.setToken(paired.token);
    await this.store.update((state) => {
      state.serverUrl = serverUrl; state.deviceId = paired.deviceId; state.vaultId = paired.vaultId;
      state.cursor = 0; state.nextClientSequence = 1; state.operations = []; state.applyIntents = [];
      state.entries = []; state.pendingPaths = []; state.lastError = null;
    });
    await this.startClient();
  }

  async unpair(): Promise<void> {
    if (this.pendingRetry !== null) window.clearTimeout(this.pendingRetry);
    this.pendingRetry = null;
    this.engine?.stop(); this.localQueue?.dispose(); this.store.clearToken();
    this.engine = null; this.client = null; this.adapter = null; this.localQueue = null;
    await this.store.update((state) => {
      state.deviceId = null; state.vaultId = null; state.cursor = 0; state.nextClientSequence = 1;
      state.operations = []; state.applyIntents = []; state.entries = []; state.pendingPaths = [];
      state.lastError = null;
    });
    this.setStatus('disabled', 0);
  }

  async testConnection(): Promise<string> {
    const device = await this.store.getDevice();
    if (!device) { validateServerUrl(this.store.state.serverUrl); return 'Server URL is valid; pair this device to authenticate.'; }
    const client = this.client ?? new ProtocolClient(this.store.state.serverUrl, device.token);
    const handshake = await client.handshake(device);
    return `Connected to vault ${handshake.vaultId}; server sequence ${handshake.latestSequence}.`;
  }

  async syncNow(): Promise<void> {
    if (this.store.state.paused) throw new Error('Sync is paused');
    if (!this.engine || !this.localQueue) throw new Error('Device is not paired');
    this.setStatus('syncing', this.lag);
    try {
      await this.localQueue.flushAll();
      await this.engine.start();
      await this.engine.flush();
      await this.engine.catchUp();
      await this.refreshConflictCount();
      if (this.store.state.lastError !== null) await this.store.update((state) => { state.lastError = null; });
      if (this.pendingRetry !== null) window.clearTimeout(this.pendingRetry);
      this.pendingRetry = null;
    } catch (error) {
      this.setStatus('offline', this.lag);
      await this.recordError(error);
      if (this.store.state.pendingPaths.length > 0) this.schedulePendingRetry();
      throw error;
    }
  }

  diagnostics(): string {
    const state = this.store.state;
    return JSON.stringify({
      exportedAt: new Date().toISOString(), pluginVersion: this.manifest.version,
      serverOrigin: safeOrigin(state.serverUrl), deviceId: state.deviceId, vaultId: state.vaultId,
      cursor: state.cursor, nextClientSequence: state.nextClientSequence,
      status: this.status, lag: this.lag, conflicts: this.conflicts, paused: state.paused,
      queuedOperations: state.operations.length, pendingPaths: state.pendingPaths.length,
      applyIntents: state.applyIntents.length, projectedEntries: state.entries.length,
      excludes: state.excludeGlobs, lastError: state.lastError,
      platform: { mobile: Platform.isMobile, ios: Platform.isIosApp, android: Platform.isAndroidApp },
    }, null, 2);
  }

  private startClient(): Promise<void> {
    if (this.starting) return this.starting;
    const start = this.startClientOnce().finally(() => { if (this.starting === start) this.starting = null; });
    this.starting = start;
    return start;
  }

  private async startClientOnce(): Promise<void> {
    if (this.pendingRetry !== null) window.clearTimeout(this.pendingRetry);
    this.pendingRetry = null;
    this.engine?.stop(); this.localQueue?.dispose();
    const device = await this.store.getDevice();
    if (!device) return;
    this.client = new ProtocolClient(this.store.state.serverUrl, device.token);
    this.adapter = new ObsidianSyncAdapter(
      this.app.vault, this.app.fileManager, this.app.workspace, this.store, this.client,
      (path, size) => this.approveLargeDownload(path, size),
      (result) => this.handleConflict(result),
    );
    this.engine = new OrderedSyncClient(
      this.store, this.client, this.adapter,
      (status, lag) => this.setStatus(status, lag),
      undefined, this.store.state.fallbackPollSeconds * 1_000,
    );
    this.localQueue = new LocalMutationQueue(
      this.app.vault, this.app.vault.configDir, this.store, this.client, this.engine, this.adapter,
      (error) => { void this.handleLocalQueueError(error); },
    );
    await this.scanLocalChanges();
    if (!this.active) { this.localQueue.dispose(); this.engine.stop(); return; }
    await this.syncNow().catch(() => {});
  }

  private schedulePendingRetry(): void {
    if (this.pendingRetry !== null || this.store.state.paused || !this.engine || !this.localQueue) return;
    const delay = Math.max(1_000, this.store.state.fallbackPollSeconds * 1_000);
    this.pendingRetry = window.setTimeout(() => {
      this.pendingRetry = null;
      void this.syncNow().catch(() => {});
    }, delay);
  }

  private registerCommands(): void {
    this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => void this.syncNow().catch((error) => new Notice(message(error))) });
    this.addCommand({ id: 'toggle-pause', name: 'Pause or resume sync', callback: () => {
      this.store.state.paused = !this.store.state.paused; void this.store.save();
      new Notice(this.store.state.paused ? 'Central Sync paused' : 'Central Sync resumed');
      if (!this.store.state.paused) void this.syncNow().catch(() => {});
    } });
    this.addCommand({ id: 'view-status', name: 'View sync status', callback: () => new Notice(`Central Sync: ${this.status}; lag ${this.lag}; conflicts ${this.conflicts}`) });
    this.addCommand({ id: 'view-conflicts', name: 'View conflicts', callback: () => {
      if (!this.client) new Notice('Pair this device before viewing conflicts.');
      else new ConflictModal(this.app, this.client, this.store, () => this.refreshConflictCount()).open();
    } });
    this.addCommand({ id: 'reconnect', name: 'Reconnect', callback: () => void this.startClient().catch((error) => new Notice(message(error))) });
    this.addCommand({ id: 'reset-local-state', name: 'Reset local sync state', callback: () => void this.resetLocalState() });
  }

  private registerVaultEvents(): void {
    this.registerEvent(this.app.vault.on('create', (file) => void this.observe('upsert', file)));
    this.registerEvent(this.app.vault.on('modify', (file) => void this.observe('upsert', file)));
    this.registerEvent(this.app.vault.on('delete', (file) => void this.observe('delete', file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => void this.observe('rename', file, oldPath)));
  }
  private registerForegroundEvents(): void {
    const resume = () => { if (!document.hidden && !this.store.state.paused) void this.syncNow().catch(() => {}); };
    this.registerDomEvent(document, 'visibilitychange', resume);
    this.registerDomEvent(window, 'focus', resume);
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => resume()));
  }
  private async observe(action: 'upsert' | 'delete' | 'rename', file: TAbstractFile, oldPath?: string): Promise<void> {
    if (!this.localQueue || !this.adapter) return;
    if (action === 'delete' && await this.adapter.consumeExpected(file.path, null)) return;
    if (action === 'rename') {
      const hash = file instanceof TFile ? (await this.adapter.hashFile(file)).hash : null;
      if (await this.adapter.consumeExpected(file.path, hash)) return;
    }
    await this.localQueue.observe(action, file, oldPath);
  }

  private async scanLocalChanges(): Promise<void> {
    if (!this.localQueue) return;
    const folders = this.app.vault.getAllFolders(false).sort((a, b) => a.path.split('/').length - b.path.split('/').length);
    const paths = [...folders, ...this.app.vault.getFiles()];
    for (let index = 0; index < paths.length; index += 1) {
      if (!this.active) return;
      await this.localQueue.reconcile(paths[index]!);
      if ((index + 1) % 100 === 0) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }
  private setStatus(status: SyncConnectionStatus, lag: number): void {
    this.status = status; this.lag = lag; this.renderStatus();
  }
  private renderStatus(): void {
    const conflict = this.conflicts > 0 ? ` · ${this.conflicts} conflict${this.conflicts === 1 ? '' : 's'}` : '';
    this.statusEl.setText(`Central Sync: ${this.status}${this.lag ? ` · ${this.lag} pending` : ''}${conflict}`);
    this.statusEl.setAttr('aria-label', 'Central Sync status; click to sync now');
  }
  private async refreshConflictCount(): Promise<void> {
    if (!this.client) { this.conflicts = 0; this.renderStatus(); return; }
    this.conflicts = (await this.client.conflicts()).filter((conflict) => conflict.status === 'unresolved').length;
    this.renderStatus();
  }
  private handleConflict(result: OperationResult | string): void {
    this.conflicts += 1; this.setStatus('conflict', this.lag);
    new Notice(typeof result === 'string' ? result : `Central Sync conflict${result.conflictId ? ` ${result.conflictId}` : ''}. Server content was not overwritten.`);
  }
  private async handleStartError(error: unknown): Promise<void> {
    if (!this.active) return;
    this.setStatus('offline', this.lag);
    await this.recordError(error);
  }
  private async handleLocalQueueError(error: unknown): Promise<void> {
    this.setStatus('offline', this.lag);
    await this.recordError(error);
    new Notice(`Central Sync: ${safeMessage(error)}`);
    this.schedulePendingRetry();
  }
  private async recordError(error: unknown): Promise<void> {
    await this.store.update((state) => { state.lastError = safeMessage(error); });
  }
  private async approveLargeDownload(path: string, size: number): Promise<boolean> {
    if (!Platform.isMobile) return true;
    return new Promise((resolve) => new LargeDownloadModal(this.app, path, size, resolve).open());
  }
  private async resetLocalState(): Promise<void> {
    if (!(await new Promise<boolean>((resolve) => new ResetStateModal(this.app, resolve).open()))) return;
    this.engine?.stop();
    await this.store.update((state) => {
      state.cursor = 0; state.operations = []; state.applyIntents = []; state.entries = []; state.pendingPaths = [];
    });
    await this.startClient();
  }
}

class ResetStateModal extends Modal {
  private settled = false;
  constructor(app: CentralVaultSyncPlugin['app'], private done: (confirmed: boolean) => void) { super(app); }
  private finish(value: boolean): void { if (!this.settled) { this.settled = true; this.done(value); } this.close(); }
  onOpen(): void {
    this.titleEl.setText('Reset local sync state?');
    this.contentEl.createEl('p', { text: 'Cursor, projections, and pending operations will be reset. Vault files are kept and reconciled on reconnect.' });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.finish(false)))
      .addButton((button) => {
        button.setButtonText('Reset').onClick(() => this.finish(true));
        button.buttonEl.addClass('mod-warning');
      });
  }
  onClose(): void { if (!this.settled) this.done(false); this.contentEl.empty(); }
}

class LargeDownloadModal extends Modal {
  private settled = false;
  constructor(app: CentralVaultSyncPlugin['app'], private path: string, private size: number, private done: (approved: boolean) => void) { super(app); }
  private finish(value: boolean): void { if (!this.settled) { this.settled = true; this.done(value); } this.close(); }
  onOpen(): void {
    this.titleEl.setText('Large sync download');
    this.contentEl.createEl('p', { text: `${this.path} is ${(this.size / 1024 / 1024).toFixed(1)} MiB. Download while the app remains foregrounded?` });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.finish(false)))
      .addButton((button) => button.setCta().setButtonText('Download').onClick(() => this.finish(true)));
  }
  onClose(): void { if (!this.settled) this.done(false); this.contentEl.empty(); }
}

function randomId(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (value) => value.toString(16).padStart(2, '0')).join('');
}
function safeOrigin(value: string): string | null { try { return new URL(value).origin; } catch { return null; } }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function safeMessage(error: unknown): string { return message(error).replace(/Bearer\s+\S+/gi, 'Bearer <redacted>'); }
