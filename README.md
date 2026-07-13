# Central Vault Sync

Revision-safe two-way synchronization between an Obsidian vault and a self-hosted WebObsidian server. The server is authoritative: every accepted mutation receives a stable entry identity, revision, content hash, and ordered journal sequence.

> **Pre-release:** `0.1.0` is for local integration testing. It is not yet listed in Community Plugins.

## Safety properties

- Never silently overwrites a stale server revision.
- Publishes durable local operations before pulling newer remote bytes, so the server can merge or preserve both versions.
- Uses deterministic three-way merge only for independent UTF-8 text edits; overlaps and binary divergence become conflict copies.
- Persists queue markers, blob-reference operations, cursor, and apply intents before acknowledging work.
- Verifies every downloaded and uploaded file by SHA-256 and byte length.
- Suppresses remote-apply echoes by expected path and hash, not a timer-only flag.
- Keeps credentials out of the vault and plugin `data.json` through Obsidian SecretStorage.

## Requirements

- Obsidian 1.11.4 or newer on desktop, Android, or iOS.
- A reachable WebObsidian server with Central Sync Protocol 1.0.
- HTTPS for every non-loopback server URL.
- A 10-minute one-use pairing code created in WebObsidian **Settings → Central Sync**.

## Install for local testing

1. Run `npm install && npm run check`.
2. Copy `main.js`, `manifest.json`, and `styles.css` to:
   `<vault>/.obsidian/plugins/central-vault-sync/`.
3. Reload Obsidian and enable **Central Vault Sync** in Community plugins.
4. Open plugin settings, enter the server URL, device name, and one-use pairing code.
5. Run **Central Vault Sync: Sync now** from the command palette.

A public release attaches those same three files to a GitHub release whose tag exactly matches `manifest.json`.

## Behavior

- Initial load captures a snapshot-consistent server manifest, reconciles durable local work, then applies ordered changes.
- WebSocket messages are sequence-only wake-ups. REST manifest/change/file/blob endpoints remain authoritative.
- Fallback polling runs while the app is active; reconnect uses bounded exponential backoff.
- Create, modify, rename, delete, attachments, empty folders, Unicode paths, and case-sensitive identities use the native Vault API.
- Local editor bursts debounce for 750 ms by default. Plugin unload attempts to flush and always leaves a durable marker for unfinished paths.
- Commands: **Sync now**, **Pause or resume**, **View status**, **View conflicts**, **Reconnect**, and **Reset local sync state**.

### Mobile lifecycle

Mobile operating systems suspend background apps. This plugin does **not** promise sync while suspended. It catches up on plugin load, app focus, visible foreground, active-leaf changes, reconnect, and manual sync. Files at or above the configurable threshold (100 MiB by default) require confirmation before download on mobile.

## Exclusions

The server always excludes the configured Obsidian settings directory, `.git/**`, `.trash/**`, temporary/editor files, OS metadata, and Central Sync internals. Device-specific exclude globs may be stricter but can never re-include server exclusions. Workspace layout remains device-local.

## Conflicts

The status bar and notices report unresolved conflicts without blocking unrelated files. Open WebObsidian **Settings → Central Sync** to compare base/server/client text, edit a merged result, choose either winner, retain both copies, or download both binary versions. Canonical server bytes remain unchanged until an explicit resolution.

## Privacy and network behavior

- Connects only to the server URL configured by the user.
- Sends vault file paths, content/hashes, device name, revisions, queue operations, acknowledgements, pairing exchange, and diagnostics needed for synchronization.
- Does not use analytics, advertising, telemetry, third-party APIs, or remote code execution.
- The device bearer token is stored only through Obsidian SecretStorage and is never written to plugin data, logs, diagnostics, or the vault. Encryption at rest depends on a working platform keychain; Obsidian shows its own warning and may use an unencrypted fallback when no secret store is available. Configure a keychain on shared/untrusted systems.
- Redacted diagnostics include server origin, device/vault IDs, cursor/queue counts, platform flags, exclusions, and sanitized errors; they exclude credentials and note content.
- Server administrators can revoke a device immediately.

See [SECURITY.md](SECURITY.md) for reporting and threat-model details.

## Development

```bash
npm install
npm run check
```

The repository temporarily consumes the exact locally packed `@webobsidian/sync-core@0.1.0` artifact under `vendor/` for reproducible integration before npm publication. The stable release switches to the public npm package without source duplication.

## License

MIT — see [LICENSE](LICENSE).
