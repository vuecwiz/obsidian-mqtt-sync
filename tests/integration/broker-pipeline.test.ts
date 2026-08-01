import { createServer, type Server } from "node:net";
import Aedes from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import { MessageProcessor } from "../../src/app/processor";
import { ResultOutboxService } from "../../src/app/result-outbox";
import type { ConnectionConfigV1 } from "../../src/domain/types";
import { AttachmentService } from "../../src/effects/attachment";
import { VaultWriter } from "../../src/effects/vault-writer";
import { DurableInboxService } from "../../src/inbox/durable-inbox";
import { createDefaultSettings } from "../../src/settings/defaults";
import { JsonStateStore } from "../../src/state/store";
import { MQTTConnectionRunner } from "../../src/transport/mqtt/connection";
import { MemoryStateAdapter } from "../helpers/memory-state-adapter";
import { MemoryVault } from "../helpers/memory-vault";

describe("real broker to durable Vault pipeline", () => {
  let broker: InstanceType<typeof Aedes>;
  let server: Server;
  let url: string;
  let clients: MqttClient[];
  let runner: MQTTConnectionRunner | undefined;

  beforeEach(async () => {
    broker = new Aedes();
    server = createServer(broker.handle);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing broker address");
    url = `mqtt://127.0.0.1:${address.port}`;
    clients = [];
  });

  afterEach(async () => {
    await runner?.stop();
    await Promise.all(
      clients.map(
        (client) => new Promise<void>((resolve) => client.end(true, {}, () => resolve())),
      ),
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  });

  async function connect(id: string): Promise<MqttClient> {
    const client = mqtt.connect(url, { clientId: id, protocolVersion: 4, reconnectPeriod: 0 });
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", () => resolve());
      client.once("error", reject);
    });
    return client;
  }

  it("persists before routing, writes one marker for a duplicate envelope and publishes one result", async () => {
    const config: ConnectionConfigV1 = {
      id: "pipeline",
      name: "Pipeline",
      brokerUrl: url,
      protocolVersion: 4,
      clientId: "pipeline-plugin",
      auth: {},
      tls: {},
      allowInsecureRemote: false,
      keepAliveSeconds: 10,
      connectTimeoutMs: 2_000,
      cleanStart: true,
      sessionExpirySeconds: 0,
      subscriptions: [
        {
          filter: "pipeline/input",
          qos: 1,
          noLocal: true,
          retainAsPublished: true,
          retainHandling: 2,
          enabled: true,
        },
      ],
      reconnect: { minMs: 10, maxMs: 100, jitterRatio: 1 },
      useCorrelationDataAsId: false,
      result: { topic: "pipeline/result", qos: 1, retain: false, privacy: "minimal" },
    };
    const settings = createDefaultSettings();
    settings.connections = [config];
    settings.rules.rules[0]!.action.notePathTemplate = "MQTT Sync/Pipeline.md";

    const store = new JsonStateStore(new MemoryStateAdapter(), "plugin");
    await store.load();
    const inbox = new DurableInboxService(store);
    const vault = new MemoryVault();
    const outbox = new ResultOutboxService(inbox, () => settings.connections);
    const processor = new MessageProcessor(
      () => settings,
      inbox,
      new VaultWriter(vault),
      new AttachmentService(vault),
      outbox,
    );
    runner = new MQTTConnectionRunner(config, settings.processing.maxPayloadBytes, 600, {
      accept: async (incoming) => {
        if ((await inbox.accept(incoming)) === "persisted") await processor.processAvailableNow();
      },
      ignored: (event) => inbox.countIgnoredEvent(event),
      fault: (fault) => {
        throw new Error(`${fault.code}: ${fault.message}`);
      },
    });
    runner.start();
    await vi.waitFor(() => expect(runner?.telemetry.status).toBe("connected"));

    const resultReader = await connect("pipeline-result-reader");
    await new Promise<void>((resolve, reject) =>
      resultReader.subscribe("pipeline/result", { qos: 1 }, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    const results: Array<Record<string, unknown>> = [];
    resultReader.on("message", (_topic, payload) => {
      results.push(JSON.parse(payload.toString()) as Record<string, unknown>);
    });
    const publisher = await connect("pipeline-publisher");
    const payload = JSON.stringify({
      schema: "obsidian.mqtt-sync.message.v1",
      id: "pipeline-stable-id",
      text: "pipeline payload",
    });
    const publish = () =>
      new Promise<void>((resolve, reject) =>
        publisher.publish("pipeline/input", payload, { qos: 1 }, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    await publish();
    await vi.waitFor(() => expect(results).toHaveLength(1));
    await publish();
    await vi.waitFor(() => expect(store.snapshot().telemetry.duplicates).toBe(1));

    const records = Object.values(store.snapshot().records);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: "complete", resultStatus: "sent" });
    expect(vault.text.get("MQTT Sync/Pipeline.md")).toContain("pipeline payload");
    expect(vault.text.get("MQTT Sync/Pipeline.md")?.match(/mqtt-sync:v1/gu)).toHaveLength(1);
    expect(results).toEqual([
      expect.objectContaining({
        schema: "obsidian.mqtt-sync.result.v1",
        outcome: "succeeded",
        targetCount: 1,
      }),
    ]);
    expect(Object.values(store.snapshot().outbox)).toEqual([
      expect.objectContaining({ status: "sent", attempts: 0 }),
    ]);
  });
});
