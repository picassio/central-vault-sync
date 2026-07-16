import { Modal, Notice, Platform, Plugin, Setting, TFile, type TAbstractFile } from 'obsidian';
import { OrderedSyncClient, type OperationResult, type SyncConnectionStatus } from '@picassio/sync-core';
import { LocalMutationQueue } from './local-queue';
import { ObsidianSyncAdapter } from './obsidian-adapter';
import { PluginStore } from './plugin-store';
import { ProtocolClient, ProtocolError, validateServerUrl, type ProtocolTelemetry } from './protocol-client';
import { CentralSyncSettingTab } from './settings';
import { ConflictModal } from './conflict-modal';
import { formatProgress, SyncProgressModel, type SyncProgressSnapshot } from './sync-progress';

export default class CentralVaultSyncPlugin extends Plugin {
  store!: PluginStore;
  private client: ProtocolClient | null = null;
  private adapter: ObsidianSyncAdapter | null = null;
  private engine: OrderedSyncClient | null = null;
  private localQueue: LocalMutationQueue | null = null;
  private statusEl: HTMLElement | null = null;
  private settingTab: CentralSyncSettingTab | null = null;
  private progressRender: number | null = null;
  private status: SyncConnectionStatus = 'disabled';
  private readonly progress = new SyncProgressModel((immediate) => this.scheduleProgressRender(immediate));
  private engineStarted = false;
  private initialScanComplete = false;
  private lag = 0;
  private conflicts = 0;
  private pendingRetry: number | null = null;
  private active = false;
  private starting: Promise<void> | null = null;
  private syncing: Promise<void> | null = null;

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
    this.settingTab = new CentralSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
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
    if (this.progressRender !== null) window.clearTimeout(this.progressRender);
    this.pendingRetry = null; this.progressRender = null;
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
    this.engine = null; this.client = null; this.adapter = null; this.localQueue = null; this.engineStarted = false;
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

  syncNow(): Promise<void> {
    if (this.syncing) return this.syncing;
    const sync = this.syncNowOnce().finally(() => { if (this.syncing === sync) this.syncing = null; });
    this.syncing = sync;
    return sync;
  }

