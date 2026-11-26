import WebSocket from "ws";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  AdapterStatus,
  ChatAdapter,
  ChatMember,
  ChatTarget,
  IncomingMessage,
} from "./adapter";
import { render, slackMarkup, type ChatMessage } from "./message";

export type SlackSettings = {
  appToken: string;
  botToken: string;
  /** Channel IDs whose members form the directory. */
  channels: string[];
};
export type SlackCall = (
  token: string,
  method: string,
  params: Record<string, string>,
) => Promise<Record<string, any>>;
export type SlackMention = {
  user?: string;
  bot_id?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
};

export const slackCall: SlackCall = async (token, method, params) => {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await response.json()) as Record<string, any>;
  if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error}`);
  return data;
};

const leadingMention = /^\s*<@[A-Z0-9]+(\|[^>]*)?>/;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Slack through Socket Mode: an outbound WebSocket, so the server needs no public URL. */
export class SlackAdapter implements ChatAdapter {
  readonly id = "slack";
  readonly label = "Slack";
  private state: AdapterStatus["state"] = "disconnected";
  private lastError = "";
  private running = false;
  private socket?: WebSocket;
  private handler?: (message: IncomingMessage) => Promise<void>;
  private seen = new Map<string, number>();
  private members?: { list?: ChatMember[]; error?: Error; expires: number };
  private names = new Map<string, { name: string; handle: string; expires: number }>();
  private bot?: { id: string; name: string };
  constructor(
    private settings: SlackSettings,
    private call: SlackCall = slackCall,
  ) {}
  status(): AdapterStatus {
    return { state: this.state, lastError: this.lastError };
  }
  onMessage(handler: (message: IncomingMessage) => Promise<void>) {
    this.handler = handler;
  }
  start() {
    if (this.running) return;
    this.running = true;
    void this.connectLoop();
  }
  stop() {
    this.running = false;
    this.socket?.close();
  }
  private async connectLoop() {
    let delay = 1000;
    while (this.running) {
      this.state = "connecting";
      try {
        if (await this.connect()) delay = 1000;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        console.error("Slack connection failed:", this.lastError);
      }
      this.state = "disconnected";
      if (!this.running) break;
      await sleep(delay);
      delay = Math.min(delay * 2, 60_000);
    }
  }
  /** Resolves when the socket closes; true if Slack accepted the connection. */
  private async connect() {
    const { url } = await this.call(
      this.settings.appToken,
      "apps.connections.open",
      {},
    );
    const ws = new WebSocket(url);
    this.socket = ws;
    let greeted = false,
      alive = true;
    // A half-open TCP connection would otherwise leave the bot silently deaf.
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30_000);
    ws.on("pong", () => (alive = true));
    ws.on("message", (data) => {
      alive = true;
      let message: Record<string, any>;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.envelope_id)
        ws.send(JSON.stringify({ envelope_id: message.envelope_id }));
      if (message.type === "hello") {
        greeted = true;
        this.state = "connected";
        this.lastError = "";
      } else if (message.type === "disconnect") ws.close();
      else if (
        message.type === "events_api" &&
        this.firstDelivery(message.payload?.event_id)
      ) {
        const event = message.payload?.event;
        if (event?.type === "app_mention") void this.handleMention(event);
      }
    });
    await new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
      ws.on("error", (error) => {
        this.lastError = error.message;
        resolve();
      });
    });
    clearInterval(heartbeat);
    ws.terminate();
    return greeted;
  }
  /** Slack redelivers unacknowledged events; replaying one must not repeat a power action. */
  private firstDelivery(eventId: string | undefined) {
    const now = Date.now();
    for (const [id, expires] of this.seen)
      if (expires < now) this.seen.delete(id);
    if (!eventId) return true;
    if (this.seen.has(eventId)) return false;
    this.seen.set(eventId, now + 10 * 60_000);
    return true;
  }
  async handleMention(event: SlackMention) {
    if (!event.user || event.bot_id || !event.channel || !event.ts) return;
    const thread = event.thread_ts || event.ts;
    try {
      const [sender, bot] = await Promise.all([
        this.sender(event.user),
        this.identity(),
      ]);
      // Only the bot's own mention is removed; any other mention stays in the
      // text, so the command parser rejects it instead of ignoring it.
      const text = bot.id
        ? (event.text || "").replace(
            new RegExp(`<@${escapeRegExp(bot.id)}(\\|[^>]*)?>`, "g"),
            " ",
          )
        : (event.text || "").replace(leadingMention, " ");
      await this.handler?.({
        platform: this.id,
        userRef: event.user,
        userName: sender.name,
        userHandle: sender.handle,
        conversation: event.channel,
        thread,
        text: text.trim(),
        target: { conversation: event.channel, thread, user: event.user },
        botName: bot.name,
      });
    } catch (error) {
      console.error("Slack request failed:", error);
    }
  }
  private text(target: ChatTarget, message: ChatMessage) {
    return render(message, slackMarkup, target.user);
  }
  async reply(target: ChatTarget, message: ChatMessage) {
    await this.call(this.settings.botToken, "chat.postMessage", {
      channel: target.conversation,
      ...(target.thread ? { thread_ts: target.thread } : {}),
      text: this.text(target, message),
    });
  }
  notify(target: ChatTarget, message: ChatMessage) {
    return this.reply(target, message);
  }
  async privateReply(target: ChatTarget, message: ChatMessage) {
    await this.call(this.settings.botToken, "chat.postEphemeral", {
      channel: target.conversation,
      user: target.user,
      ...(target.thread ? { thread_ts: target.thread } : {}),
      text: this.text(target, message),
    });
  }
  /**
   * The bot's user ID and handle. Both are empty while Slack can't say, so
   * the help still goes out; the request is retried on the next mention.
   */
  private async identity() {
    if (!this.bot)
      try {
        const { user, user_id } = await this.call(this.settings.botToken, "auth.test", {});
        this.bot = { id: user_id || "", name: user || "" };
      } catch (error) {
        console.error("Slack auth.test failed:", error);
      }
    return this.bot ?? { id: "", name: "" };
  }
  private async profile(id: string) {
    const { user } = await this.call(this.settings.botToken, "users.info", { user: id });
    return user as Record<string, any>;
  }
  /** Names stored when the sender links their account; the ID stands in when Slack can't say. */
  private async sender(id: string) {
    const cached = this.names.get(id);
    if (cached && cached.expires > Date.now()) return cached;
    try {
      const user = await this.profile(id);
      const entry = {
        name: (user.profile?.real_name || user.real_name || user.name || id) as string,
        handle: (user.name || "") as string,
        expires: Date.now() + 10 * 60_000,
      };
      this.names.set(id, entry);
      return entry;
    } catch (error) {
      console.error("Slack users.info failed:", error);
      return { name: id, handle: "" };
    }
  }
  /**
   * Members of the configured channels. Successful lists are kept for five
   * minutes and failures for 30 seconds, so the members page cannot make the
   * bot exceed Slack's rate limits.
   */
  async directory(): Promise<ChatMember[]> {
    const cached = this.members;
    if (cached && cached.expires > Date.now()) {
      if (cached.error) throw cached.error;
      return cached.list!;
    }
    try {
      const list = await this.listMembers();
      this.members = { list, expires: Date.now() + 5 * 60_000 };
      return list;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.members = { error: failure, expires: Date.now() + 30_000 };
      throw failure;
    }
  }
  private async pages(method: string, params: Record<string, string>, key: string) {
    const items: any[] = [];
    let cursor = "";
    do {
      const page = await this.call(this.settings.botToken, method, {
        ...params,
        limit: "200",
        ...(cursor ? { cursor } : {}),
      });
      items.push(...(page[key] ?? []));
      cursor = page.response_metadata?.next_cursor || "";
    } while (cursor);
    return items;
  }
  private async listMembers() {
    const ids = new Set<string>();
    for (const channel of this.settings.channels)
      for (const id of await this.pages("conversations.members", { channel }, "members"))
        ids.add(id);
    const list: ChatMember[] = [];
    for (const user of await this.pages("users.list", {}, "members")) {
      if (!ids.has(user.id) || user.is_bot || user.deleted || user.id === "USLACKBOT") continue;
      list.push({
        ref: user.id,
        name: user.profile?.real_name || user.real_name || user.name,
        handle: user.profile?.display_name || user.name,
      });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }
}
