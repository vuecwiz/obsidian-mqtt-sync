import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installTestVault } from "./install-test-vault.mjs";
import { runObsidianCli } from "./obsidian-cli-runner.mjs";
import { loadDocumentedUiTestCaBundle } from "./ui-test-ca-fixture.mjs";

const REQUIRED_VAULT_NAME = "vanotes-test";
const PLUGIN_ID = "mqtt-sync";
const VIEWPORTS = [
  [1280, 720],
  [1440, 900],
  [1920, 1080],
  [2560, 1440],
];

export function assertExplicitTestVault(value) {
  if (!value) throw new Error("OBSIDIAN_MQTT_TEST_VAULT is required for UI acceptance");
  const vault = resolve(value);
  if (basename(vault) !== REQUIRED_VAULT_NAME) {
    throw new Error("UI acceptance is restricted to an explicit vanotes-test Vault");
  }
  return vault;
}

export async function backupPluginSettings(pluginDirectory) {
  const data = join(pluginDirectory, "data.json");
  const backup = join(pluginDirectory, "data.ui-acceptance-backup.json");
  if (await exists(backup)) {
    await copyFile(backup, data);
    await chmod(data, 0o600);
    await unlink(backup);
  }
  const existed = await exists(data);
  const originalBytes = existed ? await readFile(data) : undefined;
  if (existed) {
    await copyFile(data, backup);
    await chmod(backup, 0o600);
  }
  return { data, backup, existed, originalBytes };
}

export async function restorePluginSettings(snapshot) {
  if (snapshot.existed) {
    await copyFile(snapshot.backup, snapshot.data);
    await chmod(snapshot.data, 0o600);
  } else {
    await rm(snapshot.data, { force: true });
  }
  await rm(snapshot.backup, { force: true });
}

export function parseEvalJson(output) {
  const marker = output.match(/=>\s*(.*)\s*$/mu)?.[1];
  if (!marker) throw new Error("Obsidian eval returned no result");
  const parsed = JSON.parse(marker);
  if (typeof parsed === "string") return JSON.parse(parsed);
  return parsed;
}

export function hasCapturedErrors(output) {
  const normalized = output.trim().toLowerCase();
  return Boolean(
    normalized && !normalized.includes("no errors") && !normalized.includes("no console messages"),
  );
}

