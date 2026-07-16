import assert from 'node:assert/strict';
import test from 'node:test';
import { formatProgress, SyncProgressModel } from '../src/sync-progress';
import { parseRetryAfter } from '../src/protocol-client';

test('progress is monotonic within a phase and contains only aggregate values', () => {
  const progress = new SyncProgressModel();
  progress.begin('scanning', 10, 2_048);
  progress.update(6, 10, 1_024, 2_048);
  progress.update(4, 8, 512, 1_000);
  const snapshot = progress.snapshot();
  assert.equal(snapshot?.completedItems, 6);
  assert.equal(snapshot?.totalItems, 10);
  assert.equal(snapshot?.completedBytes, 1_024);
  assert.equal(snapshot?.totalBytes, 2_048);
  assert.equal(formatProgress(snapshot), 'scanning 6/10 · 1.0 KiB/2.0 KiB');
  assert.deepEqual(Object.keys(snapshot ?? {}).sort(), [
    'active', 'blobRequests', 'completedBytes', 'completedItems', 'elapsedMs', 'operationRequests',
    'phase', 'resumed', 'startedAt', 'totalBytes', 'totalItems', 'updatedAt',
  ]);
});

test('all seven progress phases can be represented and final progress is retained as inactive', () => {
  const progress = new SyncProgressModel();
  for (const phase of ['recovering', 'manifest', 'scanning', 'uploading', 'publishing', 'applying', 'finalizing'] as const) {
    progress.begin(phase, 1);
    progress.update(1, 1);
    assert.equal(progress.snapshot()?.phase, phase);
  }
  progress.finish();
  assert.equal(progress.snapshot()?.active, false);
  assert.equal(progress.snapshot()?.completedItems, 1);
});

test('unknown totals remain absent and telemetry tracks requests, elapsed time, and resumed retries', () => {
  let now = 1_000;
  const renders: boolean[] = [];
  const progress = new SyncProgressModel((immediate) => renders.push(immediate), () => now);
  progress.begin('manifest');
  progress.incrementRequests('operation', 2);
  progress.incrementRequests('blob');
  now = 1_750;
  assert.deepEqual(progress.snapshot(), {
    phase: 'manifest', completedItems: 0, completedBytes: 0, active: true,
    startedAt: new Date(1_000).toISOString(), updatedAt: new Date(1_000).toISOString(),
    operationRequests: 2, blobRequests: 1, elapsedMs: 750, resumed: false,
  });
  progress.begin('manifest');
  assert.equal(progress.snapshot()?.resumed, true);
  assert.equal(progress.snapshot()?.completedItems, 0, 'retry must not falsely complete unknown work');
  progress.finish();
  assert.equal(progress.snapshot()?.completedItems, 0, 'finish must not invent an unknown total');
  assert.deepEqual(renders, [true, false, false, true, true]);
});

test('phase order rejects regressions unless an explicit lifecycle restart resumes from recovery', () => {
  const progress = new SyncProgressModel();
  progress.begin('recovering');
  assert.throws(() => progress.begin('scanning'), /phase order/);
  progress.begin('recovering');
  assert.equal(progress.snapshot()?.resumed, true);
  progress.begin('manifest');
  progress.begin('scanning');
  progress.begin('uploading');
  progress.incrementRequests('blob', 3);
  progress.restart('recovering', 2);
  assert.deepEqual(progress.snapshot() && {
    phase: progress.snapshot()!.phase, completedItems: progress.snapshot()!.completedItems,
    totalItems: progress.snapshot()!.totalItems, resumed: progress.snapshot()!.resumed,
    blobRequests: progress.snapshot()!.blobRequests,
  }, { phase: 'recovering', completedItems: 0, totalItems: 2, resumed: true, blobRequests: 3 });
  progress.begin('manifest');
});

test('Retry-After supports delta seconds and HTTP dates', () => {
  const now = Date.parse('2026-07-16T00:00:00.000Z');
  assert.equal(parseRetryAfter('2.1', now), 3);
  assert.equal(parseRetryAfter('Thu, 16 Jul 2026 00:00:05 GMT', now), 5);
  assert.equal(parseRetryAfter('Thu, 16 Jul 2026 00:00:00 GMT', now), undefined);
  assert.equal(parseRetryAfter('not-a-date', now), undefined);
});
