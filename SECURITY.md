# Security policy

## Supported version

Security fixes target the current `0.1.x` line. MQTT Sync is desktop-only.

## Trust boundary

Broker publications, MQTT 5 properties, JSON envelopes, URLs, filenames, and result response metadata are untrusted. The plugin enforces payload/property/JSON/path/download limits before Vault effects. It never runs shell commands, evaluates JavaScript templates, disables TLS certificate verification, or forwards broker credentials to attachment origins.

`data.json` may contain username/password and TLS client material. `state-v1.json` may contain normalized message bodies. Protect the Vault and backups accordingly; Obsidian sync or third-party backup tools may copy both. Redacted diagnostics omit secrets and bodies and hash broker, topic/filter, Client ID, and correlation identifiers.

Synchronized `data.json` may also copy `deviceId`, `writerDeviceId`, and Client IDs. Phase 1 requires one active writer/subscriber per synchronized Vault and an explicitly configured unique Client ID on every enabled device/connection. Do not enable two synchronized copies; the fields in `data.json` are not a device-local lock.

Plain `mqtt`/`ws` is loopback-only unless the user explicitly enables insecure remote transport. Attachment download is off by default and requires an exact HTTPS origin allow-list, same-origin redirects, byte/time limits, and optional digest validation.

## Reporting

Do not open a public issue containing a broker URL, topic, Client ID, credential, private key, message payload, Vault path, or state file. Send a minimal private report to the maintainer listed in `manifest.json`, including the affected version, impact, reproduction using synthetic values, and whether credentials may have been exposed.

Revoke exposed broker credentials and client certificates, rotate stable IDs if needed, disable the plugin, and preserve redacted diagnostics plus corrupt-state snapshots for investigation.
