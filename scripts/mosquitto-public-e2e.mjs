import { spawnSync } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { connect as connectSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mqtt from "mqtt";

const PROVIDER = "test.mosquitto.org";
const ENABLE_ENV = "MQTT_PUBLIC_TEST_ENABLED";
const PROVIDER_ENV = "MQTT_PUBLIC_TEST_PROVIDER";
const CONNECT_TIMEOUT_MS = 8_000;
const OPERATION_TIMEOUT_MS = 6_000;
const SCENARIO_TIMEOUT_MS = 20_000;
const CONNECT_ATTEMPTS = 2;
const MAX_CA_BYTES = 32 * 1024;
const MAX_CLIENT_MATERIAL_BYTES = 128 * 1024;
const OFFICIAL_CA_URL = "https://test.mosquitto.org/ssl/mosquitto.org.crt";
const OFFICIAL_CA_DER_SHA256 = "fc9e45e28f6f4987fd1481e146bcfc31124ef2fabf20ab047e3f8592c22b6539";
const endpoints = {
  tcp: { transport: "mqtt", port: 1883 },
  auth: { transport: "mqtt", port: 1884 },
  privateTls: { transport: "mqtts", port: 8883 },
  mutualTls: { transport: "mqtts", port: 8884 },
  systemTls: { transport: "mqtts", port: 8886 },
  expiredTls: { transport: "mqtts", port: 8887 },
  websocket: { transport: "ws", port: 8080, path: "/mqtt" },
  secureWebsocket: { transport: "wss", port: 8081, path: "/mqtt" },
};

class BlockedError extends Error {
  constructor(reasonCode, resultCodeValue) {
    super(reasonCode);
    this.name = "BlockedError";
    this.reasonCode = reasonCode;
    this.resultCode = resultCodeValue;
  }
}

class AssertionFailure extends Error {
  constructor(reasonCode, resultCodeValue) {
    super(reasonCode);
    this.name = "AssertionFailure";
    this.reasonCode = reasonCode;
    this.resultCode = resultCodeValue;
  }
}

const requestedRunId = process.env.MQTT_PUBLIC_TEST_RUN_ID;
const reportRunId = requestedRunId
  ? safeRunId(requestedRunId)
  : `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomBytes(6).toString("hex")}`;
const artifactDirectory = join(".artifacts", "public-mosquitto", reportRunId);
const runSecret = randomBytes(24);
const namespace = `mqtt-sync/public-test/${new Date().toISOString().slice(0, 10)}/${randomBytes(18).toString("hex")}`;
const results = [];
const activeClients = new Set();
const cleanup = {
  retainedCleanupAttempted: false,
  retainedClearedAndConfirmed: false,
  clientsClosed: false,
  temporaryDirectoryRemoved: false,
  errors: [],
};
let temporaryDirectory;
let officialCa;
let officialCaPath;

await mkdir(artifactDirectory, { recursive: true });

const enabled = process.env[ENABLE_ENV] === "1";
const providerSelected = process.env[PROVIDER_ENV] === PROVIDER;
try {
  if (!enabled || !providerSelected) {
    results.push({
      id: "MOSQ-PUBLIC-SUITE",
      status: "skipped",
      reasonCode: enabled ? "provider-not-selected" : "explicit-enable-not-set",
      durationMs: 0,
    });
  } else {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "mqtt-sync-public-mosquitto-"));
    await chmod(temporaryDirectory, 0o700);

    await runScenario(
      "MOSQ-PUBLIC-CA",
      { transport: "https", port: 443, authMode: "anonymous" },
      async () => {
        officialCa = await downloadAndValidateOfficialCa();
        officialCaPath = join(temporaryDirectory, "mosquitto-public-ca.pem");
        await writeFile(officialCaPath, officialCa, { mode: 0o600 });
        await chmod(officialCaPath, 0o600);
        return {
          itemCount: 1,
          fingerprintPrefix: createHash("sha256")
            .update(new X509Certificate(officialCa).raw)
            .digest("hex")
            .slice(0, 12),
        };
      },
    );

    await runScenario(
      "MOSQ-PUBLIC-01",
      scenarioMetadata(endpoints.tcp, 4, "anonymous", [0, 1, 2]),
      () => verifyQosRoundTrips(endpoints.tcp, 4, [0, 1, 2], "tcp-v4"),
    );

    await runScenario("MOSQ-PUBLIC-02", scenarioMetadata(endpoints.tcp, 5, "anonymous", [1]), () =>
      verifyMqtt5Wildcard(),
    );

    await runScenario("MOSQ-PUBLIC-03", scenarioMetadata(endpoints.tcp, 5, "anonymous", [1]), () =>
      verifyRetainedLifecycle(),
    );

    await runScenario(
      "MOSQ-PUBLIC-04",
      scenarioMetadata(endpoints.auth, 5, "read-write", [1]),
      async () => {
        const credentials = requireCredentials("RW");
        return verifySingleRoundTrip(endpoints.auth, 5, 1, "auth-rw", credentials);
      },
    );

    await runScenario(
      "MOSQ-PUBLIC-05",
      scenarioMetadata(endpoints.auth, 5, "invalid-password", []),
      () => verifyInvalidPasswordRejected(),
    );

    await runScenario("MOSQ-PUBLIC-06", scenarioMetadata(endpoints.auth, 5, "read-only", [1]), () =>
      verifyReadOnlyPublishRejected(),
    );

    await runScenario(
      "MOSQ-PUBLIC-07",
      scenarioMetadata(endpoints.auth, 5, "write-only", [1]),
      () => verifyWriteOnlySubscribeRejected(),
    );

    await runScenario(
      "MOSQ-PUBLIC-08",
      scenarioMetadata(endpoints.privateTls, 5, "anonymous", [1]),
      () =>
        verifySingleRoundTrip(endpoints.privateTls, 5, 1, "private-ca", {
          ca: requireOfficialCa(),
        }),
    );

    await runScenario(
      "MOSQ-PUBLIC-10",
      scenarioMetadata(endpoints.mutualTls, 5, "client-certificate-negative", []),
      () => verifyClientCertificateRequired(),
    );

    await runScenario(
      "MOSQ-PUBLIC-11",
      scenarioMetadata(endpoints.mutualTls, 5, "client-certificate", [1]),
      () => verifyMutualTls(),
    );

    await runScenario(
      "MOSQ-PUBLIC-13",
      scenarioMetadata(endpoints.systemTls, 5, "anonymous", [1]),
      () => verifySingleRoundTrip(endpoints.systemTls, 5, 1, "system-ca"),
    );

    await runScenario(
      "MOSQ-PUBLIC-14",
      scenarioMetadata(endpoints.expiredTls, 5, "anonymous", []),
      () => verifyExpiredCertificateRejected(),
    );

    await runScenario(
      "MOSQ-PUBLIC-15",
      scenarioMetadata(endpoints.websocket, 5, "anonymous", [1]),
      () => verifySingleRoundTrip(endpoints.websocket, 5, 1, "websocket"),
    );

    await runScenario(
      "MOSQ-PUBLIC-16",
      scenarioMetadata(endpoints.secureWebsocket, 5, "anonymous", [1]),
      () => verifySingleRoundTrip(endpoints.secureWebsocket, 5, 1, "secure-websocket"),
    );
  }
} catch (error) {
  results.push({
    id: "MOSQ-PUBLIC-HARNESS",
    status: "failed",
    durationMs: 0,
    reasonCode: "harness-execution-failed",
    resultCode: resultCode(error),
  });
}

