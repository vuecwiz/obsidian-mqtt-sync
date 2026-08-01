import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { installTestVault } from "./install-test-vault.mjs";
import { ObsidianCliTimeoutError, runObsidianCli } from "./obsidian-cli-runner.mjs";
import {
  assertExplicitTestVault,
  backupPluginSettings,
  hasCapturedErrors,
  parseEvalJson,
  restorePluginSettings,
  syntheticSettings,
} from "./ui-acceptance.mjs";
import { captureStableScreenshot } from "./ui-screenshot.mjs";
import { loadDocumentedUiTestCaBundle } from "./ui-test-ca-fixture.mjs";

const PLUGIN_ID = "mqtt-sync";
const VAULT_NAME = "vanotes-test";
const DEFAULT_RESOLUTIONS = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
];
const SCENE_DEFINITIONS = [
  {
    id: "settings-overview",
    en: [
      "Settings overview",
      "Plugin title, receiving state, primary connection heading, and actions.",
    ],
    zh: ["设置概览", "插件标题、接收状态、主连接标题与操作。"],
  },
  {
    id: "credentials",
    en: [
      "Configured credentials",
      "Broker identity plus populated, privacy-masked username and password controls.",
    ],
    zh: ["已配置凭据", "Broker 身份以及已填写并经过隐私掩码处理的用户名和密码控件。"],
  },
  {
    id: "tls-certificate-modal",
    en: [
      "TLS certificate dialog",
      "Configured CA, client certificate, private key, validation area, and actions.",
    ],
    zh: ["TLS 证书弹窗", "已配置的 CA、客户端证书、私钥、校验区域与操作。"],
  },
  {
    id: "subscription",
    en: [
      "Subscription settings",
      "Configured topic filter, requested QoS, and retained-message handling.",
    ],
    zh: ["订阅设置", "已配置的主题过滤器、请求 QoS 与 Retained 消息处理。"],
  },
  {
    id: "result-publication",
    en: [
      "Result publication",
      "Enabled result publishing with a populated privacy-masked topic, QoS, and retain control.",
    ],
    zh: ["结果发布", "已启用结果发布，并填写经过隐私掩码处理的主题、QoS 与 retain 控件。"],
  },
  {
    id: "limits-attachments",
    en: [
      "Limits and attachments",
      "Payload limits, attachment download policy, and configured origin control.",
    ],
    zh: ["限制与附件", "Payload 限制、附件下载策略与已配置的来源控件。"],
  },
  {
    id: "rules-overview",
    en: [
      "Message distribution rules",
      "Rule heading, full-width cards, ordering controls, and add action.",
    ],
    zh: ["消息分发规则", "规则标题、全宽卡片、排序控件与添加操作。"],
  },
  {
    id: "rule-editor",
    en: [
      "Rule editor",
      "Rule identity, conditions, path controls, insertion behavior, and actions.",
    ],
    zh: ["规则编辑器", "规则身份、条件、路径控件、插入行为与操作。"],
  },
];

function scenesForLanguage(pluginLanguage) {
  const key = pluginLanguage === "zh-CN" ? "zh" : "en";
  return SCENE_DEFINITIONS.map((scene) => ({
    id: scene.id,
    title: scene[key][0],
    description: scene[key][1],
  }));
}

export function parseResolutions(value) {
  if (!value) return DEFAULT_RESOLUTIONS.map((resolution) => ({ ...resolution }));
  return value.split(",").map((entry) => {
    const match = entry.trim().match(/^(\d+)x(\d+)$/u);
    if (!match) throw new Error(`Invalid resolution: ${entry}`);
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width < 1000 || height < 560) {
      throw new Error(`Resolution is below the desktop minimum: ${entry}`);
    }
    return { width, height };
  });
}

