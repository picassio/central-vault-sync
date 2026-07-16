import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';
import {
  BlobUploadCreateResponseSchema,
  ChangesResponseSchema,
  ConflictsResponseSchema,
  DEFAULT_LIMITS,
  HandshakeResponseSchema,
  ManifestPageSchema,
  OperationsResponseSchema,
  PairResponseSchema,
  PROTOCOL_VERSION,
  sha256Bytes,
  WsTicketResponseSchema,
  type ClientDeviceIdentity,
  type SyncClientTransport,
  type Conflict,
  type SyncEntry,
  type SyncOperation,
} from '@picassio/sync-core';

export class ProtocolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable = false,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export type ProtocolTelemetry =
  | { kind: 'request'; request: 'operation' | 'blob' }
  | { kind: 'manifest'; entries: number };

export class ProtocolClient implements SyncClientTransport {
  readonly baseUrl: string;
  private retryNotBefore = 0;
  constructor(
    serverUrl: string,
    private token: string,
    private readonly telemetry: (event: ProtocolTelemetry) => void = () => {},
  ) {
    this.baseUrl = validateServerUrl(serverUrl);
  }
  setToken(token: string): void { this.token = token; }

  static async pair(serverUrl: string, code: string, deviceId: string, deviceName: string) {
    const client = new ProtocolClient(serverUrl, 'pairing');
    const response = await client.request('/pair', {
      method: 'POST', body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, code, deviceId, deviceName }),
    }, false);
    return PairResponseSchema.parse(response.json);
  }

  async handshake(device: ClientDeviceIdentity) {
    const response = await this.request('/handshake', {
      method: 'POST', body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION, deviceId: device.deviceId, deviceName: device.deviceName,
        lastAppliedSequence: device.cursor, capabilities: ['obsidian-vault-api-v1', 'apply-intent-v1', 'resumable-blob-v1'],
      }),
    });
    return HandshakeResponseSchema.parse(response.json);
  }

  async manifest() {
    const entries: SyncEntry[] = [];
    let cursor: string | null = null;
    let snapshotSequence = 0;
    do {
      const response = await this.request(`/manifest${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      const page = ManifestPageSchema.parse(response.json);
      entries.push(...page.entries);
      this.telemetry({ kind: 'manifest', entries: page.entries.length });
      snapshotSequence = page.snapshotSequence;
      cursor = page.nextCursor;
    } while (cursor);
    return { entries, snapshotSequence };
  }

  async changes(after: number, limit: number) {
    return ChangesResponseSchema.parse((await this.request(`/changes?after=${after}&limit=${limit}`)).json);
  }
  async acknowledge(sequence: number) {
    await this.request('/ack', { method: 'POST', body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, sequence }) });
  }
  async operations(operations: SyncOperation[]) {
    return OperationsResponseSchema.parse((await this.request('/operations', {
      method: 'POST', body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, operations }),
    })).json).results;
  }

  async conflicts(): Promise<Conflict[]> {
    return ConflictsResponseSchema.parse((await this.request('/conflicts')).json).conflicts;
  }
  async resolveConflict(
    conflictId: string,
    resolution: 'keep-server' | 'keep-client' | 'merged' | 'copy',
    clientSequence: number,
    idempotencyKey: string,
    mergedText?: string,
  ): Promise<void> {
    let mergedContent: { hash: string; size: number; inlineText?: string; blobHash?: string } | undefined;
    if (resolution === 'merged') {
      if (mergedText === undefined) throw new Error('merged text is required');
      const bytes = new TextEncoder().encode(mergedText);
      const hash = sha256Bytes(bytes);
      if (bytes.byteLength <= DEFAULT_LIMITS.inlineTextBytes) mergedContent = { hash, size: bytes.byteLength, inlineText: mergedText };
      else { await this.upload(bytes.slice().buffer, hash); mergedContent = { hash, size: bytes.byteLength, blobHash: hash }; }
    }
    await this.request(`/conflicts/${encodeURIComponent(conflictId)}/resolve`, {
      method: 'POST', body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION, clientSequence, idempotencyKey, resolution,
        ...(mergedContent ? { mergedContent } : {}),
      }),
    });
  }
  async downloadBlob(hash: string): Promise<ArrayBuffer> {
    return (await this.request(`/blobs/${encodeURIComponent(hash)}`, {}, true, false)).arrayBuffer;
  }

  async connectWake(wake: () => void, closed: () => void): Promise<() => void> {
    const ticket = WsTicketResponseSchema.parse((await this.request('/ws-tickets', { method: 'POST', body: '{}' })).json).ticket;
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/sync/v1/ws`;
    url.search = `ticket=${encodeURIComponent(ticket)}`;
    const socket = new WebSocket(url.toString());
    socket.onmessage = (message) => {
      try { if ((JSON.parse(String(message.data)) as { type?: string }).type === 'sync.changed') wake(); } catch { /* wake messages carry no content */ }
    };
    socket.onerror = () => socket.close();
    socket.onclose = closed;
    return () => socket.close();
  }

  async download(entryId: string, revision: number): Promise<{ bytes: ArrayBuffer; hash: string }> {
    const response = await this.request(`/files/${encodeURIComponent(entryId)}?revision=${revision}`, {}, true, false);
    return { bytes: response.arrayBuffer, hash: stripEtag(response.headers.etag ?? response.headers.ETag ?? '') };
  }

  async upload(bytes: ArrayBuffer, hash: string): Promise<void> {
    if (bytes.byteLength === 0) return;
    const chunkSize = DEFAULT_LIMITS.blobChunkBytes;
    const created = BlobUploadCreateResponseSchema.parse((await this.request('/blob-uploads', {
      method: 'POST', body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, hash, size: bytes.byteLength, chunkSize }),
    })).json);
    for (const part of created.missingParts) {
      const start = part * chunkSize;
      await this.request(`/blob-uploads/${encodeURIComponent(created.uploadId)}/${part}`, {
        method: 'PUT', body: bytes.slice(start, Math.min(bytes.byteLength, start + chunkSize)),
        contentType: 'application/octet-stream',
      }, true, false);
    }
    await this.request(`/blob-uploads/${encodeURIComponent(created.uploadId)}/complete`, { method: 'POST', body: '{}' });
  }

  private async request(
    path: string,
    options: Partial<RequestUrlParam> = {},
    authenticated = true,
    expectJson = true,
  ): Promise<RequestUrlResponse> {
    const retryDelay = this.retryNotBefore - Date.now();
    if (retryDelay > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, retryDelay));
    if (path === '/operations') this.telemetry({ kind: 'request', request: 'operation' });
    else if (path.startsWith('/blob-uploads') || path.startsWith('/blobs/')) this.telemetry({ kind: 'request', request: 'blob' });
    const response = await requestUrl({
      url: `${this.baseUrl}/api/sync/v1${path}`,
      method: options.method ?? 'GET',
      body: options.body,
      contentType: options.contentType ?? (expectJson ? 'application/json' : undefined),
      headers: { ...(authenticated ? { Authorization: `Bearer ${this.token}` } : {}), ...(options.headers ?? {}) },
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      const payload = response.json as { error?: { code?: string; message?: string; retryable?: boolean; details?: { retryAfter?: number } } } | undefined;
      const error = payload?.error;
      const retryAfterSeconds = parseRetryAfter(
        error?.details?.retryAfter ?? response.headers['retry-after'] ?? response.headers['Retry-After'],
      );
      if (retryAfterSeconds) this.retryNotBefore = Math.max(this.retryNotBefore, Date.now() + retryAfterSeconds * 1_000);
      const baseMessage = error?.message ?? `HTTP ${response.status}`;
      const displayMessage = error?.code === 'rate_limited' && retryAfterSeconds
        ? `${baseMessage}; retry in ${retryAfterSeconds} seconds`
        : baseMessage;
      throw new ProtocolError(error?.code ?? `http_${response.status}`, displayMessage, response.status, error?.retryable, retryAfterSeconds);
    }
    return response;
  }
}

export function validateServerUrl(value: string): string {
  const url = new URL(value.trim());
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error('Server URL must use HTTPS outside loopback');
  }
  url.hash = ''; url.search = '';
  return url.toString().replace(/\/$/, '');
}

export function parseRetryAfter(value: unknown, now = Date.now()): number | undefined {
  if (typeof value === 'number' || (typeof value === 'string' && /^\s*\d+(?:\.\d+)?\s*$/u.test(value))) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt) || retryAt <= now) return undefined;
  return Math.ceil((retryAt - now) / 1_000);
}

function stripEtag(value: string): string { return value.replace(/^W\//, '').replaceAll('"', ''); }