  private async syncNowOnce(): Promise<void> {
    if (this.store.state.paused) throw new Error('Sync is paused');
    if (!this.engine || !this.localQueue) throw new Error('Device is not paired');
    this.setStatus('syncing', this.lag);
    try {
      if (!this.engineStarted) {
        await this.engine.start();
        this.engineStarted = true;
      } else {
        await this.localQueue.flushAll();
        const queued = this.store.state.operations.length;
        this.progress.begin('publishing', queued);
        await this.engine.flush();
        this.progress.begin('applying');
        await this.engine.catchUp();
      }
      this.progress.begin('finalizing', 1);
      await this.refreshConflictCount();
      this.progress.update(1, 1);
      this.progress.finish();
      if (this.store.state.lastError !== null) await this.store.update((state) => { state.lastError = null; });
      if (this.pendingRetry !== null) window.clearTimeout(this.pendingRetry);
      this.pendingRetry = null;
    } catch (error) {
      this.setStatus('offline', this.lag);
      await this.recordError(error);
      this.schedulePendingRetry(error);
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
      progress: this.progress.snapshot(), excludeGlobs: state.excludeGlobs.length, hasLastError: state.lastError !== null,
      platform: { mobile: Platform.isMobile, ios: Platform.isIosApp, android: Platform.isAndroidApp },
    }, null, 2);
  }

  private startClient(): Promise<void> {
    if (this.starting) return this.starting;
    const start = this.startClientOnce().finally(() => { if (this.starting === start) this.starting = null; });
    this.starting = start;
    return start;
  }

  progressSnapshot(): SyncProgressSnapshot | null { return this.progress.snapshot(); }

  private async startClientOnce(): Promise<void> {
    if (this.pendingRetry !== null) window.clearTimeout(this.pendingRetry);
    this.pendingRetry = null;
    this.engine?.stop(); this.localQueue?.dispose(); this.engineStarted = false; this.initialScanComplete = false;
    const device = await this.store.getDevice();
    if (!device) return;
    this.client = new ProtocolClient(this.store.state.serverUrl, device.token, (event) => this.recordTelemetry(event));
    this.adapter = new ObsidianSyncAdapter(
      this.app.vault, this.app.fileManager, this.app.workspace, this.store, this.client,
      (path, size) => this.approveLargeDownload(path, size),
      (result) => this.handleConflict(result),
    );
    const recoveryIntents = await this.store.applyIntents();
    if (this.progress.snapshot()?.active) this.progress.restart('recovering', recoveryIntents.length);
    else this.progress.begin('recovering', recoveryIntents.length);
    this.engine = new OrderedSyncClient(
      this.store, this.client, this.adapter,
      (status, lag) => this.setStatus(status, lag),
      undefined, this.store.state.fallbackPollSeconds * 1_000,
      {
        onRecoveryComplete: () => {
          if (this.progress.snapshot()?.phase === 'recovering') this.progress.increment();
        },
        onEventDurable: () => {
          if (this.progress.snapshot()?.phase === 'applying') this.progress.increment();
        },
        afterRecovery: async () => {
          if (this.progress.snapshot()?.phase === 'recovering') this.progress.begin('manifest');
        },
        beforeBootstrap: async (snapshot) => {
          if (this.progress.snapshot()?.phase === 'manifest') {
            this.progress.update(snapshot.entries.length, snapshot.entries.length);
          }
          await this.scanLocalChanges();
          this.initialScanComplete = true;
        },
        beforeInitialFlush: async () => {
          if (!this.initialScanComplete) await this.scanLocalChanges();
          this.initialScanComplete = true;
          if (this.progress.snapshot()?.phase !== 'publishing') await this.localQueue?.flushAll();
          this.progress.begin('publishing', this.store.state.operations.length);
        },
        onOperationDurable: (operation) => {
          const bytes = 'content' in operation ? operation.content.size : 0;
          if (this.progress.snapshot()?.phase === 'publishing') this.progress.increment(1, bytes);
        },
        beforeInitialCatchUp: async () => { this.progress.begin('applying'); },
      },
    );
    this.localQueue = new LocalMutationQueue(
      this.app.vault, this.app.vault.configDir, this.store, this.client, this.engine, this.adapter,
      (error) => { void this.handleLocalQueueError(error); },
      (progress) => {
        const current = this.progress.snapshot();
        if (current?.phase !== progress.phase) this.progress.begin(progress.phase, progress.totalItems, progress.totalBytes);
        this.progress.update(progress.completedItems, progress.totalItems, progress.completedBytes, progress.totalBytes);
      },
    );
    if (!this.active) { this.localQueue.dispose(); this.engine.stop(); return; }
    await this.syncNow().catch(() => {});
  }

  private schedulePendingRetry(error?: unknown): void {
    if (this.pendingRetry !== null || this.store.state.paused || !this.engine || !this.localQueue) return;
    const retryAfterMs = error instanceof ProtocolError && error.retryAfterSeconds
      ? error.retryAfterSeconds * 1_000
      : 0;
    const delay = Math.max(1_000, this.store.state.fallbackPollSeconds * 1_000, retryAfterMs);
    this.pendingRetry = window.setTimeout(() => {
      this.pendingRetry = null;
      const retry = this.engineStarted ? this.syncNow() : this.startClient();
      void retry.catch(() => {});
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
    const resume = () => { if (!activeDocument.hidden && !this.store.state.paused) void this.syncNow().catch(() => {}); };
    this.registerDomEvent(activeDocument, 'visibilitychange', resume);
    this.registerDomEvent(activeWindow, 'focus', resume);
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
    const folders = this.app.vault.getAllFolders(false).sort((a, b) => {
      const depth = a.path.split('/').length - b.path.split('/').length;
      return depth || a.path.localeCompare(b.path);
    });
    const paths = [...folders, ...this.app.vault.getFiles().sort((a, b) => a.path.localeCompare(b.path))];
    if (!this.active) return;
    await this.localQueue.reconcileAll(paths);
  }
  private setStatus(status: SyncConnectionStatus, lag: number): void {
    this.status = status; this.lag = lag; this.renderStatus();
  }
  private recordTelemetry(event: ProtocolTelemetry): void {
    const current = this.progress.snapshot();
    if (!current?.active) return;
    if (event.kind === 'manifest') {
      if (current.phase === 'manifest') this.progress.increment(event.entries);
    } else {
      this.progress.incrementRequests(event.request);
    }
  }
  private scheduleProgressRender(immediate = false): void {
    if (!this.statusEl) return;
    if (immediate) {
      if (this.progressRender !== null) window.clearTimeout(this.progressRender);
      this.progressRender = null;
      this.renderStatus();
      this.settingTab?.refreshProgress();
      return;
    }
    if (this.progressRender !== null) return;
    this.progressRender = window.setTimeout(() => {
      this.progressRender = null;
      this.renderStatus();
      this.settingTab?.refreshProgress();
    }, 250);
  }
  private renderStatus(): void {
    if (!this.statusEl) return;
    const conflict = this.conflicts > 0 ? ` · ${this.conflicts} conflict${this.conflicts === 1 ? '' : 's'}` : '';
    const progress = this.progress.snapshot();
    const progressText = progress?.active ? ` · ${formatProgress(progress)}` : '';
    this.statusEl.setText(`Central Sync: ${this.status}${progressText}${this.lag ? ` · ${this.lag} pending` : ''}${conflict}`);
    this.statusEl.setAttr('aria-label', 'Central Sync status and aggregate progress; click to sync now');
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
    this.schedulePendingRetry(error);
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
