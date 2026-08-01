import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const runId =
  process.env.MQTT_UI_SAMPLE_ID ??
  `obsidian-1.13.4-same-window-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;
const outputRoot = resolve(process.env.MQTT_UI_SAMPLE_OUTPUT ?? join(".artifacts", "ui-samples"));
const groups = [
  {
    id: "zh-cn-obsidian-zh-cn-plugin",
    hostLanguage: "zh",
    pluginLanguage: "zh-CN",
    title: "简体中文 Obsidian + 简体中文插件",
  },
  {
    id: "en-obsidian-en-plugin",
    hostLanguage: "en",
    pluginLanguage: "en",
    title: "English Obsidian + English plugin",
  },
];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
const results = [];
for (const group of groups) {
  const groupOutput = join(outputRoot, group.id, runId);
  const child = spawnSync(process.execPath, ["scripts/ui-resolution-samples.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      MQTT_UI_SAMPLE_ID: runId,
      MQTT_UI_SAMPLE_OUTPUT: groupOutput,
      MQTT_UI_SAMPLE_HOST_LANGUAGE: group.hostLanguage,
      MQTT_UI_SAMPLE_PLUGIN_LANGUAGE: group.pluginLanguage,
    },
    timeout: 10 * 60_000,
  });
  if (child.status !== 0) {
    const detail = child.stderr.trim().split("\n").at(-1) ?? "unknown child failure";
    throw new Error(`${group.id} UI sample capture failed: ${detail}`);
  }
  const report = JSON.parse(await readFile(join(groupOutput, "matrix.json"), "utf8"));
  if (
    !report.passed ||
    !report.hostLanguage.toLocaleLowerCase().startsWith(group.hostLanguage) ||
    report.pluginLanguage !== group.pluginLanguage
  )
    throw new Error(`${group.id} language or pass evidence does not match`);
  results.push({
    ...group,
    path: `${group.id}/${runId}`,
    resolutions: report.resolutions.length,
    screenshots: report.resolutions.reduce(
      (count, resolution) => count + resolution.screenshots.length,
      0,
    ),
    cleanup: report.cleanup,
    passed: true,
  });
}

const matrix = {
  schema: "obsidian.mqtt-sync.ui-language-resolution-matrix.v1",
  runId,
  generatedAt: new Date().toISOString(),
  groups: results,
  passed: results.every((result) => result.passed),
};
await writeFile(join(outputRoot, "matrix.json"), `${JSON.stringify(matrix, null, 2)}\n`);
await writeFile(join(outputRoot, "README.md"), indexMarkdown(matrix), "utf8");
process.stdout.write(`${JSON.stringify({ passed: matrix.passed, outputRoot, runId })}\n`);

function indexMarkdown(report) {
  const lines = [
    "# MQTT Sync 双语多分辨率 UI 测试样例",
    "",
    `生成时间：${report.generatedAt}`,
    "",
    "| 语言组合 | 分辨率 | 截图数 | 自动化与人工复验 |",
    "| --- | ---: | ---: | --- |",
  ];
  for (const group of report.groups) {
    lines.push(
      `| ${group.title} | ${group.resolutions} | ${group.screenshots} | [打开](./${group.path}/README.md) |`,
    );
  }
  lines.push(
    "",
    "每组覆盖 1280×720、1440×900、1920×1080、2560×1440，并包含设置概览、已配置凭据、TLS 证书弹窗、订阅、结果发布、限制与附件、规则列表和规则编辑器。截图保留完整设置窗口与核心导航；所有配置均为合成测试数据，敏感输入以掩码显示，无关第三方插件名称已匿名化。",
    "",
  );
  return lines.join("\n");
}