await finalize();

async function runScenario(id, metadata, run) {
  const startedAt = Date.now();
  const clientsBefore = new Set(activeClients);
  try {
    const evidence = await withTimeout(Promise.resolve().then(run), SCENARIO_TIMEOUT_MS, id);
    results.push({
      id,
      ...metadata,
      status: "passed",
      durationMs: Date.now() - startedAt,
      evidence,
    });
  } catch (error) {
    await Promise.allSettled(
      [...activeClients]
        .filter((client) => !clientsBefore.has(client))
        .map((client) => closeClient(client)),
    );
    const blocked = error instanceof BlockedError || isInfrastructureError(error);
    results.push({
      id,
      ...metadata,
      status: blocked ? "blocked" : "failed",
      durationMs: Date.now() - startedAt,
      reasonCode: errorReasonCode(error),
      resultCode: resultCode(error),
    });
  }
}

async function verifyQosRoundTrips(endpoint, protocolVersion, qosLevels, suffix) {
  let messageCount = 0;
  for (const qos of qosLevels) {
    const evidence = await verifySingleRoundTrip(
      endpoint,
      protocolVersion,
      qos,
      `${suffix}-q${qos}`,
    );
    messageCount += evidence.messageCount;
  }
  return { messageCount, qosLevels };
}

