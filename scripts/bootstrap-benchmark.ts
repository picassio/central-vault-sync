import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { TFile } from 'obsidian';
import { OrderedSyncClient, sha256Bytes, type OperationResult, type SyncOperation } from '@picassio/sync-core';

const FIXTURE_SIZE = Number.parseInt(process.env.BOOTSTRAP_FIXTURE_SIZE ?? '10000', 10);
const RUNS = Number.parseInt(process.env.BOOTSTRAP_RUNS ?? '3', 10);
const BASELINE_COMMIT = '121e03b';
const NETWORK_LATENCY_MS = 1;
const root = path.resolve(import.meta.dirname, '..');

type Implementation = {
  Main: new () => { app: { vault: FixtureVault }; active: boolean; localQueue: unknown; scanLocalChanges(): Promise<void> };
  LocalMutationQueue: typeof import('../src/local-queue').LocalMutationQueue;
  ObsidianSyncAdapter: typeof import('../src/obsidian-adapter').ObsidianSyncAdapter;
  PluginStore: typeof import('../src/plugin-store').PluginStore;
};
type Metrics = {
  elapsedMs: number;
  scans: number;
  persistenceWrites: number;
  uploads: number;
  uploadedBytes: number;
  operationRequests: number;
  publishedOperations: number;
  reconciliationRequests: number;
};

class FixtureVault {
  readonly configDir = '.obsidian';
  readonly files: TFile[];
  readonly bytes = new Map<string, Uint8Array>();
  constructor(count: number) {
    this.files = Array.from({ length: count }, (_, index) => {
      const path = `Bootstrap/Note-${String(index).padStart(5, '0')}.md`;
      const bytes = new TextEncoder().encode(`deterministic bootstrap body ${String(index).padStart(5, '0')}\n`);
      const file = Object.assign(new TFile(), {
        path, name: path.split('/').at(-1), extension: 'md',
        stat: { size: bytes.byteLength, mtime: index, ctime: index },
      });
      this.bytes.set(path, bytes);
      return file;
    });
  }
  getFiles() { return this.files; }
  getAllFolders() { return []; }
  getAbstractFileByPath(path: string) { return this.files.find((file) => file.path === path) ?? null; }
  async read(file: TFile) { return new TextDecoder().decode(this.bytes.get(file.path)!); }
  async readBinary(file: TFile) { return this.bytes.get(file.path)!.slice().buffer; }
}

async function loadImplementation(sourceRoot: string): Promise<Implementation> {
  const url = (file: string) => `${pathToFileURL(path.join(sourceRoot, 'src', file)).href}?benchmark=${Date.now()}-${Math.random()}`;
  const [{ default: Main }, { LocalMutationQueue }, { ObsidianSyncAdapter }, { PluginStore }] = await Promise.all([
    import(url('main.ts')), import(url('local-queue.ts')), import(url('obsidian-adapter.ts')), import(url('plugin-store.ts')),
  ]);
  return { Main, LocalMutationQueue, ObsidianSyncAdapter, PluginStore } as Implementation;
}

