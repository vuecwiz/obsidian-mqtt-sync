import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, connect as connectSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mqtt from "mqtt";

const MOSQUITTO = process.env.MOSQUITTO_BIN ?? "mosquitto";
const runToken = `mqtt-sync-e2e-${process.pid}`;
const results = [];
const processes = [];
const temporaryDirectory = await mkdtemp(join(tmpdir(), "mqtt-sync-mosquitto-"));
const cleanup = { brokersStopped: false, temporaryDirectoryRemoved: false, errors: [] };
const brokerVersion = readMosquittoVersion();

try {
  const tcpPort = await reservePort();
  const wsPort = await reservePort();
  const broker = await startBroker(
    [
      "persistence true",
      `persistence_location ${temporaryDirectory}/`,
      "autosave_interval 1",
      "allow_anonymous true",
      `listener ${tcpPort} 127.0.0.1`,
      "protocol mqtt",
      `listener ${wsPort} 127.0.0.1`,
      "protocol websockets",
    ],
    tcpPort,
  );
  processes.push(broker);

  await scenario("mqtt-3.1.1-connect", async () => {
    const client = await mqtt.connectAsync(`mqtt://127.0.0.1:${tcpPort}`, {
      protocolVersion: 4,
      clientId: `${runToken}-v4-connect`,
      clean: true,
      reconnectPeriod: 0,
    });
    await client.endAsync();
  });

  for (const qos of [0, 1, 2]) {
    await scenario(`mqtt-3.1.1-qos-${qos}`, () =>
      verifyQosDelivery(`mqtt://127.0.0.1:${tcpPort}`, 4, qos),
    );
  }

  await scenario("mqtt-3.1.1-wildcard", async () => {
    const subscriber = await connectClient(`mqtt://127.0.0.1:${tcpPort}`, 4, "v4-wild-sub");
    const publisher = await connectClient(`mqtt://127.0.0.1:${tcpPort}`, 4, "v4-wild-pub");
    try {
      const message = collectMessages(subscriber, 1);
      await subscriber.subscribeAsync(`${runToken}/wildcard/+/input`, { qos: 1 });
      await publisher.publishAsync(`${runToken}/wildcard/match/input`, "wildcard", { qos: 1 });
      assert((await message)[0].payload === "wildcard", "wildcard delivery");
    } finally {
      await Promise.allSettled([subscriber.endAsync(), publisher.endAsync()]);
    }
  });

  await scenario("mqtt-retain-live-and-replay", async () => {
    const topic = `${runToken}/retain/input`;
    const subscriber = await connectClient(`mqtt://127.0.0.1:${tcpPort}`, 4, "retain-live");
    const publisher = await connectClient(`mqtt://127.0.0.1:${tcpPort}`, 4, "retain-pub");
    try {
      const live = collectMessages(subscriber, 1);
      await subscriber.subscribeAsync(topic, { qos: 1 });
      await publisher.publishAsync(topic, "retained", { qos: 1, retain: true });
      assert((await live)[0].retain === false, "live retained publication flag");
      const replay = await connectClient(`mqtt://127.0.0.1:${tcpPort}`, 4, "retain-replay");
      try {
        const retained = collectMessages(replay, 1);
        await replay.subscribeAsync(topic, { qos: 1 });
        assert((await retained)[0].retain === true, "retained replay flag");
      } finally {
        await replay.endAsync();
      }
    } finally {
      await Promise.allSettled([subscriber.endAsync(), publisher.endAsync()]);
    }
  });

  await scenario("mqtt-5-connect", async () => {
    const client = await connectClient(`mqtt://127.0.0.1:${tcpPort}`, 5, "v5-connect");
    await client.endAsync();
  });

  await scenario("mqtt-graceful-disconnect", async () => {
    const client = await connectClient(`mqtt://127.0.0.1:${tcpPort}`, 5, "graceful-stop");
    await client.endAsync();
    assert(!client.connected, "graceful disconnect completed");
  });

  await scenario("mqtt-5-properties", async () => {
    const subscriber = await connectClient(`mqtt://127.0.0.1:${tcpPort}`, 5, "v5-props-sub");
    const publisher = await connectClient(`mqtt://127.0.0.1:${tcpPort}`, 5, "v5-props-pub");
    try {
      const message = collectMessages(subscriber, 1);
      await subscriber.subscribeAsync(`${runToken}/v5/properties`, { qos: 2 });
      await publisher.publishAsync(`${runToken}/v5/properties`, "envelope", {
        qos: 2,
        properties: {
          contentType: "application/json",
          payloadFormatIndicator: true,
          responseTopic: `${runToken}/v5/result`,
          correlationData: Buffer.from("synthetic-correlation"),
          userProperties: { source: ["fixture", "fixture-2"] },
        },
      });
      const received = (await message)[0];
      assert(received.qos === 2, "MQTT 5 QoS 2");
      assert(received.properties?.contentType === "application/json", "content type");
      assert(received.properties?.responseTopic?.endsWith("/result"), "response topic");
    } finally {
      await Promise.allSettled([subscriber.endAsync(), publisher.endAsync()]);
    }
  });

  await scenario("result-publish-qos-2", () =>
    verifyQosDelivery(`mqtt://127.0.0.1:${tcpPort}`, 5, 2, "result"),
  );

  await scenario("mqtt-5-clean-start-session-present-false", async () => {
    const connection = await connectWithPacket(`mqtt://127.0.0.1:${tcpPort}`, {
      protocolVersion: 5,
      clientId: `${runToken}-clean-start`,
      clean: true,
      reconnectPeriod: 0,
      properties: { sessionExpiryInterval: 0 },
    });
    try {
      assert(connection.packet.sessionPresent === false, "Clean Start sessionPresent false");
    } finally {
      await connection.client.endAsync();
    }
  });

  await scenario("mqtt-5-session-expiry-session-present-true", async () => {
    const clientId = `${runToken}-session-expiry`;
    const first = await connectWithPacket(`mqtt://127.0.0.1:${tcpPort}`, {
      protocolVersion: 5,
      clientId,
      clean: false,
      reconnectPeriod: 0,
      properties: { sessionExpiryInterval: 60 },
    });
    assert(first.packet.sessionPresent === false, "new durable session absent");
    await first.client.endAsync(false, { properties: { sessionExpiryInterval: 60 } });
    const second = await connectWithPacket(`mqtt://127.0.0.1:${tcpPort}`, {
      protocolVersion: 5,
      clientId,
      clean: false,
      reconnectPeriod: 0,
      properties: { sessionExpiryInterval: 60 },
    });
    try {
      assert(second.packet.sessionPresent === true, "durable session present");
    } finally {
      await second.client.endAsync(false, { properties: { sessionExpiryInterval: 0 } });
    }
  });

  await scenario("persistent-session-offline-qos-1-replay", async () => {
    const clientId = `${runToken}-persistent`;
    const first = await connectWithPacket(`mqtt://127.0.0.1:${tcpPort}`, {
      protocolVersion: 5,
      clientId,
      clean: false,
      reconnectPeriod: 0,
      properties: { sessionExpiryInterval: 60 },
    });
    assert(first.packet.sessionPresent === false, "fresh sessionPresent false");
    await first.client.subscribeAsync(`${runToken}/persistent`, { qos: 1 });
    await first.client.endAsync(false, { properties: { sessionExpiryInterval: 60 } });

    const publisher = await mqtt.connectAsync(`mqtt://127.0.0.1:${tcpPort}`, {
      protocolVersion: 5,
      clientId: `${runToken}-persistent-pub`,
      clean: true,
      reconnectPeriod: 0,
    });
    await publisher.publishAsync(`${runToken}/persistent`, "queued", { qos: 1 });
    await publisher.endAsync();

    const replayPromise = new Promise((resolvePromise, rejectPromise) => {
      const client = mqtt.connect(`mqtt://127.0.0.1:${tcpPort}`, {
        protocolVersion: 5,
        clientId,
        clean: false,
        reconnectPeriod: 0,
        properties: { sessionExpiryInterval: 60 },
      });
      const timer = setTimeout(() => rejectPromise(new Error("persistent replay timeout")), 5000);
      let sessionPresent = false;
      client.once("connect", (packet) => {
        sessionPresent = packet.sessionPresent;
      });
      client.once("message", async (_topic, payload) => {
        clearTimeout(timer);
        await client.endAsync(false, { properties: { sessionExpiryInterval: 0 } });
        resolvePromise({ sessionPresent, payload: payload.toString("utf8") });
      });
      client.once("error", rejectPromise);
    });
    const replay = await replayPromise;
    assert(replay.sessionPresent === true, "existing sessionPresent true");
    assert(replay.payload === "queued", "offline QoS 1 replay");
  });

  await scenario("duplicate-client-id-eviction", async () => {
    const clientId = `${runToken}-collision`;
    const first = await mqtt.connectAsync(`mqtt://127.0.0.1:${tcpPort}`, {
      protocolVersion: 5,
      clientId,
      clean: true,
      reconnectPeriod: 0,
    });
    const closed = once(first, "close");
    const second = await mqtt.connectAsync(`mqtt://127.0.0.1:${tcpPort}`, {
      protocolVersion: 5,
      clientId,
      clean: true,
      reconnectPeriod: 0,
    });
    try {
      await withTimeout(closed, 5000, "duplicate Client ID eviction");
      assert(!first.connected, "first client disconnected");
    } finally {
      await Promise.allSettled([first.endAsync(), second.endAsync()]);
    }
  });

  await scenario("websocket-mqtt-5", async () => {
    const subscriber = await mqtt.connectAsync(`ws://127.0.0.1:${wsPort}`, {
      protocolVersion: 5,
      clientId: `${runToken}-ws-sub`,
      clean: true,
      reconnectPeriod: 0,
    });
    const publisher = await mqtt.connectAsync(`ws://127.0.0.1:${wsPort}`, {
      protocolVersion: 5,
      clientId: `${runToken}-ws-pub`,
      clean: true,
      reconnectPeriod: 0,
    });
    try {
      const message = collectMessages(subscriber, 1);
      await subscriber.subscribeAsync(`${runToken}/ws`, { qos: 1 });
      await publisher.publishAsync(`${runToken}/ws`, "websocket", { qos: 1 });
      assert((await message)[0].payload === "websocket", "WebSocket delivery");
    } finally {
      await Promise.allSettled([subscriber.endAsync(), publisher.endAsync()]);
    }
  });

  await scenario("mqtt-5-retain-handling-rh-2", async () => {
    const topic = `${runToken}/options/rh-2`;
    const publisher = await connectClient(`mqtt://127.0.0.1:${tcpPort}`, 5, "rh2-pub");
    const subscriber = await connectClient(`mqtt://127.0.0.1:${tcpPort}`, 5, "rh2-sub");
    try {
      await publisher.publishAsync(topic, "retained", { qos: 1, retain: true });
      await subscriber.subscribeAsync(topic, { qos: 1, rh: 2 });
      await expectNoMessage(subscriber, 250);
    } finally {
      await Promise.allSettled([subscriber.endAsync(), publisher.endAsync()]);
    }
  });

  await scenario("mqtt-5-retain-as-published-rap", async () => {
    const topic = `${runToken}/options/rap`;
    const publisher = await connectClient(`mqtt://127.0.0.1:${tcpPort}`, 5, "rap-pub");
    const subscriber = await connectClient(`mqtt://127.0.0.1:${tcpPort}`, 5, "rap-sub");
    try {
      await publisher.publishAsync(topic, "retained", { qos: 1, retain: true });
      const replay = collectMessages(subscriber, 1);
      await subscriber.subscribeAsync(topic, { qos: 1, rh: 0, rap: true });
      assert((await replay)[0].retain === true, "retain-as-published");
    } finally {
      await Promise.allSettled([subscriber.endAsync(), publisher.endAsync()]);
    }
  });

  await scenario("mqtt-5-no-local-nl", async () => {
    const client = await connectClient(`mqtt://127.0.0.1:${tcpPort}`, 5, "nl-client");
    try {
      await client.subscribeAsync(`${runToken}/options/no-local`, { qos: 1, nl: true });
      await client.publishAsync(`${runToken}/options/no-local`, "self", { qos: 1 });
      await expectNoMessage(client, 250);
    } finally {
      await client.endAsync();
    }
  });

  await scenario("reconnect-and-explicit-resubscribe", async () => {
    const client = mqtt.connect(`mqtt://127.0.0.1:${tcpPort}`, {
      protocolVersion: 5,
      clientId: `${runToken}-reconnect`,
      clean: true,
      reconnectPeriod: 100,
      resubscribe: false,
    });
    let connections = 0;
    client.on("connect", () => {
      connections += 1;
      if (connections > 1) void client.subscribeAsync(`${runToken}/reconnect`, { qos: 1 });
    });
    await withTimeout(once(client, "connect"), 5000, "initial connection");
    await client.subscribeAsync(`${runToken}/reconnect`, { qos: 1 });
    const reconnected = once(client, "connect");
    client.stream.destroy();
    await withTimeout(reconnected, 5000, "reconnect");
    const message = collectMessages(client, 1);
    const publisher = await mqtt.connectAsync(`mqtt://127.0.0.1:${tcpPort}`, {
      protocolVersion: 5,
      clientId: `${runToken}-reconnect-pub`,
      clean: true,
      reconnectPeriod: 0,
    });
    try {
      await publisher.publishAsync(`${runToken}/reconnect`, "after-reconnect", { qos: 1 });
      assert((await message)[0].payload === "after-reconnect", "explicit resubscription delivery");
    } finally {
      await Promise.allSettled([client.endAsync(), publisher.endAsync()]);
    }
  });

  await stopBroker(broker);
  processes.pop();

  const authPort = await reservePort();
  const passwordFile = join(temporaryDirectory, "passwords");
  const aclFile = join(temporaryDirectory, "acl");
  const password = "synthetic-local-password";
  const passwd = spawnSync("mosquitto_passwd", ["-b", "-c", passwordFile, "fixture", password], {
    encoding: "utf8",
  });
  if (passwd.status !== 0) throw new Error("mosquitto_passwd failed");
  await writeFile(aclFile, `user fixture\ntopic readwrite ${runToken}/allowed/#\n`);
  const authBroker = await startBroker(
    [
      "allow_anonymous false",
      `password_file ${passwordFile}`,
      `acl_file ${aclFile}`,
      `listener ${authPort} 127.0.0.1`,
      "protocol mqtt",
    ],
    authPort,
  );
  processes.push(authBroker);
  try {
    await scenario("authentication-rejection", async () => {
      await expectConnectFailure(`mqtt://127.0.0.1:${authPort}`, {
        protocolVersion: 5,
        clientId: `${runToken}-bad-auth`,
        username: "fixture",
        password: "wrong",
        clean: true,
        reconnectPeriod: 0,
      });
    });

    await scenario("acl-authorized-subscription", async () => {
      const client = await connectAuthenticatedClient(authPort, password, "acl-grant");
      try {
        const granted = await client.subscribeAsync(`${runToken}/allowed/#`, { qos: 1 });
        assert(granted[0]?.qos === 1, "ACL grant");
      } finally {
        await client.endAsync();
      }
    });

    await scenario("acl-publish-rejection", async () => {
      const client = await connectAuthenticatedClient(authPort, password, "acl-deny");
      try {
        let publishDenied = false;
        try {
          await client.publishAsync(`${runToken}/denied/output`, "blocked", { qos: 1 });
        } catch {
          publishDenied = true;
        }
        assert(publishDenied, "ACL publish rejection");
      } finally {
        await client.endAsync();
      }
    });
  } finally {
    await stopBroker(authBroker);
    processes.pop();
  }

  const certificates = await createTestCertificates();
  const tlsPort = await reservePort();
  const wssPort = await reservePort();
  const serverOnlyTlsPort = await reservePort();
  const serverOnlyWssPort = await reservePort();
  const tlsBroker = await startBroker(
    [
      "per_listener_settings true",
      `listener ${tlsPort} 127.0.0.1`,
      "protocol mqtt",
      "allow_anonymous true",
      `cafile ${certificates.caPath}`,
      `certfile ${certificates.serverCertificatePath}`,
      `keyfile ${certificates.serverKeyPath}`,
      "require_certificate true",
      `listener ${serverOnlyTlsPort} 127.0.0.1`,
      "protocol mqtt",
      "allow_anonymous true",
      `cafile ${certificates.caPath}`,
      `certfile ${certificates.serverCertificatePath}`,
      `keyfile ${certificates.serverKeyPath}`,
      "require_certificate false",
      `listener ${serverOnlyWssPort} 127.0.0.1`,
      "protocol websockets",
      "allow_anonymous true",
      `cafile ${certificates.caPath}`,
      `certfile ${certificates.serverCertificatePath}`,
      `keyfile ${certificates.serverKeyPath}`,
      "require_certificate false",
      `listener ${wssPort} 127.0.0.1`,
      "protocol websockets",
      "allow_anonymous true",
      `cafile ${certificates.caPath}`,
      `certfile ${certificates.serverCertificatePath}`,
      `keyfile ${certificates.serverKeyPath}`,
      "require_certificate true",
    ],
    tlsPort,
  );
  processes.push(tlsBroker);
  const tlsOptions = {
    protocolVersion: 5,
    clean: true,
    reconnectPeriod: 0,
    rejectUnauthorized: true,
    ca: certificates.ca,
    cert: certificates.clientCertificate,
    key: certificates.clientKey,
  };
  const serverTlsOptions = {
    protocolVersion: 5,
    clean: true,
    reconnectPeriod: 0,
    rejectUnauthorized: true,
    ca: certificates.ca,
  };
  await scenario("mqtts-server-authenticated", async () => {
    const client = await mqtt.connectAsync(`mqtts://localhost:${serverOnlyTlsPort}`, {
      ...serverTlsOptions,
      clientId: `${runToken}-mqtts-server-authenticated`,
    });
    await client.endAsync();
  });
  await scenario("wss-server-authenticated", async () => {
    const client = await mqtt.connectAsync(`wss://localhost:${serverOnlyWssPort}`, {
      ...serverTlsOptions,
      clientId: `${runToken}-wss-server-authenticated`,
    });
    await client.endAsync();
  });
  await scenario("mtls-client-certificate-and-qos-2", async () => {
    const subscriber = await mqtt.connectAsync(`mqtts://localhost:${tlsPort}`, {
      ...tlsOptions,
      clientId: `${runToken}-mqtts-sub`,
    });
    const publisher = await mqtt.connectAsync(`mqtts://localhost:${tlsPort}`, {
      ...tlsOptions,
      clientId: `${runToken}-mqtts-pub`,
    });
    try {
      const message = collectMessages(subscriber, 1);
      await subscriber.subscribeAsync(`${runToken}/tls`, { qos: 2 });
      await publisher.publishAsync(`${runToken}/tls`, "mutual-tls", { qos: 2 });
      assert((await message)[0].payload === "mutual-tls", "mqtts mTLS delivery");
    } finally {
      await Promise.allSettled([subscriber.endAsync(), publisher.endAsync()]);
    }
  });
  await scenario("mtls-wss-client-certificate", async () => {
    const client = await mqtt.connectAsync(`wss://localhost:${wssPort}`, {
      ...tlsOptions,
      clientId: `${runToken}-wss`,
    });
    await client.endAsync();
  });
  await scenario("tls-hostname-mismatch-rejected", async () => {
    await expectConnectFailure(`mqtts://127.0.0.1:${tlsPort}`, {
      ...tlsOptions,
      clientId: `${runToken}-hostname-mismatch`,
    });
  });
  await scenario("tls-untrusted-ca-rejected", async () => {
    await expectConnectFailure(`mqtts://localhost:${tlsPort}`, {
      ...tlsOptions,
      ca: undefined,
      clientId: `${runToken}-untrusted`,
    });
  });
  await scenario("tls-client-certificate-required", async () => {
    await expectConnectFailure(`mqtts://localhost:${tlsPort}`, {
      ...tlsOptions,
      cert: undefined,
      key: undefined,
      clientId: `${runToken}-no-client-certificate`,
    });
  });
  await scenario("tls-verification-bypass-prohibited", async () => {
    const policy = spawnSync(
      "npx",
      [
        "vitest",
        "run",
        "--config=vitest.mosquitto.config.mjs",
        "tests/mosquitto/tls-bypass-policy.test.ts",
        "--reporter=json",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          MQTT_E2E_TLS_POLICY_URL: `mqtts://localhost:${serverOnlyTlsPort}`,
        },
        timeout: 15_000,
      },
    );
    assert(policy.status === 0, "product TLS policy rejected verification bypass");
  });
  await stopBroker(tlsBroker);
  processes.pop();

  await scenario("tls-expired-server-certificate-rejected", async () => {
    const expiredPort = await reservePort();
    const expiredBroker = await startBroker(
      [
        "allow_anonymous true",
        `listener ${expiredPort} 127.0.0.1`,
        "protocol mqtt",
        `cafile ${certificates.caPath}`,
        `certfile ${certificates.expiredServerCertificatePath}`,
        `keyfile ${certificates.serverKeyPath}`,
        "require_certificate true",
      ],
      expiredPort,
    );
    processes.push(expiredBroker);
    try {
      await expectConnectFailure(`mqtts://localhost:${expiredPort}`, {
        ...tlsOptions,
        clientId: `${runToken}-expired-server-certificate`,
      });
    } finally {
      await stopBroker(expiredBroker);
      processes.pop();
    }
  });
} catch (error) {
  results.push({ id: "harness-execution", status: "failed", reason: safeError(error) });
} finally {
  const stops = await Promise.allSettled(processes.map((process) => stopBroker(process)));
  cleanup.brokersStopped = stops.every((result) => result.status === "fulfilled");
  if (!cleanup.brokersStopped) cleanup.errors.push("broker cleanup failed");
  try {
    await rm(temporaryDirectory, { recursive: true, force: true });
    cleanup.temporaryDirectoryRemoved = !(await exists(temporaryDirectory));
  } catch {
    cleanup.errors.push("temporary directory cleanup failed");
  }
  if (!cleanup.temporaryDirectoryRemoved && !cleanup.errors.length)
    cleanup.errors.push("temporary directory remained after cleanup");
}