async function verifySingleRoundTrip(endpoint, protocolVersion, qos, suffix, extraOptions = {}) {
  const topic = topicFor(suffix);
  const subscriber = await connectWithRetry(
    endpoint,
    protocolVersion,
    `${suffix}-sub`,
    extraOptions,
  );
  const publisher = await connectWithRetry(
    endpoint,
    protocolVersion,
    `${suffix}-pub`,
    extraOptions,
  );
  const payload = payloadFor(suffix);
  try {
    await subscribe(subscriber, topic, qos);
    const received = waitForMessage(subscriber, OPERATION_TIMEOUT_MS);
    await publish(publisher, topic, payload, { qos });
    const message = await received;
    assert(message.topic === topic, "topic-mismatch");
    assert(buffersEqual(message.payload, payload), "payload-mismatch");
    assert(message.packet.qos === qos, "qos-mismatch");
    return { messageCount: 1, qos };
  } finally {
    await Promise.allSettled([closeClient(subscriber), closeClient(publisher)]);
  }
}

async function verifyMqtt5Wildcard() {
  const leaf = randomBytes(8).toString("hex");
  const topic = `${namespace}/wildcard/${leaf}/input`;
  const filter = `${namespace}/wildcard/+/input`;
  const subscriber = await connectWithRetry(endpoints.tcp, 5, "wildcard-sub");
  const publisher = await connectWithRetry(endpoints.tcp, 5, "wildcard-pub");
  const payload = payloadFor("wildcard");
  try {
    await subscribe(subscriber, filter, 1);
    const received = waitForMessage(subscriber, OPERATION_TIMEOUT_MS);
    await publish(publisher, topic, payload, { qos: 1 });
    const message = await received;
    assert(message.topic === topic, "wildcard-topic-mismatch");
    assert(buffersEqual(message.payload, payload), "wildcard-payload-mismatch");
    return { messageCount: 1, wildcardLevels: 1 };
  } finally {
    await Promise.allSettled([closeClient(subscriber), closeClient(publisher)]);
  }
}

