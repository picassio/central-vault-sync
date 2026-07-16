export type SyncProgressPhase =
  | 'recovering'
  | 'manifest'
  | 'scanning'
  | 'uploading'
  | 'publishing'
  | 'applying'
  | 'finalizing';

export interface SyncProgressSnapshot {
  phase: SyncProgressPhase;
  completedItems: number;
  totalItems?: number;
  completedBytes: number;
  totalBytes?: number;
  operationRequests: number;
  blobRequests: number;
  elapsedMs: number;
  resumed: boolean;
  active: boolean;
  startedAt: string;
  updatedAt: string;
}

const PHASES: SyncProgressPhase[] = [
  'recovering', 'manifest', 'scanning', 'uploading', 'publishing', 'applying', 'finalizing',
];

export class SyncProgressModel {
  private snapshotValue: Omit<SyncProgressSnapshot, 'elapsedMs'> | null = null;
  private startedMs = 0;

  constructor(
    private readonly changed: (immediate: boolean) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  begin(phase: SyncProgressPhase, totalItems?: number, totalBytes?: number): void {
    const prior = this.snapshotValue;
    const resumed = Boolean(prior?.active && prior.phase === phase);
    if (prior?.active && !resumed && PHASES.indexOf(phase) !== PHASES.indexOf(prior.phase) + 1) {
      throw new Error(`progress phase order cannot move from ${prior.phase} to ${phase}`);
    }
    const nowMs = this.now();
    if (!prior?.active) this.startedMs = nowMs;
    const timestamp = new Date(nowMs).toISOString();
    this.snapshotValue = {
      phase,
      completedItems: resumed ? prior!.completedItems : 0,
      ...(totalItems === undefined
        ? (resumed && prior?.totalItems !== undefined ? { totalItems: prior.totalItems } : {})
        : { totalItems: Math.max(nonNegative(totalItems), resumed ? prior?.totalItems ?? 0 : 0, resumed ? prior?.completedItems ?? 0 : 0) }),
      completedBytes: resumed ? prior!.completedBytes : 0,
      ...(totalBytes === undefined
        ? (resumed && prior?.totalBytes !== undefined ? { totalBytes: prior.totalBytes } : {})
        : { totalBytes: Math.max(nonNegative(totalBytes), resumed ? prior?.totalBytes ?? 0 : 0, resumed ? prior?.completedBytes ?? 0 : 0) }),
      operationRequests: prior?.active ? prior.operationRequests : 0,
      blobRequests: prior?.active ? prior.blobRequests : 0,
      resumed,
      active: true,
      startedAt: prior?.active ? prior.startedAt : timestamp,
      updatedAt: timestamp,
    };
    this.changed(true);
  }

  restart(phase: SyncProgressPhase, totalItems?: number, totalBytes?: number): void {
    const prior = this.snapshotValue;
    if (!prior?.active) { this.begin(phase, totalItems, totalBytes); return; }
    const nowMs = this.now();
    const timestamp = new Date(nowMs).toISOString();
    this.snapshotValue = {
      phase, completedItems: 0, ...(totalItems === undefined ? {} : { totalItems: nonNegative(totalItems) }),
      completedBytes: 0, ...(totalBytes === undefined ? {} : { totalBytes: nonNegative(totalBytes) }),
      operationRequests: prior.operationRequests, blobRequests: prior.blobRequests,
      resumed: true, active: true, startedAt: prior.startedAt, updatedAt: timestamp,
    };
    this.changed(true);
  }

  update(completedItems: number, totalItems?: number, completedBytes = 0, totalBytes?: number): void {
    if (!this.snapshotValue) return;
    const current = this.snapshotValue;
    current.completedItems = Math.max(current.completedItems, nonNegative(completedItems));
    if (totalItems !== undefined) current.totalItems = Math.max(current.totalItems ?? 0, nonNegative(totalItems), current.completedItems);
    current.completedBytes = Math.max(current.completedBytes, nonNegative(completedBytes));
    if (totalBytes !== undefined) current.totalBytes = Math.max(current.totalBytes ?? 0, nonNegative(totalBytes), current.completedBytes);
    current.updatedAt = new Date(this.now()).toISOString();
    this.changed(false);
  }

  increment(items = 1, bytes = 0): void {
    if (!this.snapshotValue) return;
    this.update(this.snapshotValue.completedItems + items, undefined, this.snapshotValue.completedBytes + bytes);
  }

  incrementRequests(kind: 'operation' | 'blob', count = 1): void {
    if (!this.snapshotValue) return;
    if (kind === 'operation') this.snapshotValue.operationRequests += nonNegative(count);
    else this.snapshotValue.blobRequests += nonNegative(count);
    this.snapshotValue.updatedAt = new Date(this.now()).toISOString();
    this.changed(false);
  }

  finish(): void {
    if (!this.snapshotValue) return;
    if (this.snapshotValue.totalItems !== undefined) this.snapshotValue.completedItems = this.snapshotValue.totalItems;
    if (this.snapshotValue.totalBytes !== undefined) this.snapshotValue.completedBytes = this.snapshotValue.totalBytes;
    this.snapshotValue.active = false;
    this.snapshotValue.updatedAt = new Date(this.now()).toISOString();
    this.changed(true);
  }

  snapshot(): SyncProgressSnapshot | null {
    return this.snapshotValue ? { ...this.snapshotValue, elapsedMs: Math.max(0, this.now() - this.startedMs) } : null;
  }
}

export function formatProgress(progress: SyncProgressSnapshot | null): string | null {
  if (!progress) return null;
  const items = progress.totalItems === undefined ? String(progress.completedItems) : `${progress.completedItems}/${progress.totalItems}`;
  const bytes = progress.totalBytes === undefined ? '' : ` · ${formatBytes(progress.completedBytes)}/${formatBytes(progress.totalBytes)}`;
  return `${progress.phase} ${items}${bytes}`;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}
