import { addIcon } from "obsidian";

const bubble = `<path d="M5 4.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-9l-5 3v-3.2a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z"/>`;

function icon(glyph: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g transform="translate(0 -10) scale(4.1666667 5)" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${bubble}${glyph}</g></svg>`;
}

const icons: Record<string, string> = {
  "MQTT-status-idle": icon(`<path d="m7.5 9 2 2-2 2M12 13h3.5"/>`),
  "MQTT-status-off": icon(`<path d="M7 7l10 7M5 3l14 18"/>`),
  "MQTT-status-monitor": icon(
    `<path d="M7 11s1.8-3 5-3 5 3 5 3-1.8 3-5 3-5-3-5-3Z"/><circle cx="12" cy="11" r="1.2"/>`,
  ),
  "MQTT-status-connecting": icon(
    `<circle cx="8" cy="11" r=".7" fill="currentColor" stroke="none"/><circle cx="12" cy="11" r=".7" fill="currentColor" stroke="none"/><circle cx="16" cy="11" r=".7" fill="currentColor" stroke="none"/>`,
  ),
  "MQTT-status-connected": icon(`<path d="m7.5 11 2.7 2.5 6.3-6"/>`),
  "MQTT-status-polling": icon(
    `<path d="M8 10a4 4 0 0 1 6.8-1.8L16 9.5M16 12a4 4 0 0 1-6.8 1.8L8 12.5"/>`,
  ),
  "MQTT-status-backoff": icon(`<circle cx="12" cy="11" r="4"/><path d="M12 8.5V11l1.7 1"/>`),
  "MQTT-status-error": icon(`<path d="M12 7.5v4.2M12 14h.01"/>`),
};

export function registerMQTTStatusIcons(): void {
  for (const [name, svg] of Object.entries(icons)) addIcon(name, svg);
}