async function verifyRetainedLifecycle() {
  const topic = topicFor("retained");
  const payload = payloadFor("retained");
  let retainedPublished = false;
  let primaryError;
  try {
    const publisher = await connectWithRetry(endpoints.tcp, 5, "retain-pub");
    try {
      await publish(publisher, topic, payload, { qos: 1, retain: true });
      retainedPublished = true;
    } finally {
      await closeClient(publisher);
    }

    const replaySubscriber = await connectWithRetry(endpoints.tcp, 5, "retain-replay");
    try {
      const replay = waitForMessage(replaySubscriber, OPERATION_TIMEOUT_MS);
      await subscribe(replaySubscriber, topic, 1);
      const message = await replay;
      assert(message.packet.retain === true, "retained-flag-missing");
      assert(buffersEqual(message.payload, payload), "retained-payload-mismatch");
    } finally {
      await closeClient(replaySubscriber);
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (retainedPublished) {
      cleanup.retainedCleanupAttempted = true;
      try {
        await clearAndConfirmRetained(topic);
        cleanup.retainedClearedAndConfirmed = true;
      } catch (error) {
        cleanup.errors.push({ resource: "retained-publication", resultCode: resultCode(error) });
        primaryError = new AssertionFailure("retained-cleanup-not-confirmed", resultCode(error));
      }
    }
  }
  if (primaryError) throw primaryError;
  return { messageCount: 1, retainedReplayCount: 1, retainedCleared: true };
}

async function clearAndConfirmRetained(topic) {
  const cleaner = await connectWithRetry(endpoints.tcp, 5, "retain-cleaner");
  try {
    await publish(cleaner, topic, Buffer.alloc(0), { qos: 1, retain: true });
  } finally {
    await closeClient(cleaner);
  }

  const verifier = await connectWithRetry(endpoints.tcp, 5, "retain-verifier");
  try {
    await subscribe(verifier, topic, 1);
    await expectNoMessage(verifier, 1_200);
  } finally {
    await closeClient(verifier);
  }
}

async function verifyInvalidPasswordRejected() {
  const credentials = requireCredentials("RW");
  await ensureEndpointReachable(endpoints.auth);
  const outcome = await connectOutcome(endpoints.auth, 5, "invalid-password", {
    username: credentials.username,
    password: randomBytes(24).toString("base64url"),
  });
  if (outcome.kind === "connected") {
    await closeClient(outcome.client);
    throw new AssertionFailure("invalid-password-accepted");
  }
  if (!isAuthenticationRejection(outcome.error)) {
    if (isInfrastructureError(outcome.error)) throw new BlockedError("auth-endpoint-unavailable");
    throw new AssertionFailure("unexpected-auth-rejection", resultCode(outcome.error));
  }
  return { rejectionCount: 1, resultCode: resultCode(outcome.error) };
}

async function verifyReadOnlyPublishRejected() {
  const readOnlyCredentials = requireCredentials("RO");
  const readWriteCredentials = requireCredentials("RW");
  const topic = topicFor("read-only-denied");
  const readOnlyClient = await connectWithRetry(
    endpoints.auth,
    5,
    "read-only",
    readOnlyCredentials,
  );
  const observer = await connectWithRetry(
    endpoints.auth,
    5,
    "read-only-observer",
    readWriteCredentials,
  );
  try {
    await subscribe(observer, topic, 1);
    await expectNoMessageDuring(
      observer,
      () => publish(readOnlyClient, topic, payloadFor("read-only"), { qos: 1 }),
      1_200,
    );
    return { rejectionCount: 1, enforcement: "publication-not-delivered" };
  } finally {
    await Promise.allSettled([closeClient(readOnlyClient), closeClient(observer)]);
  }
}

async function verifyWriteOnlySubscribeRejected() {
  const writeOnlyCredentials = requireCredentials("WO");
  const readWriteCredentials = requireCredentials("RW");
  const topic = topicFor("write-only-denied");
  const writeOnlyClient = await connectWithRetry(
    endpoints.auth,
    5,
    "write-only",
    writeOnlyCredentials,
  );
  const controlSubscriber = await connectWithRetry(
    endpoints.auth,
    5,
    "write-only-control-sub",
    readWriteCredentials,
  );
  const publisher = await connectWithRetry(
    endpoints.auth,
    5,
    "write-only-control-pub",
    readWriteCredentials,
  );
  try {
    await subscribe(writeOnlyClient, topic, 1);
    await subscribe(controlSubscriber, topic, 1);
    const controlMessage = waitForMessage(controlSubscriber, OPERATION_TIMEOUT_MS);
    const payload = payloadFor("write-only");
    await expectNoMessageDuring(
      writeOnlyClient,
      () => publish(publisher, topic, payload, { qos: 1 }),
      1_200,
    );
    const received = await controlMessage;
    assert(buffersEqual(received.payload, payload), "write-only-control-payload-mismatch");
    return { rejectionCount: 1, controlMessageCount: 1, enforcement: "message-not-delivered" };
  } finally {
    await Promise.allSettled([
      closeClient(writeOnlyClient),
      closeClient(controlSubscriber),
      closeClient(publisher),
    ]);
  }
}

async function verifyClientCertificateRequired() {
  const ca = requireOfficialCa();
  await ensureEndpointReachable(endpoints.mutualTls);
  const outcome = await connectOutcome(endpoints.mutualTls, 5, "mtls-negative", { ca });
  if (outcome.kind === "connected") {
    await closeClient(outcome.client);
    throw new AssertionFailure("client-certificate-not-required");
  }
  if (isSimpleNetworkFailure(outcome.error)) {
    throw new BlockedError("mtls-endpoint-unavailable", resultCode(outcome.error));
  }
  return { rejectionCount: 1, resultCode: resultCode(outcome.error) };
}

async function verifyMutualTls() {
  const ca = requireOfficialCa();
  const material = await loadProtectedClientMaterial();
  return verifySingleRoundTrip(endpoints.mutualTls, 5, 1, "mtls", {
    ca,
    cert: material.cert,
    key: material.key,
    passphrase: material.passphrase,
  });
}

async function verifyExpiredCertificateRejected() {
  const ca = requireOfficialCa();
  await ensureEndpointReachable(endpoints.expiredTls);
  const outcome = await connectOutcome(endpoints.expiredTls, 5, "expired-certificate", { ca });
  if (outcome.kind === "connected") {
    await closeClient(outcome.client);
    throw new AssertionFailure("expired-certificate-accepted");
  }
  if (!isExpiredCertificateError(outcome.error)) {
    if (isSimpleNetworkFailure(outcome.error)) {
      throw new BlockedError("expired-certificate-endpoint-unavailable", resultCode(outcome.error));
    }
    throw new AssertionFailure("unexpected-tls-rejection", resultCode(outcome.error));
  }
  return { rejectionCount: 1, resultCode: resultCode(outcome.error) };
}

async function connectWithRetry(endpoint, protocolVersion, suffix, extraOptions = {}) {
  let lastError;
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
    const outcome = await connectOutcome(
      endpoint,
      protocolVersion,
      `${suffix}-${attempt}`,
      extraOptions,
    );
    if (outcome.kind === "connected") return outcome.client;
    lastError = outcome.error;
    if (isAuthenticationRejection(lastError)) {
      throw new AssertionFailure("positive-authentication-rejected", resultCode(lastError));
    }
    if (attempt < CONNECT_ATTEMPTS) await delay(350 * attempt);
  }
  throw new BlockedError("connection-precondition-unavailable", resultCode(lastError));
}

