import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ChangesResponseSchema,
  HandshakeRequestSchema,
  HandshakeResponseSchema,
  ManifestPageSchema,
  OperationsRequestSchema,
  OperationsResponseSchema,
  PROTOCOL_VERSION,
} from '@picassio/sync-core';

test('plugin consumes the published Sync Protocol 1.0 golden fixtures', async () => {
  const fixtureUrl = new URL(import.meta.resolve('@picassio/sync-core/fixtures/protocol-v1.json'));
  const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8')) as Record<string, unknown>;
  assert.equal(PROTOCOL_VERSION, '1.0');
  HandshakeRequestSchema.parse(fixture.handshakeRequest);
  HandshakeResponseSchema.parse(fixture.handshakeResponse);
  ManifestPageSchema.parse(fixture.manifestPage);
  ChangesResponseSchema.parse(fixture.changesResponse);
  OperationsRequestSchema.parse(fixture.operationsRequest);
  OperationsResponseSchema.parse(fixture.operationsResponse);
  assert.throws(() => HandshakeResponseSchema.parse({
    ...(fixture.handshakeResponse as object), protocolVersion: '1.1',
  }), /protocolVersion/);
});