process.stdout.write(
  `${JSON.stringify({ schema: "obsidian.mqtt-sync.mosquitto-e2e.v2", broker: "mosquitto", brokerVersion, cleanup, results })}\n`,
);
if (results.some((result) => result.status !== "passed") || cleanup.errors.length)
  process.exitCode = 1;

async function scenario(id, run) {
  const startedAt = Date.now();
  try {
    await withTimeout(run(), 20_000, id);
    results.push({ id, status: "passed", durationMs: Date.now() - startedAt });
  } catch (error) {
    results.push({
      id,
      status: "failed",
      durationMs: Date.now() - startedAt,
      reason: safeError(error),
    });
  }
}

async function startBroker(lines, port) {
  const directory = await mkdtemp(join(temporaryDirectory, "broker-"));
  await chmod(directory, 0o755);
  const config = join(directory, "mosquitto.conf");
  await writeFile(config, `${lines.join("\n")}\nlog_dest stderr\nlog_type error\n`);
  const check = spawnSync(MOSQUITTO, ["--test-config", "-c", config], { encoding: "utf8" });
  if (check.status !== 0) throw new Error("Mosquitto rejected the temporary configuration");
  const child = spawn(MOSQUITTO, ["-c", config], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4096);
  });
  try {
    await waitForPort(port, child);
    child.sanitizedStderr = () => (stderr ? "broker emitted errors" : "");
    return child;
  } catch (error) {
    await stopBroker(child);
    throw error;
  }
}