async function connectOutcome(endpoint, protocolVersion, suffix, extraOptions = {}) {
  const client = mqtt.connect(endpointUrl(endpoint), {
    protocolVersion,
    clientId: clientIdFor(suffix),
    clean: true,
    reconnectPeriod: 0,
    resubscribe: false,
    connectTimeout: CONNECT_TIMEOUT_MS,
    rejectUnauthorized: endpoint.transport === "mqtts" || endpoint.transport === "wss",
    ...extraOptions,
  });
  activeClients.add(client);
  const outcome = await withTimeout(
    new Promise((resolvePromise) => {
      const connected = () => finish({ kind: "connected", client });
      const errored = (error) => finish({ kind: "error", error });
      const closed = () => finish({ kind: "error", error: new Error("connection-closed") });
      const finish = (value) => {
        client.off("connect", connected);
        client.off("error", errored);
        client.off("close", closed);
        resolvePromise(value);
      };
      client.once("connect", connected);
      client.once("error", errored);
      client.once("close", closed);
    }),
    CONNECT_TIMEOUT_MS + 1_000,
    "connect",
  ).catch((error) => ({ kind: "error", error }));
  if (outcome.kind === "error") await closeClient(client);
  return outcome;
}

async function subscribe(client, topicFilter, qos) {
  const granted = await withTimeout(
    client.subscribeAsync(topicFilter, { qos }),
    OPERATION_TIMEOUT_MS,
    "subscribe",
  );
  assert(granted[0]?.qos !== 128, "subscription-rejected");
  return granted;
}

async function publish(client, topic, payload, options) {
  await withTimeout(client.publishAsync(topic, payload, options), OPERATION_TIMEOUT_MS, "publish");
}

