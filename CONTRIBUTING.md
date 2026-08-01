# Contributing

MQTT Sync accepts focused changes with deterministic tests and matching English/Chinese documentation for user-visible behavior.

## Development

Use Node.js 22 or later:

```bash
npm ci
npm run format
npm run verify
npm run test:e2e
```

Default tests must not use a public broker. Unit tests cover topic/normalization/settings; contract tests cover MQTT 5 properties and the JSON envelope; integration tests use an isolated process-internal broker and in-memory Vault/state adapters. `npm run test:e2e` may start an installed Mosquitto only as a temporary foreground loopback process; it must never enable a system service. Obsidian UI automation accepts only an explicit Vault named `vanotes-test`. Missing prerequisites are blocked/skipped, never passed.

Public interoperability runners require explicit authorization and must remain outside every default gate. Pass credentials only through protected environment variables, keep logs sanitized, use bounded timeouts, and retain machine-readable cleanup results under ignored `.artifacts/` directories.

Preserve these boundaries:

- persist accepted publications before rules or effects;
- never use MQTT packet IDs as durable identities;
- treat QoS and Vault effective-once as separate guarantees;
- keep result publication after the Vault commit and in a durable outbox;
- validate paths, payloads, properties, attachment origins, redirects, sizes, timeouts, and digests;
- never add a TLS verification bypass or log secrets/payloads.

Before submitting, inspect the diff for credentials, broker/topic values, private Vault paths, `data.json`, `state-v1*.json`, `.artifacts`, bundles, and release archives. Describe the motivation, tests actually run, remaining broker interoperability risks, and screenshots for UI changes. Do not publish a release as part of a contribution.
