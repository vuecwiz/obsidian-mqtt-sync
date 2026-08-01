import mqtt from "mqtt";
import type { ConnectionConfigV1 } from "../../src/domain/types";
import { clientOptions } from "../../src/transport/mqtt/connection";

describe("real Broker TLS verification policy", () => {
  it("keeps certificate verification mandatory against the isolated self-signed Broker", async () => {
    const brokerUrl = process.env.MQTT_E2E_TLS_POLICY_URL;
    if (!brokerUrl) throw new Error("MQTT_E2E_TLS_POLICY_URL is required");
    const config: ConnectionConfigV1 = {
      id: "tls-policy",
      name: "TLS policy",
      brokerUrl,
      protocolVersion: 5,
      clientId: "mqtt-sync-tls-policy",
      auth: {},
      tls: {},
      allowInsecureRemote: false,
      keepAliveSeconds: 10,
      connectTimeoutMs: 3_000,
      cleanStart: true,
      sessionExpirySeconds: 0,
      subscriptions: [],
      reconnect: { minMs: 100, maxMs: 1_000, jitterRatio: 1 },
      useCorrelationDataAsId: false,
    };
    const options = clientOptions(config);
    expect(options.rejectUnauthorized).toBe(true);
    await expect(mqtt.connectAsync(brokerUrl, options)).rejects.toThrow();
  });
});