function waitForMessage(client, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => finish(undefined, new Error("message-timeout")), timeoutMs);
    const listener = (topic, payload, packet) => finish({ topic, payload, packet });
    const finish = (value, error) => {
      clearTimeout(timer);
      client.off("message", listener);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    client.on("message", listener);
  });
}

async function expectNoMessage(client, durationMs) {
  let received = false;
  const listener = () => {
    received = true;
  };
  client.on("message", listener);
  await delay(durationMs);
  client.off("message", listener);
  assert(!received, "unexpected-retained-replay");
}

async function expectNoMessageDuring(client, action, durationMs) {
  let received = false;
  const listener = () => {
    received = true;
  };
  client.on("message", listener);
  try {
    await action();
    await delay(durationMs);
  } finally {
    client.off("message", listener);
  }
  assert(!received, "acl-denied-message-delivered");
}

async function closeClient(client) {
  if (!client || !activeClients.has(client)) return;
  try {
    await withTimeout(
      new Promise((resolvePromise) => client.end(true, {}, resolvePromise)),
      2_000,
      "client-close",
    );
  } catch {
    client.end(true);
  } finally {
    activeClients.delete(client);
  }
}

async function ensureEndpointReachable(endpoint) {
  let lastError;
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
    try {
      await withTimeout(
        new Promise((resolvePromise, rejectPromise) => {
          const socket = connectSocket({ host: PROVIDER, port: endpoint.port });
          socket.once("connect", () => {
            socket.destroy();
            resolvePromise();
          });
          socket.once("error", rejectPromise);
        }),
        5_000,
        "tcp-preflight",
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt < CONNECT_ATTEMPTS) await delay(350 * attempt);
    }
  }
  throw new BlockedError("endpoint-unreachable", resultCode(lastError));
}

async function downloadAndValidateOfficialCa() {
  let lastError;
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
    try {
      const bytes = await downloadHttps(OFFICIAL_CA_URL, MAX_CA_BYTES);
      const certificate = new X509Certificate(bytes);
      const digest = createHash("sha256").update(certificate.raw).digest("hex");
      if (digest !== OFFICIAL_CA_DER_SHA256) {
        throw new AssertionFailure("official-ca-fingerprint-mismatch");
      }
      return bytes;
    } catch (error) {
      lastError = error;
      if (error instanceof AssertionFailure) throw error;
      if (attempt < CONNECT_ATTEMPTS) await delay(350 * attempt);
    }
  }
  throw new BlockedError("official-ca-unavailable", resultCode(lastError));
}

function downloadHttps(url, maximumBytes) {
  return withTimeout(
    new Promise((resolvePromise, rejectPromise) => {
      const request = httpsGet(
        url,
        { headers: { "user-agent": "obsidian-mqtt-sync-public-interoperability" } },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            rejectPromise(new Error(`http-status-${response.statusCode ?? "unknown"}`));
            return;
          }
          const chunks = [];
          let length = 0;
          response.on("data", (chunk) => {
            length += chunk.length;
            if (length > maximumBytes) {
              request.destroy(new Error("download-size-limit"));
              return;
            }
            chunks.push(chunk);
          });
          response.once("end", () => resolvePromise(Buffer.concat(chunks)));
          response.once("error", rejectPromise);
        },
      );
      request.setTimeout(6_000, () => request.destroy(new Error("download-timeout")));
      request.once("error", rejectPromise);
    }),
    7_000,
    "official-ca-download",
  );
}

function requireOfficialCa() {
  if (!officialCa || !officialCaPath) throw new BlockedError("official-ca-prerequisite-missing");
  return officialCa;
}

function requireCredentials(role) {
  const username = process.env[`MQTT_PUBLIC_${role}_USERNAME`];
  const password = process.env[`MQTT_PUBLIC_${role}_PASSWORD`];
  if (!username || !password) throw new BlockedError(`${role.toLowerCase()}-credentials-missing`);
  return { username, password };
}