async function createTestCertificates() {
  const directory = await mkdtemp(join(temporaryDirectory, "certificates-"));
  await chmod(directory, 0o755);
  const caPath = join(directory, "ca.crt");
  const caKeyPath = join(directory, "ca.key");
  const serverKeyPath = join(directory, "server.key");
  const serverRequestPath = join(directory, "server.csr");
  const serverCertificatePath = join(directory, "server.crt");
  const clientKeyPath = join(directory, "client.key");
  const clientRequestPath = join(directory, "client.csr");
  const clientCertificatePath = join(directory, "client.crt");
  const expiredServerCertificatePath = join(directory, "server-expired.crt");
  runOpenSsl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKeyPath,
    "-out",
    caPath,
    "-days",
    "1",
    "-subj",
    "/CN=MQTT Sync Test CA",
  ]);
  runOpenSsl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    serverKeyPath,
    "-out",
    serverRequestPath,
    "-subj",
    "/CN=localhost",
  ]);
  const serverExtensions = join(directory, "server.ext");
  await writeFile(serverExtensions, "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n");
  runOpenSsl([
    "x509",
    "-req",
    "-in",
    serverRequestPath,
    "-CA",
    caPath,
    "-CAkey",
    caKeyPath,
    "-CAcreateserial",
    "-out",
    serverCertificatePath,
    "-days",
    "1",
    "-sha256",
    "-extfile",
    serverExtensions,
  ]);
  runOpenSsl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    clientKeyPath,
    "-out",
    clientRequestPath,
    "-subj",
    "/CN=mqtt-sync-test-client",
  ]);
  const clientExtensions = join(directory, "client.ext");
  await writeFile(clientExtensions, "extendedKeyUsage=clientAuth\n");
  runOpenSsl([
    "x509",
    "-req",
    "-in",
    clientRequestPath,
    "-CA",
    caPath,
    "-CAkey",
    caKeyPath,
    "-CAcreateserial",
    "-out",
    clientCertificatePath,
    "-days",
    "1",
    "-sha256",
    "-extfile",
    clientExtensions,
  ]);
  const database = join(directory, "index.txt");
  const serial = join(directory, "serial");
  const newCertificates = join(directory, "newcerts");
  await mkdir(newCertificates);
  await writeFile(database, "");
  await writeFile(serial, "1000\n");
  const caConfig = join(directory, "ca.conf");
  await writeFile(
    caConfig,
    `[ca]\ndefault_ca=local_ca\n[local_ca]\ndatabase=${database}\nnew_certs_dir=${newCertificates}\ncertificate=${caPath}\nprivate_key=${caKeyPath}\nserial=${serial}\ndefault_md=sha256\npolicy=policy_any\nunique_subject=no\n[policy_any]\ncommonName=supplied\n[server_ext]\nsubjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n`,
  );
  runOpenSsl([
    "ca",
    "-batch",
    "-config",
    caConfig,
    "-in",
    serverRequestPath,
    "-out",
    expiredServerCertificatePath,
    "-startdate",
    "20200101000000Z",
    "-enddate",
    "20200102000000Z",
    "-extensions",
    "server_ext",
  ]);
  await Promise.all([
    chmod(serverKeyPath, 0o644),
    chmod(serverCertificatePath, 0o644),
    chmod(expiredServerCertificatePath, 0o644),
    chmod(caPath, 0o644),
  ]);
  return {
    caPath,
    serverCertificatePath,
    serverKeyPath,
    expiredServerCertificatePath,
    ca: await readFile(caPath),
    clientCertificate: await readFile(clientCertificatePath),
    clientKey: await readFile(clientKeyPath),
  };
}

