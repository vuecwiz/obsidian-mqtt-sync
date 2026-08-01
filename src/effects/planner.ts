import type {
  EffectPlanV1,
  IncomingMessage,
  ProcessingConfigV1,
  RuleV1,
  TemplateCatalogV1,
} from "../domain/types";
import { sha256Hex } from "../shared/crypto";
import { SyncError } from "../shared/errors";
import { renderTemplate } from "../templates/engine";
import { normalizeVaultPath } from "./paths";

export function planEffect(
  message: IncomingMessage,
  rule: RuleV1,
  templates: TemplateCatalogV1,
  processing: ProcessingConfigV1,
): EffectPlanV1 {
  const template = templates.entries[rule.action.contentTemplateId];
  if (template === undefined) {
    throw new SyncError("TEMPLATE_INVALID", "Configured content template is missing", false);
  }
  const notePath = normalizeVaultPath(
    renderTemplate(rule.action.notePathTemplate, { message }, true),
    { requireMarkdown: true },
  );
  const marker = `<!-- mqtt-sync:v1 key=${sha256Hex(message.key)} rule=${rule.id}@${rule.revision} -->`;
  const attachment = message.attachment ? planAttachment(message, rule, processing) : undefined;
  const file = attachment?.targetPath
    ? {
        path: attachment.targetPath,
        link: `[[${attachment.targetPath}]]`,
        embed: `![[${attachment.targetPath}]]`,
      }
    : undefined;
  const renderedContent = renderTemplate(template, { message, file });
  const fallbackLink =
    message.attachment && attachment?.mode === "link-only"
      ? `\n\n${markdownAttachmentLink(message.attachment.name, message.attachment.url)}`
      : "";
  return {
    schemaVersion: 1,
    sourceKey: message.key,
    ruleId: rule.id,
    ruleRevision: rule.revision,
    notePath,
    marker,
    renderedBlock: `${marker}\n${renderedContent}${fallbackLink}`.trimEnd(),
    insertion: { mode: rule.action.insertion, heading: rule.action.heading },
    attachment,
  };
}

function planAttachment(
  message: IncomingMessage,
  rule: RuleV1,
  processing: ProcessingConfigV1,
): EffectPlanV1["attachment"] {
  const attachment = message.attachment;
  if (!attachment) return undefined;
  if (attachment.size !== undefined && attachment.size > processing.maxAttachmentBytes) {
    throw new SyncError("ATTACHMENT_TOO_LARGE", "Attachment exceeds configured limit", false);
  }
  let source: URL;
  try {
    source = new URL(attachment.url);
  } catch {
    throw new SyncError("ATTACHMENT_POLICY", "Attachment URL is invalid", false);
  }
  if (source.protocol !== "http:" && source.protocol !== "https:") {
    throw new SyncError("ATTACHMENT_POLICY", "Attachment URL scheme is not allowed", false);
  }
  const allowed = processing.allowedAttachmentOrigins.includes(source.origin);
  if (!allowed || !processing.downloadEnvelopeAttachments) {
    return {
      mode: "link-only",
      sourceUrl: attachment.url,
      expectedMaxBytes: processing.maxAttachmentBytes,
    };
  }
  if (!rule.action.attachmentPathTemplate) {
    return {
      mode: "link-only",
      sourceUrl: attachment.url,
      expectedMaxBytes: processing.maxAttachmentBytes,
    };
  }
  const targetPath = normalizeVaultPath(
    renderTemplate(rule.action.attachmentPathTemplate, { message }, true),
  );
  return {
    mode: "download",
    sourceUrl: attachment.url,
    targetPath,
    expectedMaxBytes: processing.maxAttachmentBytes,
    expectedSha256: attachment.sha256,
  };
}

function markdownAttachmentLink(name: string, rawUrl: string): string {
  const label = `Attachment: ${name}`.replace(/([\\[\]])/g, "\\$1");
  const destination = rawUrl.replace(/[()\\\s]/g, (character) =>
    character === "(" ? "%28" : character === ")" ? "%29" : encodeURIComponent(character),
  );
  return `[${label}](${destination})`;
}