async function loadProtectedClientMaterial() {
  const certificatePath = process.env.MQTT_PUBLIC_MTLS_CERT_FILE;
  const keyPath = process.env.MQTT_PUBLIC_MTLS_KEY_FILE;
  if (!certificatePath || !keyPath) throw new BlockedError("mtls-client-material-missing");
  const [certificateStat, keyStat] = await Promise.all([
    stat(certificatePath),
    stat(keyPath),
  ]).catch(() => {
    throw new BlockedError("mtls-client-material-unreadable");
  });
  if (
    !certificateStat.isFile() ||
    !keyStat.isFile() ||
    (certificateStat.mode & 0o077) !== 0 ||
    (keyStat.mode & 0o077) !== 0
  ) {
    throw new BlockedError("mtls-client-material-not-protected");
  }
  if (
    certificateStat.size > MAX_CLIENT_MATERIAL_BYTES ||
    keyStat.size > MAX_CLIENT_MATERIAL_BYTES
  ) {
    throw new BlockedError("mtls-client-material-too-large");
  }
  const [cert, key] = await Promise.all([readFile(certificatePath), readFile(keyPath)]);
  try {
    new X509Certificate(cert);
  } catch {
    throw new BlockedError("mtls-client-certificate-invalid");
  }
  const copiedCertificatePath = join(temporaryDirectory, "client.crt");
  const copiedKeyPath = join(temporaryDirectory, "client.key");
  await Promise.all([
    writeFile(copiedCertificatePath, cert, { mode: 0o600 }),
    writeFile(copiedKeyPath, key, { mode: 0o600 }),
  ]);
  await Promise.all([chmod(copiedCertificatePath, 0o600), chmod(copiedKeyPath, 0o600)]);
  return { cert, key, passphrase: process.env.MQTT_PUBLIC_MTLS_KEY_PASSPHRASE };
}

async function finalize() {
  const closes = await Promise.allSettled([...activeClients].map((client) => closeClient(client)));
  cleanup.clientsClosed =
    closes.every((result) => result.status === "fulfilled") && !activeClients.size;
  if (!cleanup.clientsClosed) cleanup.errors.push({ resource: "mqtt-clients" });
  if (temporaryDirectory) {
    try {
      await rm(temporaryDirectory, { recursive: true, force: true });
      cleanup.temporaryDirectoryRemoved = !(await exists(temporaryDirectory));
    } catch (error) {
      cleanup.errors.push({ resource: "temporary-directory", resultCode: resultCode(error) });
    }
  } else {
    cleanup.temporaryDirectoryRemoved = true;
  }

  const counts = Object.fromEntries(
    ["passed", "failed", "blocked", "skipped"].map((status) => [
      status,
      results.filter((item) => item.status === status).length,
    ]),
  );
  if (cleanup.errors.length) counts.failed += 1;
  const status = counts.failed
    ? "failed"
    : counts.blocked
      ? "incomplete"
      : counts.skipped
        ? "skipped"
        : "passed";
  const report = {
    schema: "obsidian.mqtt-sync.public-mosquitto.v1",
    runId: reportRunId,
    generatedAt: new Date().toISOString(),
    authorization: "explicit-runtime-opt-in",
    explicitEnable: enabled,
    providerSelected,
    publicNetworkUsed: enabled && providerSelected,
    broker: { implementation: "mosquitto-public-service", version: "not-exposed" },
    environment: environmentEvidence(),
    isolation: {
      topicNamespaceHashPrefix: hashPrefix(namespace),
      runSecretHashPrefix: hashPrefix(runSecret),
      payloadMaximumBytes: 32,
      wildcardDepth: 1,
    },
    credentialsPresent: {
      readWrite: credentialsPresent("RW"),
      readOnly: credentialsPresent("RO"),
      writeOnly: credentialsPresent("WO"),
      mutualTls:
        Boolean(process.env.MQTT_PUBLIC_MTLS_CERT_FILE) &&
        Boolean(process.env.MQTT_PUBLIC_MTLS_KEY_FILE),
    },
    results,
    counts,
    cleanup,
    status,
    limitations: [
      "single-bounded-interoperability-run",
      "not-performance-or-soak-evidence",
      "not-production-availability-evidence",
    ],
  };
  const reportPath = join(artifactDirectory, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ status, counts, cleanup, evidence: reportPath, runId: reportRunId })}\n`,
  );
  process.exitCode = status === "failed" ? 1 : status === "incomplete" ? 2 : 0;
}

function environmentEvidence() {
  const npmVersion = spawnSync("npm", ["--version"], { encoding: "utf8" }).stdout.trim();
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const branch = spawnSync("git", ["branch", "--show-current"], { encoding: "utf8" }).stdout.trim();
  const worktree = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" }).stdout;
  return {
    node: process.version,
    npm: npmVersion,
    mqttJs: mqtt.VERSION ?? "5.14.1",
    branch,
    commit,
    worktreeDirty: Boolean(worktree.trim()),
    proxyConfigured: Boolean(
      process.env.HTTPS_PROXY ??
        process.env.https_proxy ??
        process.env.HTTP_PROXY ??
        process.env.http_proxy,
    ),
  };
}

function scenarioMetadata(endpoint, protocolVersion, authMode, qosLevels) {
  return {
    transport: endpoint.transport,
    port: endpoint.port,
    protocolVersion,
    authMode,
    qosLevels,
  };
}

function endpointUrl(endpoint) {
  return `${endpoint.transport}://${PROVIDER}:${endpoint.port}${endpoint.path ?? ""}`;
}