export async function readPngDimensions(path) {
  const bytes = await readFile(path);
  if (bytes.length < 24 || bytes.subarray(1, 4).toString("ascii") !== "PNG") {
    throw new Error("Obsidian screenshot is not a PNG");
  }
  return { bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export async function runUiAcceptance() {
  const vault = assertExplicitTestVault(process.env.OBSIDIAN_MQTT_TEST_VAULT);
  const caFixture = await loadDocumentedUiTestCaBundle();
  const testSettings = syntheticSettings(caFixture.pem);
  const runId = process.env.MQTT_UI_RUN_ID ?? new Date().toISOString().replace(/[:.]/gu, "-");
  const relativeDirectory = join(".artifacts", "ui", runId);
  const directory = resolve(relativeDirectory);
  await mkdir(directory, { recursive: true });
  const reportPath = join(directory, "report.json");
  const report = {
    schema: "obsidian.mqtt-sync.ui-acceptance.v2",
    runId,
    generatedAt: new Date().toISOString(),
    vault: REQUIRED_VAULT_NAME,
    status: "failed",
    prerequisites: { explicitVault: true, runningObsidian: false },
    checks: {},
    fixtures: {
      caCertificates: caFixture.certificateCount,
      caBytes: caFixture.bytes,
      caLines: caFixture.lines,
      caSha256: caFixture.sha256,
    },
    screenshots: [],
    errorDelta: { baselinePresent: false, finalPresent: false, pluginAttributed: null },
    cleanup: {
      settingsRestored: false,
      pluginStateRestored: false,
      viewportRestored: false,
      debugDetached: false,
    },
  };
  let snapshot;
  let originalEnabled = false;
  let originalViewport;
  let originalTabId;
  let vaultName = REQUIRED_VAULT_NAME;
  let pluginDirectory;
  const cleanupErrors = [];
  try {
    await stat(join(vault, ".obsidian"));
    const identity = parseEvalJson(
      await runObsidianCli(vaultName, [
        "eval",
        "code=JSON.stringify({vault:app.vault.getName(),width:window.innerWidth,height:window.innerHeight,outerWidth:window.outerWidth,outerHeight:window.outerHeight,screenX:window.screenX,screenY:window.screenY,tab:app.setting?.activeTab?.id??null})",
      ]),
    );
    if (identity.vault !== REQUIRED_VAULT_NAME)
      throw new Error("Obsidian attached to the wrong Vault");
    report.prerequisites.runningObsidian = true;
    originalViewport = {
      width: identity.width,
      height: identity.height,
      outerWidth: identity.outerWidth,
      outerHeight: identity.outerHeight,
      screenX: identity.screenX,
      screenY: identity.screenY,
    };
    originalTabId = typeof identity.tab === "string" ? identity.tab : null;

    const installed = await installTestVault();
    vaultName = installed.vaultName;
    pluginDirectory = installed.destination;
    const manifestRefresh = parseEvalJson(
      await runObsidianCli(vaultName, [
        "eval",
        `code=(async()=>{await app.plugins.loadManifests();return JSON.stringify({found:Boolean(app.plugins.manifests["${PLUGIN_ID}"])});})()`,
      ]),
    );
    if (!manifestRefresh.found) throw new Error("Obsidian did not discover the MQTT Sync manifest");
    snapshot = await backupPluginSettings(pluginDirectory);
    const enabledOutput = await runObsidianCli(vaultName, [
      "plugins:enabled",
      "filter=community",
      "format=json",
    ]);
    originalEnabled = enabledOutput.includes(`"${PLUGIN_ID}"`) || enabledOutput.includes(PLUGIN_ID);

    await bestEffortCli(vaultName, ["dev:debug", "off"]);
    await runObsidianCli(vaultName, ["dev:debug", "on"]);
    await bestEffortCli(vaultName, ["dev:errors", "clear"]);
    await bestEffortCli(vaultName, ["dev:console", "clear"]);
    const baselineErrors = await runObsidianCli(vaultName, ["dev:errors"]);
    report.errorDelta.baselinePresent = hasCapturedErrors(baselineErrors);

    await bestEffortCli(vaultName, ["plugin:disable", `id=${PLUGIN_ID}`]);
    await writeFile(snapshot.data, `${JSON.stringify(testSettings, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(snapshot.data, 0o600);
    await runObsidianCli(vaultName, ["plugin:enable", `id=${PLUGIN_ID}`]);
    await runObsidianCli(vaultName, ["plugin:reload", `id=${PLUGIN_ID}`]);
    await openFreshSettingsTab(vaultName);

    const dom = parseEvalJson(
      await runObsidianCli(vaultName, [
        "eval",
        `code=JSON.stringify((()=>{const p=app.plugins.plugins["${PLUGIN_ID}"];const roots=[...document.querySelectorAll(".mqtt-sync-settings")];const rows=[...document.querySelectorAll(".vertical-tab-content .setting-item")];const heading=document.querySelector('[data-testid="MQTT-primary-connection-heading"]');const headingItems=heading?.parentElement;const headingBackground=headingItems?getComputedStyle(headingItems).backgroundColor:null;const insecure=document.querySelector('[data-testid="MQTT-allow-insecure-remote-setting"]');const tls=document.querySelector('[data-testid="MQTT-tls-setting"]');return{loaded:Boolean(p),pluginId:p?.manifest.id??null,pluginName:p?.manifest.name??null,rootCount:roots.length,rowCount:rows.length,inputCount:rows.filter(r=>r.querySelector("input,textarea,select")).length,statusCount:document.querySelectorAll('[data-testid="mqtt-sync-status"]').length,settingsOpen:Boolean(app.setting?.activeTab?.id==="${PLUGIN_ID}"),primaryHeading:Boolean(heading),primaryHeadingOwnWrapper:headingItems?.classList.contains('mqtt-sync-primary-heading-items')??false,primaryHeadingTransparent:headingBackground==='rgba(0, 0, 0, 0)'||headingBackground==='transparent',primaryHeadingBackground:headingBackground,applyInHeading:Boolean(heading?.querySelector('[data-testid="MQTT-apply"]')),testInHeading:Boolean(heading?.querySelector('[data-testid="MQTT-test-connection"]')),insecureBeforeTls:Boolean(insecure&&tls&&(insecure.compareDocumentPosition(tls)&Node.DOCUMENT_POSITION_FOLLOWING))};})())`,
      ]),
    );
    report.checks.dom = {
      status:
        dom.loaded &&
        dom.pluginId === PLUGIN_ID &&
        dom.rootCount >= 1 &&
        dom.rowCount >= 20 &&
        dom.primaryHeading &&
        dom.primaryHeadingOwnWrapper &&
        dom.primaryHeadingTransparent &&
        dom.applyInHeading &&
        dom.testInHeading &&
        dom.insecureBeforeTls
          ? "passed"
          : "failed",
      pluginName: dom.pluginName,
      rootCount: dom.rootCount,
      rowCount: dom.rowCount,
      inputCount: dom.inputCount,
      statusCount: dom.statusCount,
      settingsOpen: dom.settingsOpen,
      primaryHeading: dom.primaryHeading,
      primaryHeadingOwnWrapper: dom.primaryHeadingOwnWrapper,
      primaryHeadingTransparent: dom.primaryHeadingTransparent,
      primaryHeadingBackground: dom.primaryHeadingBackground,
      applyInHeading: dom.applyInHeading,
      testInHeading: dom.testInHeading,
      insecureBeforeTls: dom.insecureBeforeTls,
    };

    const tlsLayout = parseEvalJson(
      await runObsidianCli(vaultName, [
        "eval",
        `code=(async()=>{const configure=document.querySelector('[data-testid="MQTT-tls-configure"]');configure?.click();await new Promise(r=>window.setTimeout(r,150));const modal=document.querySelector('[data-testid="MQTT-tls-modal"]');const ca=modal?.querySelector('[data-testid="MQTT-tls-ca"]');const result={modal:Boolean(modal),textareas:modal?.querySelectorAll('textarea').length??0,ca:Boolean(ca),clientCertificate:Boolean(modal?.querySelector('[data-testid="MQTT-tls-client-certificate"]')),privateKey:Boolean(modal?.querySelector('[data-testid="MQTT-tls-private-key"]')),saveButton:Boolean(modal?.querySelector('[data-testid="MQTT-tls-save"]')),rows:ca?.rows??0,clientHeight:ca?.clientHeight??0,scrollHeight:ca?.scrollHeight??0,valueLength:ca?.value.length??0,lineCount:ca?.value.split('\\n').length??0};modal?.querySelector('[data-testid="MQTT-tls-cancel"]')?.click();return JSON.stringify(result);})()`,
      ]),
    );
    report.checks.tlsCaLayout = {
      status:
        tlsLayout.modal &&
        tlsLayout.textareas === 3 &&
        tlsLayout.ca &&
        tlsLayout.clientCertificate &&
        tlsLayout.privateKey &&
        tlsLayout.saveButton &&
        tlsLayout.rows === 6 &&
        tlsLayout.clientHeight <= 150 &&
        tlsLayout.scrollHeight > tlsLayout.clientHeight &&
        tlsLayout.valueLength === caFixture.pem.length &&
        tlsLayout.lineCount === caFixture.lines
          ? "passed"
          : "failed",
      ...tlsLayout,
    };

    const ruleStructure = parseEvalJson(
      await runObsidianCli(vaultName, [
        "eval",
        `code=JSON.stringify((()=>{const configured=app.plugins.plugins["${PLUGIN_ID}"]?.settings?.rules?.rules??[];const hasCondition=(field,op,value)=>configured.some(rule=>rule.when?.all?.some(condition=>condition.field===field&&condition.op===op&&(value===undefined||condition.value===value)));const hasAttachmentCombination=configured.some(rule=>{const conditions=rule.when?.all??[];return conditions.some(c=>c.field==='firstUrlHost'&&c.op==='hostEquals')&&conditions.some(c=>c.field==='priority'&&c.op==='gte')&&conditions.some(c=>c.field==='hasAttachment'&&c.op==='equals'&&c.value===true)&&conditions.some(c=>c.field==='attachmentMime'&&c.op==='startsWith');});return{configuredRules:configured.length,hasMqttTopicQosRetain:hasCondition('topic','matchesFilter')&&hasCondition('qos','gte')&&hasCondition('retain','equals',false),hasHostOrSubdomain:hasCondition('firstUrlHost','hostOrSubdomainOf'),hasHttpUrl:hasCondition('hasHttpUrl','equals',true),hasAttachmentCombination,hasAfterHeading:configured.some(rule=>rule.action?.insertion==='after-heading'&&Boolean(rule.action?.heading)),fallbackLast:configured.length>0&&(configured.at(-1)?.when?.all?.length??-1)===0};})())`,
      ]),
    );
    const ruleUi = parseEvalJson(
      await runObsidianCli(vaultName, [
        "eval",
        `code=(async()=>{const cards=[...document.querySelectorAll('[data-testid^="MQTT-rule-card-"]')];const rulesHeading=document.querySelector('[data-testid="MQTT-rules-heading"]');const rulesHeadingItems=rulesHeading?.parentElement;const rulesHeadingBackground=rulesHeadingItems?getComputedStyle(rulesHeadingItems).backgroundColor:null;const primaryHeading=document.querySelector('[data-testid="MQTT-primary-connection-heading"]');const rect=el=>el?{left:Math.round(el.getBoundingClientRect().left),right:Math.round(el.getBoundingClientRect().right)}:null;const headingRect=rect(rulesHeading);const cardRect=rect(cards[0]);const primaryRect=rect(primaryHeading);const aligned=Boolean(headingRect&&cardRect&&primaryRect&&Math.abs(headingRect.left-primaryRect.left)<=2&&Math.abs(headingRect.right-primaryRect.right)<=2&&Math.abs(cardRect.left-primaryRect.left)<=2&&Math.abs(cardRect.right-primaryRect.right)<=2);const edit=document.querySelector('[data-testid="MQTT-rule-edit-0"]');edit?.click();await new Promise(r=>window.setTimeout(r,150));const modal=document.querySelector('[data-testid="MQTT-rule-modal"]');const result={cards:cards.length,addButton:Boolean(document.querySelector('[data-testid="MQTT-rule-add"]')),toggle:Boolean(document.querySelector('[data-testid="MQTT-rule-enabled-0"]')),moveDown:Boolean(document.querySelector('[data-testid="MQTT-rule-down-0"]')),edit:Boolean(edit),deleteButton:Boolean(document.querySelector('[data-testid="MQTT-rule-delete-0"]')),aligned,headingRect,cardRect,primaryRect,rulesHeadingOwnWrapper:rulesHeadingItems?.classList.contains('mqtt-sync-rules-heading-items')??false,rulesHeadingTransparent:rulesHeadingBackground==='rgba(0, 0, 0, 0)'||rulesHeadingBackground==='transparent',rulesHeadingBackground,modal:Boolean(modal),conditionCount:modal?.querySelectorAll('[data-testid^="MQTT-rule-condition-"]').length??0,saveButton:Boolean(modal?.querySelector('[data-testid="MQTT-rule-save"]'))};modal?.querySelector('[data-testid="MQTT-rule-cancel"]')?.click();return JSON.stringify(result);})()`,
      ]),
    );
    const ruleMutations = parseEvalJson(
      await runObsidianCli(vaultName, [
        "eval",
        `code=(async()=>{const p=app.plugins.plugins["${PLUGIN_ID}"];const wait=ms=>new Promise(resolve=>window.setTimeout(resolve,ms));const click=testid=>document.querySelector('[data-testid="'+testid+'"]')?.click();const persisted=async()=>await p.loadData();const originalRules=structuredClone(p.settings.rules);const originalClientId=p.settings.connections[0].clientId;const originalIds=originalRules.rules.map(rule=>rule.id);p.settings.connections[0].clientId='';await p.saveSettings(false);const blankClientSaved=(await persisted()).connections[0].clientId==='';click('MQTT-rule-add');await wait(150);const addModal=document.querySelector('[data-testid="MQTT-rule-modal"]');const addName=addModal?.querySelector('[data-testid="MQTT-rule-name"]');if(addName){addName.value='UI added mutation';addName.dispatchEvent(new Event('input',{bubbles:true}));}addModal?.querySelector('[data-testid="MQTT-rule-save"]')?.click();await wait(300);const afterAdd=await persisted();const addedRule=afterAdd.rules.rules.find(rule=>rule.name==='UI added mutation');const addSaved=Boolean(addedRule)&&afterAdd.rules.rules.length===originalIds.length+1&&!document.querySelector('[data-testid="MQTT-rule-modal"]');click('MQTT-rule-enabled-0');await wait(250);const afterToggle=await persisted();const toggleSaved=afterToggle.rules.rules[0]?.id===originalIds[0]&&afterToggle.rules.rules[0]?.enabled===false;click('MQTT-rule-down-0');await wait(250);const afterMove=await persisted();const moveSaved=afterMove.rules.rules[0]?.id===originalIds[1]&&afterMove.rules.rules[1]?.id===originalIds[0];click('MQTT-rule-edit-1');await wait(150);const editModal=document.querySelector('[data-testid="MQTT-rule-modal"]');const editName=editModal?.querySelector('[data-testid="MQTT-rule-name"]');if(editName){editName.value='UI edited mutation';editName.dispatchEvent(new Event('input',{bubbles:true}));}editModal?.querySelector('[data-testid="MQTT-rule-save"]')?.click();await wait(300);const afterEdit=await persisted();const editSaved=afterEdit.rules.rules[1]?.id===originalIds[0]&&afterEdit.rules.rules[1]?.name==='UI edited mutation'&&afterEdit.rules.rules[1]?.revision===afterToggle.rules.rules[0].revision+1;const addedIndex=p.settings.rules.rules.findIndex(rule=>rule.id===addedRule?.id);if(addedIndex>=0){click('MQTT-rule-delete-'+addedIndex);await wait(50);click('MQTT-rule-delete-'+addedIndex);await wait(300);}const afterDelete=await persisted();const deleteSaved=Boolean(addedRule)&&!afterDelete.rules.rules.some(rule=>rule.id===addedRule.id)&&afterDelete.rules.rules.length===originalIds.length;const mutatedOrder=afterDelete.rules.rules.map(rule=>rule.id);p.settings.rules=originalRules;p.settings.connections[0].clientId=originalClientId;await p.saveSettings(false);const restored=await persisted();app.setting.openTabById('appearance');app.setting.openTabById('${PLUGIN_ID}');await wait(200);return JSON.stringify({blankClientSaved,addModal:Boolean(addModal),addSaved,toggleSaved,moveSaved,editSaved,deleteSaved,mutatedOrder,expectedMutatedOrder:[originalIds[1],originalIds[0],...originalIds.slice(2)],restoredRules:JSON.stringify(restored.rules)===JSON.stringify(originalRules),restoredClientId:restored.connections[0].clientId===originalClientId});})()`,
      ]),
    );
    report.checks.rules = {
      status:
        ruleUi.cards === ruleStructure.configuredRules &&
        ruleStructure.hasMqttTopicQosRetain &&
        ruleStructure.hasHostOrSubdomain &&
        ruleStructure.hasHttpUrl &&
        ruleStructure.hasAttachmentCombination &&
        ruleStructure.hasAfterHeading &&
        ruleStructure.fallbackLast &&
        ruleUi.addButton &&
        ruleUi.toggle &&
        ruleUi.moveDown &&
        ruleUi.edit &&
        ruleUi.deleteButton &&
        ruleUi.aligned &&
        ruleUi.rulesHeadingOwnWrapper &&
        ruleUi.rulesHeadingTransparent &&
        ruleUi.modal &&
        ruleUi.conditionCount >= 1 &&
        ruleUi.saveButton &&
        ruleMutations.blankClientSaved &&
        ruleMutations.addModal &&
        ruleMutations.addSaved &&
        ruleMutations.toggleSaved &&
        ruleMutations.moveSaved &&
        ruleMutations.editSaved &&
        ruleMutations.deleteSaved &&
        JSON.stringify(ruleMutations.mutatedOrder) ===
          JSON.stringify(ruleMutations.expectedMutatedOrder) &&
        ruleMutations.restoredRules &&
        ruleMutations.restoredClientId
          ? "passed"
          : "failed",
      ...ruleUi,
      ...ruleStructure,
      mutations: ruleMutations,
    };

    const tlsUi = parseEvalJson(
      await runObsidianCli(vaultName, [
        "eval",
        `code=(async()=>{const settingsTextareas=document.querySelectorAll('.mqtt-sync-settings textarea').length;const initialConfigure=document.querySelector('[data-testid="MQTT-tls-configure"]');const initialEnabled=Boolean(initialConfigure&&!initialConfigure.disabled);const insecureToggle=document.querySelector('[data-testid="MQTT-allow-insecure-remote-setting"] .checkbox-container');insecureToggle?.click();await new Promise(r=>window.setTimeout(r,200));const disabledConfigure=document.querySelector('[data-testid="MQTT-tls-configure"]');const disabledWhenInsecure=Boolean(disabledConfigure?.disabled);const modalBlockedBefore=document.querySelectorAll('[data-testid="MQTT-tls-modal"]').length;disabledConfigure?.click();await new Promise(r=>window.setTimeout(r,100));const modalBlocked=document.querySelectorAll('[data-testid="MQTT-tls-modal"]').length===modalBlockedBefore;document.querySelector('[data-testid="MQTT-allow-insecure-remote-setting"] .checkbox-container')?.click();await new Promise(r=>window.setTimeout(r,200));const configure=document.querySelector('[data-testid="MQTT-tls-configure"]');return JSON.stringify({configureButton:Boolean(configure),initialEnabled,insecureToggle:Boolean(insecureToggle),disabledWhenInsecure,modalBlocked,reenabled:Boolean(configure&&!configure.disabled),settingsTextareas});})()`,
      ]),
    );
    report.checks.tlsDialog = {
      status:
        tlsUi.configureButton &&
        tlsUi.initialEnabled &&
        tlsUi.insecureToggle &&
        tlsUi.disabledWhenInsecure &&
        tlsUi.modalBlocked &&
        tlsUi.reenabled &&
        tlsUi.settingsTextareas === 0 &&
        report.checks.tlsCaLayout.status === "passed"
          ? "passed"
          : "failed",
      ...tlsUi,
      layout: tlsLayout,
    };

    const language = parseEvalJson(
      await runObsidianCli(vaultName, [
        "eval",
        `code=(async()=>{const select=document.querySelector('[data-testid="MQTT-ui-language"]');const slashSeparated=[...document.querySelectorAll('.setting-item-name')].filter(el=>el.textContent?.includes(' / ')).length;const optionLabels=name=>{const nameEl=[...document.querySelectorAll('.setting-item-name')].find(el=>el.textContent?.trim()===name);const row=nameEl?.closest('.setting-item');return [...(row?.querySelectorAll('select:not([aria-hidden="true"]) option')??[])].map(el=>el.textContent?.trim())};if(!select)return JSON.stringify({found:false,slashSeparated});const initial=select.value;select.value='en';select.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(r=>window.setTimeout(r,250));const en={locale:app.plugins.plugins["${PLUGIN_ID}"]?.i18n?.locale??null,label:[...document.querySelectorAll('.setting-item-name')].some(el=>el.textContent?.trim()==='Language'),apply:document.querySelector('[data-testid="MQTT-apply"]')?.textContent?.trim()==='Apply',test:document.querySelector('[data-testid="MQTT-test-connection"]')?.textContent?.trim()==='Test connection',qos:optionLabels('Requested QoS'),resultQos:optionLabels('Result QoS')};const zhSelect=document.querySelector('[data-testid="MQTT-ui-language"]');if(zhSelect){zhSelect.value='zh-CN';zhSelect.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(r=>window.setTimeout(r,250));}const zh={locale:app.plugins.plugins["${PLUGIN_ID}"]?.i18n?.locale??null,label:[...document.querySelectorAll('.setting-item-name')].some(el=>el.textContent?.trim()==='插件语言'),apply:document.querySelector('[data-testid="MQTT-apply"]')?.textContent?.trim()==='应用',test:document.querySelector('[data-testid="MQTT-test-connection"]')?.textContent?.trim()==='测试连接',qos:optionLabels('请求的 QoS'),resultQos:optionLabels('结果 QoS')};const restore=document.querySelector('[data-testid="MQTT-ui-language"]');if(restore){restore.value=initial;restore.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(r=>window.setTimeout(r,250));}return JSON.stringify({found:true,slashSeparated,en,zh,restored:document.querySelector('[data-testid="MQTT-ui-language"]')?.value===initial});})()`,
      ]),
    );
    report.checks.language = {
      status:
        language.found &&
        language.slashSeparated === 0 &&
        language.en?.locale === "en" &&
        language.en?.label &&
        language.en?.apply &&
        language.en?.test &&
        JSON.stringify(language.en?.qos) ===
          JSON.stringify([
            "QoS 0 — At most once",
            "QoS 1 — At least once",
            "QoS 2 — Exactly once",
          ]) &&
        JSON.stringify(language.en?.resultQos) ===
          JSON.stringify([
            "QoS 0 — At most once",
            "QoS 1 — At least once",
            "QoS 2 — Exactly once",
          ]) &&
        language.zh?.locale === "zh-CN" &&
        language.zh?.label &&
        language.zh?.apply &&
        language.zh?.test &&
        JSON.stringify(language.zh?.qos) ===
          JSON.stringify(["QoS 0 — 至多一次", "QoS 1 — 至少一次", "QoS 2 — 恰好一次"]) &&
        JSON.stringify(language.zh?.resultQos) ===
          JSON.stringify(["QoS 0 — 至多一次", "QoS 1 — 至少一次", "QoS 2 — 恰好一次"]) &&
        language.restored
          ? "passed"
          : "failed",
      ...language,
    };

    const interaction = parseEvalJson(
      await runObsidianCli(vaultName, [
        "eval",
        `code=(async()=>{const row=[...document.querySelectorAll(".setting-item")].find(r=>r.querySelector(".setting-item-name")?.textContent?.includes("Client ID"));const input=row?.querySelector("input");if(!input)return JSON.stringify({found:false});input.value="mqtt-sync-ui-device-b";input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}));await new Promise(r=>window.setTimeout(r,200));return JSON.stringify({found:true,persisted:app.plugins.plugins["${PLUGIN_ID}"]?.settings?.connections?.[0]?.clientId==="mqtt-sync-ui-device-b"});})()`,
      ]),
    );
    await openFreshSettingsTab(vaultName);
    await runObsidianCli(vaultName, ["plugin:reload", `id=${PLUGIN_ID}`]);
    await openFreshSettingsTab(vaultName);
    const persistence = parseEvalJson(
      await runObsidianCli(vaultName, [
        "eval",
        `code=JSON.stringify({persisted:app.plugins.plugins["${PLUGIN_ID}"]?.settings?.connections?.[0]?.clientId==="mqtt-sync-ui-device-b",settingsOpen:app.setting?.activeTab?.id==="${PLUGIN_ID}"})`,
      ]),
    );
    report.checks.persistence = {
      status:
        interaction.found && interaction.persisted && persistence.persisted ? "passed" : "failed",
      controlFound: interaction.found,
      savedBeforeReload: interaction.persisted,
      savedAfterReload: persistence.persisted,
      reopenedById: persistence.settingsOpen,
    };

    let viewportBlocked = false;
    for (const [width, height] of VIEWPORTS) {
      const actual = viewportBlocked
        ? await readViewport(vaultName)
        : await establishViewport(vaultName, width, height);
      if (!actual.exact) {
        viewportBlocked = true;
        report.screenshots.push({
          viewport: `${width}x${height}`,
          status: "blocked",
          reason: "Obsidian host did not apply the requested viewport",
        });
        continue;
      }
      if (actual.width < 1000 || actual.height < 560) {
        viewportBlocked = true;
        report.screenshots.push({
          viewport: `${width}x${height}`,
          status: "blocked",
          reason: "Established content viewport is below the desktop minimum",
        });
        continue;
      }
      await waitForStableLayout(vaultName, width, height);
      const screenshot = join(directory, `settings-${width}x${height}.png`);
      await rm(screenshot, { force: true });
      const beforeCapture = await establishViewport(vaultName, width, height);
      if (!beforeCapture.exact) {
        viewportBlocked = true;
        report.screenshots.push({
          viewport: `${width}x${height}`,
          status: "blocked",
          reason: "Obsidian host released the requested viewport before capture",
        });
        continue;
      }
      await runObsidianCli(vaultName, ["dev:screenshot", `path=${screenshot}`]);
      const dimensions = await readPngDimensions(screenshot);
      if (dimensions.width !== width || dimensions.height !== height) {
        throw new Error(
          `Screenshot dimensions differ from the established viewport ${width}x${height}`,
        );
      }
      report.screenshots.push({
        viewport: `${width}x${height}`,
        captured: `${dimensions.width}x${dimensions.height}`,
        status: "passed",
        bytes: dimensions.bytes,
        artifact: join(relativeDirectory, `settings-${width}x${height}.png`),
      });
    }
    report.checks.viewportMatrix = {
      status: viewportBlocked ? "blocked" : "passed",
      requested: VIEWPORTS.map(([width, height]) => `${width}x${height}`),
    };
    if (viewportBlocked) {
      const observed = await readViewport(vaultName);
      await waitForStableLayout(vaultName, observed.width, observed.height);
      const screenshot = join(directory, "settings-observed-viewport.png");
      await rm(screenshot, { force: true });
      await delay(300);
      await runObsidianCli(vaultName, ["dev:screenshot", `path=${screenshot}`]);
      const dimensions = await readPngDimensions(screenshot);
      report.screenshots.push({
        viewport: "native-cli-default",
        captured: `${dimensions.width}x${dimensions.height}`,
        status: dimensions.width >= 1000 && dimensions.height >= 560 ? "passed" : "failed",
        bytes: dimensions.bytes,
        artifact: join(relativeDirectory, "settings-observed-viewport.png"),
      });
    }

    const finalErrors = await runObsidianCli(vaultName, ["dev:errors"]);
    const finalConsole = await runObsidianCli(vaultName, ["dev:console", "level=error"]);
    report.errorDelta.finalPresent =
      hasCapturedErrors(finalErrors) || hasCapturedErrors(finalConsole);
    report.errorDelta.pluginAttributed = report.errorDelta.finalPresent;
    report.checks.errorDelta = {
      status: !report.errorDelta.finalPresent ? "passed" : "failed",
      freshBaseline: true,
    };
    report.status = Object.values(report.checks).some((check) => check.status === "failed")
      ? "failed"
      : Object.values(report.checks).some((check) => check.status === "blocked")
        ? "incomplete"
        : "passed";
  } catch (error) {
    report.failure = error instanceof Error ? error.message : "Unknown UI acceptance failure";
  } finally {
    if (originalViewport) {
      try {
        const current = await readViewport(vaultName);
        const restored =
          current.outerWidth === originalViewport.outerWidth &&
          current.outerHeight === originalViewport.outerHeight &&
          current.screenX === originalViewport.screenX &&
          current.screenY === originalViewport.screenY
            ? current
            : await establishViewport(
                vaultName,
                originalViewport.outerWidth,
                originalViewport.outerHeight,
                originalViewport.screenX,
                originalViewport.screenY,
              );
        report.cleanup.viewportRestored =
          restored.outerWidth === originalViewport.outerWidth &&
          restored.outerHeight === originalViewport.outerHeight &&
          restored.screenX === originalViewport.screenX &&
          restored.screenY === originalViewport.screenY;
        if (!report.cleanup.viewportRestored)
          cleanupErrors.push("viewport:restoration did not verify");
      } catch (error) {
        cleanupErrors.push(`viewport:${safeError(error)}`);
      }
    }
    if (snapshot) {
      try {
        await bestEffortCli(vaultName, ["plugin:disable", `id=${PLUGIN_ID}`]);
        await restorePluginSettings(snapshot);
        report.cleanup.settingsRestored = snapshot.existed
          ? (await readFile(snapshot.data)).equals(snapshot.originalBytes)
          : !(await exists(snapshot.data));
        if (!report.cleanup.settingsRestored)
          cleanupErrors.push("settings:restoration did not verify");
        if (originalEnabled) {
          await runObsidianCli(vaultName, ["plugin:enable", `id=${PLUGIN_ID}`]);
          await runObsidianCli(vaultName, ["plugin:reload", `id=${PLUGIN_ID}`]);
        }
        const restoredEnabledOutput = await runObsidianCli(vaultName, [
          "plugins:enabled",
          "filter=community",
          "format=json",
        ]);
        const restoredEnabled = restoredEnabledOutput.includes(`"${PLUGIN_ID}"`);
        report.cleanup.pluginStateRestored = restoredEnabled === originalEnabled;
        if (!report.cleanup.pluginStateRestored)
          cleanupErrors.push("plugin-state:restoration did not verify");
      } catch (error) {
        cleanupErrors.push(`settings:${safeError(error)}`);
      }
    }
    if (originalTabId) {
      await bestEffortCli(vaultName, [
        "eval",
        `code=(()=>{app.setting.open();app.setting.openTabById(${JSON.stringify(originalTabId)});return true})()`,
      ]);
    }
    try {
      await runObsidianCli(vaultName, ["dev:debug", "off"]);
      report.cleanup.debugDetached = true;
    } catch (error) {
      cleanupErrors.push(`debug:${safeError(error)}`);
    }
    if (cleanupErrors.length) {
      report.status = "failed";
      report.cleanup.errors = cleanupErrors;
    }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

async function openFreshSettingsTab(vaultName) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const state = parseEvalJson(
      await runObsidianCli(vaultName, [
        "eval",
        `code=(()=>{app.setting.open();app.setting.openTabById("appearance");app.setting.openTabById("${PLUGIN_ID}");return JSON.stringify({open:app.setting?.activeTab?.id==="${PLUGIN_ID}"})})()`,
      ]),
    );
    await delay(200);
    if (state.open) return;
  }
  throw new Error("Obsidian did not activate the MQTT Sync settings tab by plugin ID");
}

async function readViewport(vaultName) {
  return parseEvalJson(
    await runObsidianCli(vaultName, [
      "eval",
      "code=JSON.stringify({width:window.innerWidth,height:window.innerHeight,outerWidth:window.outerWidth,outerHeight:window.outerHeight,screenX:window.screenX,screenY:window.screenY,exact:false})",
    ]),
  );
}

async function establishViewport(vaultName, outerWidth, outerHeight, screenX, screenY) {
  // macOS can re-apply host constraints shortly after a resize. Verify in the same
  // renderer turn, and re-establish immediately before the native CLI screenshot.
  return parseEvalJson(
    await runObsidianCli(vaultName, [
      "eval",
      `code=JSON.stringify((()=>{const targetX=${screenX === undefined ? "screen.availLeft" : JSON.stringify(screenX)};const targetY=${screenY === undefined ? "screen.availTop" : JSON.stringify(screenY)};window.moveTo(targetX,targetY);window.resizeBy(${outerWidth}-window.outerWidth,${outerHeight}-window.outerHeight);return{width:window.innerWidth,height:window.innerHeight,outerWidth:window.outerWidth,outerHeight:window.outerHeight,screenX:window.screenX,screenY:window.screenY,exact:window.outerWidth===${outerWidth}&&window.outerHeight===${outerHeight}&&window.screenX===targetX&&window.screenY===targetY};})())`,
    ]),
  );
}

async function waitForStableLayout(vaultName, width, height) {
  let previous;
  let stable = 0;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = parseEvalJson(
      await runObsidianCli(vaultName, [
        "eval",
        `code=JSON.stringify((()=>{window.resizeBy(${width}-window.outerWidth,${height}-window.outerHeight);const root=document.querySelector(".mqtt-sync-settings")?.closest(".vertical-tab-content")??document.querySelector(".vertical-tab-content");return{ready:document.fonts.status==="loaded"&&Boolean(root),width:window.outerWidth,height:window.outerHeight,scrollWidth:root?.scrollWidth??0,scrollHeight:root?.scrollHeight??0,rows:root?.querySelectorAll(".setting-item").length??0,tab:app.setting?.activeTab?.id??null};})())`,
      ]),
    );
    const key = JSON.stringify(state);
    if (
      state.ready &&
      state.width === width &&
      state.height === height &&
      state.tab === PLUGIN_ID &&
      key === previous
    ) {
      stable += 1;
      if (stable >= 3) return;
    } else stable = 0;
    previous = key;
    await delay(100);
  }
  throw new Error("Timed out waiting for stable MQTT Sync settings layout");
}

export function syntheticSettings(caPem) {
  return {
    schemaVersion: 1,
    uiLanguage: "en",
    enabled: false,
    device: { deviceId: "ui-device", writerDeviceId: "ui-device" },
    connections: [
      {
        id: "ui-loopback",
        name: "UI loopback",
        brokerUrl: "mqtt://127.0.0.1:18883",
        protocolVersion: 5,
        clientId: "mqtt-sync-ui-device-a",
        auth: {},
        tls: caPem ? { caPem } : {},
        allowInsecureRemote: false,
        keepAliveSeconds: 60,
        connectTimeoutMs: 30000,
        cleanStart: true,
        sessionExpirySeconds: 0,
        subscriptions: [
          {
            filter: `mqtt-sync/ui/${randomUUID()}/#`,
            qos: 1,
            noLocal: true,
            retainAsPublished: true,
            retainHandling: 2,
            enabled: true,
          },
        ],
        reconnect: { minMs: 1000, maxMs: 60000, jitterRatio: 1 },
        useCorrelationDataAsId: false,
        result: {
          topic: "mqtt-sync/ui/results",
          qos: 1,
          retain: false,
          privacy: "minimal",
        },
      },
    ],
    rules: {
      schemaVersion: 1,
      matchMode: "first",
      rules: [
        {
          id: "ui-mqtt-alerts",
          revision: 1,
          name: "UI alerts",
          enabled: true,
          when: {
            all: [
              { field: "topic", op: "matchesFilter", value: "mqtt-sync/ui/+/alert" },
              { field: "qos", op: "gte", value: 1 },
              { field: "retain", op: "equals", value: false },
            ],
          },
          action: {
            notePathTemplate: "MQTT Sync/UI Alerts.md",
            contentTemplateId: "inbox",
            insertion: "prepend",
          },
        },
        {
          id: "ui-alpha-log",
          revision: 1,
          name: "UI alpha host log",
          enabled: true,
          when: {
            all: [
              {
                field: "firstUrlHost",
                op: "hostOrSubdomainOf",
                value: "alpha.example",
              },
            ],
          },
          action: {
            notePathTemplate: "MQTT Sync/UI Alpha Log.md",
            contentTemplateId: "inbox",
            insertion: "after-heading",
            heading: "### Log",
          },
        },
        {
          id: "ui-beta-log",
          revision: 1,
          name: "UI beta host log",
          enabled: true,
          when: {
            all: [
              {
                field: "firstUrlHost",
                op: "hostOrSubdomainOf",
                value: "beta.example",
              },
            ],
          },
          action: {
            notePathTemplate: "MQTT Sync/UI Beta Log.md",
            contentTemplateId: "inbox",
            insertion: "after-heading",
            heading: "### Log",
          },
        },
        {
          id: "ui-archive-host",
          revision: 1,
          name: "UI archive host",
          enabled: true,
          when: {
            all: [
              {
                field: "firstUrlHost",
                op: "hostOrSubdomainOf",
                value: "archive.example",
              },
            ],
          },
          action: {
            notePathTemplate: "MQTT Sync/UI Archive.md",
            contentTemplateId: "inbox",
            insertion: "append",
          },
        },
        {
          id: "ui-web-links",
          revision: 1,
          name: "UI web links",
          enabled: true,
          when: { all: [{ field: "hasHttpUrl", op: "equals", value: true }] },
          action: {
            notePathTemplate: "MQTT Sync/UI Web Links.md",
            contentTemplateId: "inbox",
            insertion: "after-heading",
            heading: "### Links",
          },
        },
        {
          id: "ui-priority-images",
          revision: 1,
          name: "UI priority images",
          enabled: true,
          when: {
            all: [
              { field: "firstUrlHost", op: "hostEquals", value: "files.example" },
              { field: "priority", op: "gte", value: 4 },
              { field: "hasAttachment", op: "equals", value: true },
              { field: "attachmentMime", op: "startsWith", value: "image/" },
            ],
          },
          action: {
            notePathTemplate: "MQTT Sync/UI Priority Images.md",
            contentTemplateId: "inbox",
            insertion: "append",
          },
        },
        {
          id: "ui-fallback",
          revision: 1,
          name: "UI fallback",
          enabled: true,
          when: { all: [] },
          action: {
            notePathTemplate: "MQTT Sync/UI Inbox.md",
            contentTemplateId: "inbox",
            insertion: "append",
          },
        },
      ],
    },
    templates: { schemaVersion: 1, entries: { inbox: "{{payload}}" } },
    processing: {
      dedupeWindowSeconds: 600,
      maxPayloadBytes: 262144,
      maxAttachmentBytes: 15728640,
      attachmentTimeoutMs: 30000,
      allowedAttachmentOrigins: [],
      maxAttempts: 8,
      concurrency: 2,
      completedRetentionDays: 7,
      completedRetentionCount: 10000,
      downloadEnvelopeAttachments: false,
    },
    diagnostics: { logLevel: "info", redactBodies: true },
  };
}

async function bestEffortCli(vaultName, args, options = {}) {
  try {
    return await runObsidianCli(vaultName, args, { ...options, rejectOutputErrors: false });
  } catch {
    return "";
  }
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
  return error instanceof Error ? error.message : "unknown cleanup error";
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const report = await runUiAcceptance();
  if (report.status !== "passed") process.exitCode = 1;
}
