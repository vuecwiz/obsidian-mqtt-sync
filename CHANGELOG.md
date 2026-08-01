# Changelog

## 0.1.0 - 2026-07-31

- Created the independent `obsidian-mqtt-sync` project with plugin ID `mqtt-sync` and UI name **MQTT Sync**.
- Added MQTT.js transport for MQTT 3.1.1/5 over `mqtt`, `mqtts`, `ws`, and `wss`; explicit Client ID, Clean Start, Session Expiry, keep alive, reconnect, subscription QoS, retained handling, and `+`/`#` filters.
- Added bounded MQTT publication normalization including payload text/JSON, QoS, retain/duplicate, content type, user properties, response topic, correlation data, and the `obsidian.mqtt-sync.message.v1` envelope.
- Added durable identities for envelope IDs, optional correlation data, retained messages, and fingerprint-window fallback; MQTT packet IDs are diagnostic-only.
- Adapted durable inbox, Vault `mqtt-sync:v1` markers, recovery, dead letters, attachment origin/digest controls, and post-commit result outbox.
- Added bilingual settings/documentation, redacted status/diagnostics, local broker tests, contract tests, coverage, secret scan, reproducible build, and release package gates.
- Added Obsidian 1.13 searchable settings with a 1.12.7 fallback, community-compatible headings/timers, and a strict reversible `vanotes-test` UI runner.
- Accepted ADR-0001 single-active operation with explicit unique Client IDs; new connections no longer auto-generate an ID.
- Added independently reported Mosquitto 2.1.2 scenarios for MQTT 3.1.1/5, QoS 0/1/2, retain/subscription options, sessions, reconnect, WebSocket, TLS/mTLS, auth/ACL, Client ID collision, certificate negatives, mandatory verification, and reversible harness cleanup.
- Expanded durable fault injection and changed state replacement to backup plus staged rename recovery.
- Fixed unresolved MQTT.js renderer shims in the production bundle and added a runtime-import release gate.
- Restored the complete message distribution rule UI from the ntfy-sync interaction model, adapted to MQTT fields and first-match routing, with deterministic and durable integration coverage.
- Replaced slash-separated bilingual settings labels with a selectable Follow Obsidian/English/简体中文 interface and verified both explicit locales in Obsidian.
- Moved CA, client certificate, and private key PEM editors into a dedicated TLS certificate dialog; the general settings page now exposes one configuration button.
- Removed the inline Client ID error message while retaining validation when settings are applied or receiving starts.
- Moved Apply beside the Primary connection heading and added a bounded, no-subscription Test connection handshake using a collision-safe temporary Client ID.
- Removed rule-section side indentation so its heading and cards align with the other full-width settings.
- Made the Primary connection and Message distribution rules heading rows transparent while retaining their right-aligned actions.
- Placed insecure remote transport immediately above TLS certificates; enabling it disables TLS certificate editing without deleting saved certificate material.
- Added localized MQTT delivery semantics to both requested and result QoS dropdowns: at most once, at least once, and exactly once.
- Documented and exercised the explicitly authorized EMQX public Broker interoperability matrix, including the published public CA certificate and reversible plugin end-to-end evidence.
- Expanded unit coverage for settings security policy, migration, templates, Vault paths, attachment planning, insertion modes, and concurrent idempotent writes; added real-Broker pipeline integration plus ignored-message and dead-letter result scenarios.
- Expanded the isolated UI rule fixture from two rules to seven: MQTT Topic/QoS/retain routing plus Ntfy-inspired URL host, HTTP URL, priority/attachment/MIME, after-heading, and final fallback cases, using synthetic values only.
- Allowed rule-modal saves before broker setup by validating only the complete candidate rule set and its dependencies; connection-test clients and timers now cancel on plugin unload, and UI acceptance exercises persisted add, toggle, reorder, edit, and delete mutations. Screenshot runs also normalize the test window onto the available display before capture and restore its original position.
- Added a CDP-backed bilingual, four-resolution documentation sample workflow across matching Simplified Chinese and English host/plugin groups. Eight scenes per resolution retain the complete settings window and core navigation while showing populated, privacy-masked synthetic settings; the public repository includes six selected, reviewed 1440×900 images, while reversible test-Vault cleanup restores host language and plugin state.
- Added an independently enabled, sanitized `test.mosquitto.org` interoperability runner with bounded MQTT 3.1.1/5, QoS, wildcard, retained cleanup, authentication/ACL, private/system CA TLS, expired-certificate, optional mTLS, WS, and WSS scenarios. It remains outside every default gate and includes separate detailed design and usage documentation.
- Reduced TLS PEM editors from a 12rem minimum to six rows/8rem, and made UI acceptance load two documented valid public CAs to verify populated content, internal scrolling, privacy-safe reporting, and reversible test-Vault cleanup.
- Reorganized the English and Simplified Chinese READMEs as task-oriented product guides, with numbered message flow, grouped features, initial configuration, three localized privacy-reviewed UI screenshots, complete rule/operator/template references, status and command guidance, build/acceptance tables, security limits, and recorded AGPL provenance for the reference information architecture.