function topicFor(suffix) {
  return `${namespace}/${suffix}/${randomBytes(8).toString("hex")}`;
}

function clientIdFor(suffix) {
  const suffixHash = hashPrefix(`${suffix}:${runSecret.toString("hex")}`, 8);
  return `mqtt-sync-${suffixHash}-${randomBytes(10).toString("hex")}`;
}

function payloadFor(label) {
  return Buffer.concat([
    Buffer.from("mqtt-sync-synthetic:"),
    createHash("sha256")
      .update(runSecret)
      .update(label)
      .update(randomBytes(12))
      .digest()
      .subarray(0, 12),
  ]);
}

function credentialsPresent(role) {
  return Boolean(
    process.env[`MQTT_PUBLIC_${role}_USERNAME`] && process.env[`MQTT_PUBLIC_${role}_PASSWORD`],
  );
}

function buffersEqual(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
}

function hashPrefix(value, length = 12) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function safeRunId(value) {
  if (/^[a-z0-9][a-z0-9._-]{0,95}$/iu.test(value)) return value;
  return `invalid-run-id-${hashPrefix(value)}`;
}

function errorReasonCode(error) {
  if (error instanceof BlockedError || error instanceof AssertionFailure) return error.reasonCode;
  return isInfrastructureError(error) ? "external-prerequisite-unavailable" : "unexpected-failure";
}

function resultCode(error) {
  const value = error?.resultCode ?? error?.code ?? error?.packet?.reasonCode;
  if (typeof value === "number") return String(value);
  if (typeof value === "string" && /^[A-Z0-9_-]{1,80}$/iu.test(value)) return value;
  return undefined;
}

function isAuthenticationRejection(error) {
  const code = resultCode(error);
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return ["4", "5", "134", "135"].includes(code) || /not authorized|bad user/u.test(message);
}

function isExpiredCertificateError(error) {
  const code = resultCode(error);
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return code === "CERT_HAS_EXPIRED" || /certificate has expired/u.test(message);
}

function isSimpleNetworkFailure(error) {
  const code = resultCode(error);
  return [
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ETIMEDOUT",
    "EAI_AGAIN",
  ].includes(code);
}

function isInfrastructureError(error) {
  if (error instanceof BlockedError) return true;
  if (error instanceof AssertionFailure) return false;
  const code = resultCode(error);
  return (
    isSimpleNetworkFailure(error) ||
    code === "ENOTFOUND" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    (error instanceof Error && /timed out|timeout|connection-closed/u.test(error.message))
  );
}

function assert(condition, reasonCode) {
  if (!condition) throw new AssertionFailure(reasonCode);
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new BlockedError(`${label}-timeout`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
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