function runOpenSsl(args) {
  const result = spawnSync("openssl", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error("OpenSSL test certificate generation failed");
}

async function stopBroker(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  try {
    await withTimeout(once(child, "exit"), 5000, "broker shutdown");
  } catch {
    if (child.exitCode === null) child.kill("SIGKILL");
    if (child.exitCode === null)
      await withTimeout(once(child, "exit"), 5000, "forced broker shutdown");
  }
}

async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForPort(port, child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Mosquitto exited before accepting connections");
    const connected = await new Promise((resolvePromise) => {
      const socket = connectSocket({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolvePromise(true);
      });
      socket.once("error", () => resolvePromise(false));
    });
    if (connected) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Mosquitto startup timed out");
}

function connectClient(url, protocolVersion, suffix) {
  return mqtt.connectAsync(url, {
    protocolVersion,
    clientId: `${runToken}-${suffix}`,
    clean: true,
    reconnectPeriod: 0,
  });
}

function connectAuthenticatedClient(port, password, suffix) {
  return mqtt.connectAsync(`mqtt://127.0.0.1:${port}`, {
    protocolVersion: 5,
    clientId: `${runToken}-${suffix}`,
    username: "fixture",
    password,
    clean: true,
    reconnectPeriod: 0,
  });
}

async function verifyQosDelivery(url, protocolVersion, qos, suffix = "delivery") {
  const topic = `${runToken}/${suffix}/qos-${qos}`;
  const subscriber = await connectClient(url, protocolVersion, `${suffix}-qos-${qos}-sub`);
  const publisher = await connectClient(url, protocolVersion, `${suffix}-qos-${qos}-pub`);
  try {
    const message = collectMessages(subscriber, 1);
    await subscriber.subscribeAsync(topic, { qos: 2 });
    await publisher.publishAsync(topic, `${suffix}-qos-${qos}`, { qos });
    const received = (await message)[0];
    assert(received.payload === `${suffix}-qos-${qos}`, `QoS ${qos} payload`);
    assert(received.qos === qos, `QoS ${qos} delivery`);
  } finally {
    await Promise.allSettled([subscriber.endAsync(), publisher.endAsync()]);
  }
}

function collectMessages(client, count) {
  return withTimeout(
    new Promise((resolvePromise) => {
      const messages = [];
      client.on("message", (topic, payload, packet) => {
        messages.push({
          topic,
          payload: payload.toString("utf8"),
          qos: packet.qos,
          retain: packet.retain,
          properties: packet.properties,
        });
        if (messages.length === count) resolvePromise(messages);
      });
    }),
    5000,
    "message collection",
  );
}

async function expectNoMessage(client, durationMs) {
  let received = false;
  const listener = () => {
    received = true;
  };
  client.on("message", listener);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));
  client.off("message", listener);
  assert(!received, "no publication delivered");
}

async function connectWithPacket(url, options) {
  const client = mqtt.connect(url, options);
  const [packet] = await withTimeout(once(client, "connect"), 5000, "connect packet");
  return { client, packet };
}

async function expectConnectFailure(url, options) {
  const client = mqtt.connect(url, options);
  try {
    const outcome = await withTimeout(
      new Promise((resolvePromise) => {
        client.once("connect", () => resolvePromise("connected"));
        client.once("error", () => resolvePromise("error"));
      }),
      5000,
      "authentication rejection",
    );
    assert(outcome === "error", "authentication rejection");
  } finally {
    client.end(true);
  }
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assert(condition, label) {
  if (!condition) throw new Error(`Assertion failed: ${label}`);
}

function readMosquittoVersion() {
  const result = spawnSync(MOSQUITTO, ["-h"], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return output.match(/mosquitto version ([^\s]+)/iu)?.[1] ?? "unknown";
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function safeError(error) {
  const message = error instanceof Error ? error.message : "unknown failure";
  return message.replace(/\b\d{4,5}\b/gu, "<port>").slice(0, 180);
}
