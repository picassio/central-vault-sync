import assert from 'node:assert/strict';
import test from 'node:test';
import type { App, SettingDefinitionGroup } from 'obsidian';
import { DEFAULT_STATE } from '../src/plugin-store';
import { CentralSyncSettingTab, type SyncPluginController } from '../src/settings';

test('settings expose one searchable definition source and normalize persisted controls', async () => {
  let saves = 0;
  const controller: SyncPluginController = {
    app: { vault: { configDir: 'custom-config' } } as unknown as App,
    store: { state: structuredClone(DEFAULT_STATE), save: async () => { saves += 1; } },
    pair: async () => {}, unpair: async () => {}, testConnection: async () => 'ok', syncNow: async () => {}, diagnostics: () => '{}',
  };
  const tab = new CentralSyncSettingTab(controller.app, controller);
  (tab as unknown as { app: App }).app = controller.app;
  const groups = tab.getSettingDefinitions() as SettingDefinitionGroup[];
  assert.deepEqual(groups.map((group) => group.heading), [undefined, 'Status and diagnostics']);
  const names = groups.flatMap((group) => group.items ?? []).filter((item) => 'name' in item).map((item) => item.name);
  assert.ok(names.includes('Server URL'));
  assert.ok(names.includes('One-time pairing code'));
  assert.ok(names.includes('Copy redacted diagnostics') === false);

  await tab.setControlValue('deviceName', '   ');
  await tab.setControlValue('fallbackPollSeconds', 999);
  await tab.setControlValue('modifyDebounceMs', 1);
  await tab.setControlValue('excludeGlobs', ' private/**, , archive/** ');
  assert.equal(controller.store.state.deviceName, 'Obsidian');
  assert.equal(controller.store.state.fallbackPollSeconds, 300);
  assert.equal(controller.store.state.modifyDebounceMs, 250);
  assert.deepEqual(controller.store.state.excludeGlobs, ['private/**', 'archive/**']);
  assert.equal(saves, 4);
});
