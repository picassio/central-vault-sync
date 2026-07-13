# Security policy

## Reporting

Do not disclose a suspected credential leak, authentication bypass, path traversal, silent overwrite, or remote-code issue publicly before coordination. Open a private GitHub security advisory in this repository. Include affected versions, reproduction steps, impact, and whether a device token may have been exposed. Do not include real vault content or credentials.

## Supported versions

Until the first stable Community Plugins release, only the latest tagged pre-release receives fixes. Stable support policy will be recorded here before `1.0.0`.

## Security boundaries

- The configured WebObsidian server is trusted with plaintext vault content because it provides search and indexing.
- TLS is required outside loopback. Certificate verification is delegated to the platform; there is no insecure bypass.
- Pairing codes are one-use and short-lived. Device tokens are dedicated, revocable sync credentials stored only through Obsidian SecretStorage. SecretStorage encryption depends on the operating-system keychain; when none is available, Obsidian warns that its fallback is unencrypted. Operators must configure a keychain or treat the local account/storage as credential-sensitive.
- Server paths pass the shared normalization and exclusion policy before any Vault API mutation.
- Downloads and uploads are verified by SHA-256 and size.
- WebSocket data is advisory only; authenticated REST catch-up determines content and order.
- Plugin data contains revision metadata, hashes, paths, cursor, and blob-reference queue operations. It excludes credentials and note bodies.

## Non-goals

This protocol is not end-to-end encrypted from the server and does not synchronize the Obsidian settings directory. Mobile operating systems may suspend the app, so background synchronization is not guaranteed.
