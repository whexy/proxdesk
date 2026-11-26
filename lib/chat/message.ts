// A platform-neutral message. Commands build these; each adapter renders them
// in its own markup, so command code never contains Slack or Discord syntax.

export type Icon = "ok" | "error" | "warning" | "wait" | "wave" | "link";
export type Inline =
  | string
  | { bold: string }
  | { code: string }
  /** The person the bot is answering. */
  | { requester: true }
  /** A conversation (channel) on the same platform, by its platform ID. */
  | { conversation: string }
  | { icon: Icon }
  | { link: string; label?: string };
export type Block = { paragraph: Inline[] } | { list: Inline[][] };
export type ChatMessage = { blocks: Block[] };

export const bold = (text: string): Inline => ({ bold: text });
export const code = (text: string): Inline => ({ code: text });
export const icon = (name: Icon): Inline => ({ icon: name });
export const requester: Inline = { requester: true };
export const conversation = (id: string): Inline => ({ conversation: id });
export const link = (url: string, label?: string): Inline => ({ link: url, label });
export const paragraph = (...inlines: Inline[]): Block => ({ paragraph: inlines });
export const list = (...items: Inline[][]): Block => ({ list: items });
export const message = (...blocks: Block[]): ChatMessage => ({ blocks });
/** A one-paragraph message. */
export const text = (...inlines: Inline[]): ChatMessage =>
  message(paragraph(...inlines));

/** Joins inline runs with a separator, as Array.join does for strings. */
export function join(parts: Inline[][], separator: Inline = ", "): Inline[] {
  return parts.flatMap((part, i) => (i ? [separator, ...part] : part));
}

// Icons render as nothing in plain text, which would leave doubled spaces.
const squeeze = (value: string) =>
  value
    .split("\n")
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .join("\n");
/** Plain text without markup, for logs and tests. */
export function plain(message: ChatMessage, requesterName = "@you") {
  const inline = (part: Inline): string =>
    typeof part === "string"
      ? part
      : "bold" in part
        ? part.bold
        : "code" in part
          ? part.code
          : "requester" in part
            ? requesterName
            : "conversation" in part
              ? `#${part.conversation}`
              : "icon" in part
                ? ""
                : part.label
                  ? `${part.label} (${part.link})`
                  : part.link;
  return message.blocks
    .map((block) =>
      "paragraph" in block
        ? squeeze(block.paragraph.map(inline).join(""))
        : block.list.map((item) => `- ${squeeze(item.map(inline).join(""))}`).join("\n"),
    )
    .join("\n");
}

/**
 * Renders a message for one platform. An adapter supplies how each inline
 * element and block looks; Discord markdown differs from Slack mrkdwn mostly
 * in escaping, mentions, and emoji names.
 */
export type Markup = {
  text(value: string): string;
  bold(value: string): string;
  code(value: string): string;
  requester(userRef: string): string;
  conversation(id: string): string;
  icon(name: Icon): string;
  link(url: string, label?: string): string;
  listItem(rendered: string): string;
};
export function render(message: ChatMessage, markup: Markup, userRef: string) {
  const inline = (part: Inline): string =>
    typeof part === "string"
      ? markup.text(part)
      : "bold" in part
        ? markup.bold(part.bold)
        : "code" in part
          ? markup.code(part.code)
          : "requester" in part
            ? markup.requester(userRef)
            : "conversation" in part
              ? markup.conversation(part.conversation)
              : "icon" in part
                ? markup.icon(part.icon)
                : markup.link(part.link, part.label);
  return message.blocks
    .map((block) =>
      "paragraph" in block
        ? block.paragraph.map(inline).join("")
        : block.list
            .map((item) => markup.listItem(item.map(inline).join("")))
            .join("\n"),
    )
    .join("\n");
}

// Slack mrkdwn treats only &, <, and > as control characters in plain text.
const slackEscape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const slackIcons: Record<Icon, string> = {
  ok: ":white_check_mark:",
  error: ":x:",
  warning: ":warning:",
  wait: ":hourglass_flowing_sand:",
  wave: ":wave:",
  link: ":link:",
};
export const slackMarkup: Markup = {
  text: slackEscape,
  bold: (value) => `*${slackEscape(value)}*`,
  code: (value) => `\`${slackEscape(value)}\``,
  requester: (userRef) => `<@${userRef}>`,
  conversation: (id) => `<#${id}>`,
  icon: (name) => slackIcons[name],
  link: (url, label) => (label ? `<${url}|${slackEscape(label)}>` : `<${url}>`),
  listItem: (rendered) => `• ${rendered}`,
};

/** The conversation Discord direct messages arrive in; Discord's own name for them. */
export const discordDirect = "@me";
// Inline markers are escaped everywhere, block markers (headings, quotes,
// lists) only where a line starts. "@" gets a zero-width space so @everyone
// and @here never read as mentions, even where allowed_mentions would not ping.
const discordEscape = (value: string) =>
  value
    .replace(/[\\*_~`|[\]<]/g, "\\$&")
    .replace(/^(\s*)([#>+-])/gm, "$1\\$2")
    .replace(/^(\s*\d+)\./gm, "$1\\.")
    .replace(/@/g, "@\u200b");
const discordIcons: Record<Icon, string> = {
  ok: "✅",
  error: "❌",
  warning: "⚠️",
  wait: "⏳",
  wave: "👋",
  link: "🔗",
};
export const discordMarkup: Markup = {
  text: discordEscape,
  bold: (value) => `**${discordEscape(value)}**`,
  // Backslashes are literal inside code spans, so a backtick cannot be
  // escaped there; a look-alike keeps the span closed where it should be.
  code: (value) => `\`${value.replace(/`/g, "ˋ") || " "}\``,
  requester: (userRef) => `<@${userRef}>`,
  conversation: (id) => (id === discordDirect ? "direct messages" : `<#${id}>`),
  icon: (name) => discordIcons[name],
  // Angle brackets suppress the link preview.
  link: (url, label) =>
    label ? `[${discordEscape(label)}](<${url}>)` : `<${url}>`,
  listItem: (rendered) => `- ${rendered}`,
};
