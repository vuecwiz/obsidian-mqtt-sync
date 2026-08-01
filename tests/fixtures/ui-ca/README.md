# Public CA fixtures for UI tests

These certificates are public trust fixtures used only to populate and measure the TLS certificate editor. They contain no client key or private material.

| File | Public source | Valid until |
| --- | --- | --- |
| `mosquitto-org-ca.pem` | <https://test.mosquitto.org/ssl/mosquitto.org.crt> | 2030-06-07 UTC |
| `digicert-global-root-ca.pem` | <https://assets.emqx.com/data/broker.emqx.io-ca.crt> | 2031-11-10 UTC |

The UI runner parses every fixture with Node.js `X509Certificate` and fails when a certificate is outside its validity window. When replacing a fixture, retrieve it from the documented official HTTPS origin, inspect it independently, update this table, and run `npm run test:unit`, `npm run test:ui`, and `npm run test:secrets`.