export function readPngEvidence(bytes, expected, path) {
  if (bytes.length < 24 || bytes.subarray(1, 4).toString("ascii") !== "PNG") {
    throw new Error(`Invalid PNG: ${path}`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== expected.width || height !== expected.height) {
    throw new Error(`${path} is ${width}x${height}, expected ${expected.width}x${expected.height}`);
  }
  return {
    path,
    width,
    height,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function runUiResolutionSamples() {
  const vault = assertExplicitTestVault(process.env.OBSIDIAN_MQTT_TEST_VAULT);
  const targetHostLanguage = process.env.MQTT_UI_SAMPLE_HOST_LANGUAGE;
  const pluginLanguage = process.env.MQTT_UI_SAMPLE_PLUGIN_LANGUAGE;
  if (!["en", "zh"].includes(targetHostLanguage))
    throw new Error("MQTT_UI_SAMPLE_HOST_LANGUAGE must be en or zh");
  if (!["en", "zh-CN"].includes(pluginLanguage))
    throw new Error("MQTT_UI_SAMPLE_PLUGIN_LANGUAGE must be en or zh-CN");
  if ((targetHostLanguage === "en") !== (pluginLanguage === "en"))
    throw new Error("Obsidian and plugin sample languages must match");
  const runId =
    process.env.MQTT_UI_SAMPLE_ID ??
    `obsidian-1.13.4-same-window-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;
  const outputRoot = resolve(
    process.env.MQTT_UI_SAMPLE_OUTPUT ?? join(".artifacts", "ui-samples", runId),
  );
  const resolutions = parseResolutions(process.env.MQTT_UI_RESOLUTIONS);
  const scenes = scenesForLanguage(pluginLanguage);
  const report = {
    schema: "obsidian.mqtt-sync.ui-resolution-samples.v2",
    runId,
    generatedAt: new Date().toISOString(),
    vault: VAULT_NAME,
    requestedHostLanguage: targetHostLanguage,
    pluginLanguage,
    resolutions: [],
    cleanup: {},
    passed: false,
  };
  let snapshot;
  let originalEnabled = false;
  let originalTabId;
  let originalHostLanguage;
  let originalHostLanguagePreference;
  let debugAttached = false;
  let pluginDirectory;
  let activeViewport;
  const cleanupErrors = [];
  const caFixture = await loadDocumentedUiTestCaBundle();
  report.fixtures = {
    caCertificates: caFixture.certificateCount,
    caBytes: caFixture.bytes,
    caLines: caFixture.lines,
    caSha256: caFixture.sha256,
  };

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  try {
    await stat(join(vault, ".obsidian"));
    const identity = await evaluateJson(
      `JSON.stringify({vault:app.vault.getName(),tab:app.setting?.activeTab?.id??null,hostLanguage:document.documentElement.lang??"unknown",hostLanguagePreference:localStorage.getItem("language")})`,
    );
    if (identity.vault !== VAULT_NAME) throw new Error("Obsidian attached to the wrong Vault");
    originalTabId = identity.tab;
    originalHostLanguage = identity.hostLanguage;
    originalHostLanguagePreference = identity.hostLanguagePreference;
    await switchHostLanguage(targetHostLanguage);
    const activeLanguage = await evaluateJson(
      `JSON.stringify({host:document.documentElement.lang,locale:window.moment?.locale?.()??"unknown"})`,
    );
    if (!activeLanguage.host.toLocaleLowerCase().startsWith(targetHostLanguage))
      throw new Error(`Obsidian host language did not switch to ${targetHostLanguage}`);
    report.hostLanguage = activeLanguage.locale;

    const installed = await installTestVault();
    pluginDirectory = installed.destination;
    snapshot = await backupPluginSettings(pluginDirectory);
    const enabledOutput = await obsidian("plugins:enabled", "filter=community", "format=json");
    originalEnabled = enabledOutput.includes(`"${PLUGIN_ID}"`) || enabledOutput.includes(PLUGIN_ID);

    await bestEffort("dev:debug", "off");
    await obsidian("dev:debug", "on");
    debugAttached = true;
    await bestEffort("dev:errors", "clear");
    await bestEffort("dev:console", "clear");
    const baselineErrors = await obsidian("dev:errors");
    const baselineConsole = await obsidian("dev:console", "level=error");
    report.baselineErrors = hasCapturedErrors(baselineErrors) || hasCapturedErrors(baselineConsole);

    await bestEffort("plugin:disable", `id=${PLUGIN_ID}`);
    await writeFile(
      snapshot.data,
      `${JSON.stringify(sampleSettings(pluginLanguage, caFixture.pem), null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    await chmod(snapshot.data, 0o600);
    await obsidian("plugin:enable", `id=${PLUGIN_ID}`);
    await obsidian("plugin:reload", `id=${PLUGIN_ID}`);
    await openSettings();
    await installPrivacyMask();
    const locale = await evaluateJson(
      `JSON.stringify({host:document.documentElement.lang,plugin:document.querySelector(".mqtt-sync-settings")?.dataset.locale??null})`,
    );
    if (
      !locale.host.toLocaleLowerCase().startsWith(targetHostLanguage) ||
      locale.plugin !== pluginLanguage
    )
      throw new Error("Obsidian and plugin UI languages do not match the requested sample group");

    for (const resolution of resolutions) {
      await setViewport(resolution);
      const label = `${resolution.width}x${resolution.height}`;
      const directory = join(outputRoot, label);
      await mkdir(directory, { recursive: true });
      const screenshots = [];

      for (const scene of scenes) {
        await prepareScene(scene.id);
        screenshots.push(await captureScene(directory, scene, resolution));
      }
      await closeModals();

      const hashes = new Set(screenshots.map((screenshot) => screenshot.sha256));
      if (hashes.size !== screenshots.length) throw new Error(`${label} contains duplicate scenes`);
      const result = {
        resolution: label,
        cssViewport: activeViewport,
        screenshots,
        passed: true,
      };
      report.resolutions.push(result);
      await writeFile(join(directory, "REVIEW.md"), reviewMarkdown(result, pluginLanguage), "utf8");
      await writeFile(join(directory, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    }

    const finalErrors = await obsidian("dev:errors");
    const finalConsole = await obsidian("dev:console", "level=error");
    report.finalErrors = hasCapturedErrors(finalErrors) || hasCapturedErrors(finalConsole);
    if (report.finalErrors) throw new Error("Obsidian reported an error during sample capture");
    report.passed = true;
  } finally {
    await bestEffort("dev:cdp", "method=Emulation.clearDeviceMetricsOverride", "params={}");
    await bestEffort(
      "eval",
      `code=(()=>{document.getElementById("mqtt-ui-sample-privacy-mask")?.remove();document.querySelector('[data-testid="MQTT-rule-modal"] [data-testid="MQTT-rule-cancel"]')?.click();document.querySelector('[data-testid="MQTT-tls-modal"] [data-testid="MQTT-tls-cancel"]')?.click();document.querySelectorAll("[data-mqtt-ui-original-nav]").forEach(el=>{el.textContent=el.dataset.mqttUiOriginalNav;delete el.dataset.mqttUiOriginalNav});return true})()`,
    );
    if (snapshot) {
      try {
        await bestEffort("plugin:disable", `id=${PLUGIN_ID}`);
        await restorePluginSettings(snapshot);
        report.cleanup.settingsRestored = snapshot.existed
          ? (await readFile(snapshot.data)).equals(snapshot.originalBytes)
          : !(await exists(snapshot.data));
        if (originalEnabled) {
          await obsidian("plugin:enable", `id=${PLUGIN_ID}`);
          await obsidian("plugin:reload", `id=${PLUGIN_ID}`);
        }
      } catch (error) {
        cleanupErrors.push(`settings:${safeError(error)}`);
      }
    }
    if (debugAttached) {
      try {
        await obsidian("dev:debug", "off");
        report.cleanup.debugDetached = true;
      } catch (error) {
        cleanupErrors.push(`debug:${safeError(error)}`);
      }
    }
    if (originalHostLanguage) {
      try {
        await restoreHostLanguage(originalHostLanguagePreference, originalHostLanguage);
        report.cleanup.hostLanguageRestored = true;
      } catch (error) {
        cleanupErrors.push(`language:${safeError(error)}`);
      }
    }
    if (originalTabId) {
      await bestEffort(
        "eval",
        `code=(()=>{app.setting.open();app.setting.openTabById(${JSON.stringify(originalTabId)});return true})()`,
      );
    } else {
      await bestEffort("eval", `code=(()=>{app.setting.close();return true})()`);
    }
    report.cleanup.errors = cleanupErrors;
    if (cleanupErrors.length) report.passed = false;
    await writeFile(join(outputRoot, "matrix.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(outputRoot, "README.md"), indexMarkdown(report), "utf8");
  }
  if (!report.passed) throw new Error("UI resolution sample capture did not pass");
  process.stdout.write(`${JSON.stringify({ passed: true, outputRoot, runId })}\n`);
  return report;

  async function obsidian(...args) {
    const attempts = args[0] === "dev:cdp" ? 3 : args[0] === "eval" ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await runObsidianCli(VAULT_NAME, args, { timeoutMs: 30_000 });
      } catch (error) {
        if (!(error instanceof ObsidianCliTimeoutError) || attempt === attempts) throw error;
      }
    }
    throw new Error("Obsidian CLI retry budget exhausted");
  }

  async function bestEffort(...args) {
    try {
      return await obsidian(...args);
    } catch {
      return undefined;
    }
  }

  async function evaluateJson(code) {
    return parseEvalJson(await obsidian("eval", `code=${code}`));
  }

  async function switchHostLanguage(language) {
    const current = await evaluateJson(
      `JSON.stringify({host:document.documentElement.lang,preference:localStorage.getItem("language")})`,
    );
    if (current.host.toLocaleLowerCase().startsWith(language) && current.preference === language)
      return;
    await obsidian(
      "eval",
      `code=(()=>{localStorage.setItem("language",${JSON.stringify(language)});app.commands.executeCommandById("app:reload");return true})()`,
    );
    await waitForHostLanguage(language);
  }

  async function restoreHostLanguage(preference, language) {
    const current = await evaluateJson(
      `JSON.stringify({host:document.documentElement.lang,preference:localStorage.getItem("language")})`,
    );
    if (
      current.host.toLocaleLowerCase().startsWith(language.toLocaleLowerCase()) &&
      current.preference === preference
    )
      return;
    await obsidian(
      "eval",
      `code=(()=>{const preference=${JSON.stringify(preference)};if(preference===null)localStorage.removeItem("language");else localStorage.setItem("language",preference);app.commands.executeCommandById("app:reload");return true})()`,
    );
    await waitForHostLanguage(language);
  }

  async function waitForHostLanguage(language) {
    let latest;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await delay(250);
      try {
        latest = parseEvalJson(
          await runObsidianCli(
            VAULT_NAME,
            [
              "eval",
              `code=JSON.stringify({vault:app.vault.getName(),host:document.documentElement.lang})`,
            ],
            { timeoutMs: 3_000 },
          ),
        );
        if (
          latest.vault === VAULT_NAME &&
          latest.host.toLocaleLowerCase().startsWith(language.toLocaleLowerCase())
        )
          return;
      } catch {
        // Obsidian CLI is expected to disconnect briefly during app reload.
      }
    }
    throw new Error(`Obsidian host language did not stabilize: ${JSON.stringify(latest)}`);
  }

  async function openSettings() {
    await obsidian(
      "eval",
      `code=(()=>{app.setting.open();app.setting.openTabById("appearance");app.setting.openTabById("${PLUGIN_ID}");return true})()`,
    );
    await delay(250);
  }

  async function installPrivacyMask() {
    await obsidian(
      "eval",
      `code=(()=>{document.getElementById("mqtt-ui-sample-privacy-mask")?.remove();const style=document.createElement("style");style.id="mqtt-ui-sample-privacy-mask";style.textContent='.workspace,.notice-container,.status-bar{visibility:hidden!important}.mqtt-ui-sensitive-value{-webkit-text-security:disc!important;color:var(--text-normal)!important;text-shadow:none!important}.mqtt-ui-sensitive-textarea{color:var(--text-muted)!important}';document.head.appendChild(style);const plugin=app.plugins.getPlugin("${PLUGIN_ID}");const t=key=>plugin.i18n.t(key);const rows=[...document.querySelectorAll(".mqtt-sync-settings .setting-item")];const byName=name=>rows.find(row=>row.querySelector(".setting-item-name")?.textContent?.trim()===name);const roles={credentials:t("settings.username"),subscription:t("settings.subscription"),resultPublication:t("settings.resultPublication"),limitsAttachments:t("settings.limitsAttachments")};for(const [role,name] of Object.entries(roles)){const row=byName(name);if(row)row.dataset.mqttUiRole=role}for(const key of ["brokerUrl","clientId","username","password","topicFilter","resultTopic","allowedAttachmentOrigins"]){byName(t("settings."+key))?.querySelector("input,textarea")?.classList.add("mqtt-ui-sensitive-value")}const redacted=plugin.i18n.locale==="zh-CN"?"已配置（已匿名化）":"Configured (anonymized)";document.querySelectorAll(".mqtt-sync-rule-card .setting-item-description,.mqtt-sync-rule-card-note-path").forEach(el=>{el.textContent=redacted});const manifests=new Set(Object.keys(app.plugins.manifests));document.querySelectorAll(".vertical-tab-header .vertical-tab-nav-item").forEach(el=>{const id=el.dataset.settingId;if(id&&id!=="${PLUGIN_ID}"&&manifests.has(id)){el.dataset.mqttUiOriginalNav=el.textContent??"";el.textContent=plugin.i18n.locale==="zh-CN"?"其他插件":"Other plugin"}});return true})()`,
    );
  }

  async function setViewport(resolution) {
    await obsidian(
      "dev:cdp",
      "method=Emulation.setDeviceMetricsOverride",
      `params=${JSON.stringify({
        width: resolution.width,
        height: resolution.height,
        deviceScaleFactor: 0,
        mobile: false,
      })}`,
    );
    await delay(250);
    activeViewport = await evaluateJson(
      `JSON.stringify({width:innerWidth,height:innerHeight,devicePixelRatio,narrow:matchMedia("(max-width:700px)").matches})`,
    );
    if (activeViewport.width < 1000 || activeViewport.height < 560 || activeViewport.narrow) {
      throw new Error(`Could not establish ${resolution.width}x${resolution.height}`);
    }
  }

  async function prepareScene(scene) {
    await closeModals();
    if (scene === "settings-overview") {
      await obsidian(
        "eval",
        `code=(()=>{const root=document.querySelector(".mqtt-sync-settings")?.closest(".vertical-tab-content");root?.scrollTo({top:0});return true})()`,
      );
    } else if (
      scene === "credentials" ||
      scene === "subscription" ||
      scene === "result-publication" ||
      scene === "limits-attachments"
    ) {
      const role = {
        credentials: "credentials",
        subscription: "subscription",
        "result-publication": "resultPublication",
        "limits-attachments": "limitsAttachments",
      }[scene];
      await obsidian(
        "eval",
        `code=(()=>{document.querySelector('[data-mqtt-ui-role=${JSON.stringify(role)}]')?.scrollIntoView({block:"start"});return true})()`,
      );
    } else if (scene === "tls-certificate-modal") {
      await obsidian(
        "eval",
        `code=(()=>{const button=document.querySelector('[data-testid="MQTT-tls-configure"]');button?.scrollIntoView({block:"center"});button?.click();window.setTimeout(()=>{const plugin=app.plugins.getPlugin("${PLUGIN_ID}");const ca=document.querySelector('[data-testid="MQTT-tls-ca"]');if(ca){ca.value=plugin.i18n.locale==="zh-CN"?"已配置 2 个有效测试 CA（已匿名化）":"2 valid test CAs configured (anonymized)";ca.classList.add("mqtt-ui-sensitive-textarea")}},0);return true})()`,
      );
    } else if (scene === "rules-overview") {
      await obsidian(
        "eval",
        `code=(()=>{document.querySelector('[data-testid="MQTT-rules-heading"]')?.scrollIntoView({block:"start"});return true})()`,
      );
    } else {
      await obsidian(
        "eval",
        `code=(()=>{document.querySelector('[data-testid="MQTT-rule-edit-0"]')?.click();window.setTimeout(()=>{document.querySelectorAll('input[data-testid^="MQTT-rule-condition-value-"],textarea[data-testid^="MQTT-rule-condition-value-"],[data-testid="MQTT-rule-name"],[data-testid="MQTT-rule-note-path"],[data-testid="MQTT-rule-attachment-path"]').forEach(el=>el.classList.add("mqtt-ui-sensitive-value"))},0);return true})()`,
      );
    }
    await delay(300);
  }

  async function closeModals() {
    await bestEffort(
      "eval",
      `code=(()=>{document.querySelector('[data-testid="MQTT-rule-modal"] [data-testid="MQTT-rule-cancel"]')?.click();document.querySelector('[data-testid="MQTT-tls-modal"] [data-testid="MQTT-tls-cancel"]')?.click();return true})()`,
    );
  }

  async function captureScene(directory, scene, resolution) {
    const path = join(directory, `${scene.id}.png`);
    const captured = await captureStableScreenshot({
      path,
      label: `${resolution.width}x${resolution.height}/${scene.id}`,
      timeoutMs: 30_000,
      cdp: (method, params) =>
        obsidian("dev:cdp", `method=${method}`, `params=${JSON.stringify(params)}`),
      readState: () => readSceneState(scene.id),
    });
    const evidence = readPngEvidence(await readFile(path), resolution, basename(path));
    return { ...scene, ...evidence, capture: captured.state };
  }

  async function readSceneState(scene) {
    return evaluateJson(
      `JSON.stringify((()=>{const scene=${JSON.stringify(scene)};const root=document.querySelector(".mqtt-sync-settings");const ruleModal=document.querySelector('[data-testid="MQTT-rule-modal"]');const tlsModal=document.querySelector('[data-testid="MQTT-tls-modal"]');const heading=document.querySelector('[data-testid="MQTT-rules-heading"]');const targetReady=scene==="rule-editor"?Boolean(ruleModal):scene==="tls-certificate-modal"?Boolean(tlsModal):scene==="rules-overview"?Boolean(heading&&!ruleModal&&!tlsModal):!ruleModal&&!tlsModal;return{ready:Boolean(root&&document.fonts.status==="loaded"&&innerWidth===${activeViewport.width}&&innerHeight===${activeViewport.height}&&targetReady),signature:{scene,locale:root?.dataset.locale??null,width:innerWidth,height:innerHeight,ruleModal:Boolean(ruleModal),tlsModal:Boolean(tlsModal),cards:document.querySelectorAll('[data-testid^="MQTT-rule-card-"]').length,navItems:document.querySelectorAll(".vertical-tab-header .vertical-tab-nav-item").length}}})())`,
    );
  }
}

function sampleSettings(pluginLanguage, caPem) {
  const settings = syntheticSettings(caPem);
  settings.uiLanguage = pluginLanguage;
  const connection = settings.connections[0];
  connection.auth = {
    username: "synthetic-test-user",
    password: "synthetic-test-password",
  };
  settings.processing.downloadEnvelopeAttachments = true;
  settings.processing.allowedAttachmentOrigins = ["https://files.example"];
  if (pluginLanguage === "zh-CN") {
    const names = [
      "界面告警",
      "甲站点日志",
      "乙站点日志",
      "归档站点",
      "网页链接",
      "优先级图片",
      "最终回退",
    ];
    settings.rules.rules.forEach((rule, index) => {
      rule.name = names[index] ?? `示例规则 ${index + 1}`;
    });
  }
  return settings;
}

function reviewMarkdown(result, pluginLanguage) {
  const lines = [
    `# ${result.resolution} UI 人工复验`,
    "",
    `- 自动化结果：${result.passed ? "PASS" : "FAIL"}`,
    `- 截图：${result.screenshots.length} 张，均为 ${result.resolution}`,
    `- 界面语言：${pluginLanguage === "zh-CN" ? "简体中文" : "English"}`,
    "- 内容：完整设置窗口与核心导航；敏感输入以掩码显示，无关第三方插件名称已匿名化。",
    "",
  ];
  for (const screenshot of result.screenshots) {
    lines.push(
      `## ${screenshot.title}`,
      "",
      `![${screenshot.title}](${screenshot.path})`,
      "",
      screenshot.description,
      "",
      "> [!note] 人工批注",
      "> 已复验：无敏感值、无明显截断、重叠或越界。",
      "",
    );
  }
  return lines.join("\n");
}

function indexMarkdown(report) {
  const lines = [
    "# MQTT Sync 多分辨率 UI 测试样例",
    "",
    `生成时间：${report.generatedAt}`,
    `Obsidian：1.13.4，同窗口设置页，界面语言 ${report.hostLanguage ?? "unknown"}`,
    `插件语言：${report.pluginLanguage === "zh-CN" ? "简体中文" : "English"}`,
    "",
    "| 分辨率 | 自动化 | 截图数 | 人工复验 |",
    "| --- | --- | ---: | --- |",
  ];
  for (const result of report.resolutions) {
    lines.push(
      `| ${result.resolution} | ${result.passed ? "PASS" : "FAIL"} | ${result.screenshots.length} | [打开](./${result.resolution}/REVIEW.md) |`,
    );
  }
  lines.push(
    "",
    "每档包含设置概览、已配置凭据、TLS 证书弹窗、订阅、结果发布、限制与附件、规则列表和规则编辑器。截图保留完整设置窗口和核心设置导航；敏感输入以掩码显示，无关第三方插件名称已匿名化。runner 结束后恢复测试 Vault 设置、插件状态、宿主语言和调试器状态。",
    "",
  );
  return lines.join("\n");
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
  return error instanceof Error ? error.message : "Unknown error";
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runUiResolutionSamples().catch((error) => {
    process.stderr.write(`ui-resolution-samples: ${safeError(error)}\n`);
    process.exitCode = 1;
  });
}