async function run(implementation: Implementation, optimized: boolean, label: string, runNumber: number): Promise<Metrics> {
  const phase = (name: string, started = performance.now()) => {
    console.error(`[bootstrap-benchmark] ${label} run ${runNumber}/${RUNS}: ${name}`);
    return started;
  };
  phase('fixture');
  const vault = new FixtureVault(FIXTURE_SIZE);
  let persistenceWrites = 0;
  const store = new implementation.PluginStore({
    app: { secretStorage: { getSecret: () => 'benchmark-token', setSecret: () => {} } },
    loadData: async () => null,
    saveData: async () => { persistenceWrites += 1; },
  } as never);
  await store.load();
  Object.assign(store.state, { deviceId: 'benchmark-device', vaultId: 'benchmark-vault', modifyDebounceMs: 60_000 });

  let uploads = 0;
  let uploadedBytes = 0;
  let operationRequests = 0;
  let publishedOperations = 0;
  let reconciliationRequests = 0;
  let scans = 0;
  const client = {
    async upload(bytes: ArrayBuffer) { uploads += 1; uploadedBytes += bytes.byteLength; },
    async download() { throw new Error('empty-server bootstrap must not download'); },
    async handshake() {
      return {
        vaultId: 'benchmark-vault', latestSequence: 0, minimumRetainedSequence: 0, readOnly: false,
        limits: { maxOperationsPerBatch: 100 }, capabilities: ['ordered-batch-stop-v1'],
      };
    },
    async manifest() { reconciliationRequests += 1; return { entries: [], snapshotSequence: 0 }; },
    async changes(after: number) {
      reconciliationRequests += 1;
      return { events: [], nextAfter: after, hasMore: false, latestSequence: after };
    },
    async acknowledge() {},
    async operations(operations: SyncOperation[]) {
      operationRequests += 1;
      publishedOperations += operations.length;
      await new Promise<void>((resolve) => setTimeout(resolve, NETWORK_LATENCY_MS));
      return operations.map((operation): OperationResult => ({
        idempotencyKey: operation.idempotencyKey, status: 'accepted',
        entry: {
          entryId: `entry-${operation.clientSequence}`,
          path: 'path' in operation ? operation.path : `entry-${operation.clientSequence}`,
          kind: 'file', revision: 1,
          hash: 'content' in operation ? operation.content.hash : null,
          size: 'content' in operation ? operation.content.size : 0,
          modifiedAt: '2026-07-16T00:00:00.000Z', deleted: false, sequence: operation.clientSequence,
        },
      }));
    },
    async connectWake() { return () => {}; },
  };
  const adapter = new implementation.ObsidianSyncAdapter(
    vault as never, { trashFile: async () => {} } as never,
    { getLeavesOfType: () => [] } as never, store, client as never, async () => true, () => {},
  );
  const scheduler = {
    timeout: () => 0, clearTimeout: () => {}, interval: () => 0, clearInterval: () => {}, random: () => 0,
  };
  let queue: InstanceType<Implementation['LocalMutationQueue']>;
  let plugin: InstanceType<Implementation['Main']>;
  const engine = new OrderedSyncClient(
    store, client as never, adapter, () => {}, scheduler, 60_000,
    optimized ? {
      beforeBootstrap: async () => {
        phase('scan + checkpoint persistence');
        scans += vault.files.length;
        await plugin.scanLocalChanges();
      },
      beforeInitialFlush: async () => { phase('uploads + durable enqueue + publication'); await queue.flushAll(); },
    } : {},
  );
  queue = new implementation.LocalMutationQueue(
    vault as never, vault.configDir, store, client as never, engine, adapter, (error) => { throw error; },
  );

  plugin = Object.create(implementation.Main.prototype) as InstanceType<Implementation['Main']>;
  Object.assign(plugin, { app: { vault }, active: true, localQueue: queue });
  const started = performance.now();
  if (optimized) {
    phase('recovery + manifest');
    await engine.start();
  } else {
    // Invoke the scan method from the exact pre-change main.ts extracted above, then retain its
    // exact startClient/syncNow ordering for upload, publication, and reconciliation.
    phase('scan + checkpoint persistence');
    scans += vault.files.length;
    await plugin.scanLocalChanges();
    phase('uploads + durable enqueue + publication');
    await queue.flushAll();
    phase('manifest + reconciliation');
    await engine.start();
    await engine.flush();
    await engine.catchUp();
  }
  const elapsedMs = performance.now() - started;
  phase(`complete in ${elapsedMs.toFixed(1)} ms`);
  engine.stop();
  queue.dispose();
  assert.equal(store.state.pendingPaths.length, 0);
  assert.equal(store.state.operations.length, 0);
  assert.equal(publishedOperations, FIXTURE_SIZE);
  assert.equal(uploads, FIXTURE_SIZE);
  return { elapsedMs, scans, persistenceWrites, uploads, uploadedBytes, operationRequests, publishedOperations, reconciliationRequests };
}

function median(values: number[]): number {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!;
}

const temporary = await mkdtemp(path.join(tmpdir(), 'central-vault-sync-baseline-'));
try {
  await mkdir(path.join(temporary, 'src'));
  const archive = execFileSync('git', ['-C', root, 'archive', BASELINE_COMMIT, 'src']);
  execFileSync('tar', ['-x', '-C', temporary], { input: archive });
  // Resolve the baseline's package imports against the exact same installed dependencies/environment.
  await writeFile(path.join(temporary, 'package.json'), JSON.stringify({ type: 'module' }));
  execFileSync('ln', ['-s', path.join(root, 'node_modules'), path.join(temporary, 'node_modules')]);

  const baselineImplementation = await loadImplementation(temporary);
  const optimizedImplementation = await loadImplementation(root);
  const baseline: Metrics[] = [];
  const optimized: Metrics[] = [];
  for (let index = 0; index < RUNS; index += 1) baseline.push(await run(baselineImplementation, false, 'baseline', index + 1));
  for (let index = 0; index < RUNS; index += 1) optimized.push(await run(optimizedImplementation, true, 'optimized', index + 1));

  const baselineMedianMs = median(baseline.map((item) => item.elapsedMs));
  const optimizedMedianMs = median(optimized.map((item) => item.elapsedMs));
  const speedup = baselineMedianMs / optimizedMedianMs;
  const maximumOperationRequests = Math.max(...optimized.map((item) => item.operationRequests));
  const report = {
    fixture: { files: FIXTURE_SIZE, runs: RUNS, operationRoundTripMs: NETWORK_LATENCY_MS },
    baseline: { commit: BASELINE_COMMIT, runs: baseline, medianMs: baselineMedianMs },
    optimized: { runs: optimized, medianMs: optimizedMedianMs },
    acceptance: { speedup, maximumOperationRequests, minimumSpeedup: 3, maximumAllowedOperationRequests: 100 },
  };
  console.log(JSON.stringify(report, null, 2));
  assert.ok(speedup >= 3, `full-plugin bootstrap speedup ${speedup.toFixed(2)}x is below 3x`);
  assert.ok(maximumOperationRequests <= 100, `optimized bootstrap used ${maximumOperationRequests} operation requests`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
