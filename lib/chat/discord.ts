import WebSocket from "ws";
import { setTimeout as sleep } from "node:timers/promises";
import type { AdapterStatus, ChatAdapter, ChatTarget, IncomingMessage } from "./adapter";
import {
  discordDirect,
  discordMarkup,
  render,
  icon,
  requester,
  text,
  type ChatMessage,
} from "./message";

export type DiscordSettings = {
  botToken: string;
  /** Channel IDs the bot takes requests in; threads under them count too. */
  channels: string[];
  allowDMs: boolean;
};

export class DiscordError extends Error {
  constructor(
    public status: number,
    /** Discord's JSON error code, such as 50007 for a user who refuses direct messages. */
    public code: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

export type DiscordRest = <T = any>(method: string, path: string, body?: unknown) => Promise<T>;

/**
 * Discord's REST API as the bot. A 429 is retried after the delay Discord
 * names, a bounded number of times, so a rate-limited reply still goes out
 * but a long ban surfaces as an error.
 */
export function discordRest(
  token: string,
  options: { base?: string; fetch?: typeof fetch; retries?: number } = {},
): DiscordRest {
  const base = options.base ?? "https://discord.com/api/v10";
  const request = options.fetch ?? fetch;
  const retries = options.retries ?? 3;
  return async (method, path, body) => {
    for (let attempt = 0; ; attempt++) {
      const response = await request(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bot ${token}`,
          "User-Agent": "DiscordBot (Proxdesk, 1)",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, any>;
      if (response.status === 429) {
        const wait = Number(data.retry_after ?? response.headers.get("retry-after") ?? 1);
        if (attempt < retries && wait <= 60) {
          await sleep(Math.max(wait, 0) * 1000);
          continue;
        }
      }
      if (!response.ok)
        throw new DiscordError(
          response.status,
          typeof data.code === "number" ? data.code : undefined,
          `Discord ${method} ${path} failed: ${data.message ?? `${response.status} ${response.statusText}`}`,
        );
      return data as any;
    }
  };
}

const GUILDS = 1 << 0,
  GUILD_MESSAGES = 1 << 9,
  DIRECT_MESSAGES = 1 << 12;
// MESSAGE_CONTENT is privileged; without it Discord still sends the content
// of messages that mention the bot and of direct messages, which is all the
// bot reads.
export const discordIntents = GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES;

/** Close codes after which reconnecting cannot succeed without a configuration change. */
const fatalCloses: Record<number, string> = {
  4004: "Discord rejected the bot token",
  4010: "Discord rejected the shard",
  4011: "Discord requires sharding for this bot",
  4012: "Discord rejected the gateway version",
  4013: "Discord rejected the gateway intents",
  4014: "Discord refused the gateway intents; Proxdesk needs no privileged intents, so check the application's settings",
};
/** Close codes after which the session cannot be resumed. */
const freshCloses = new Set([4007, 4009]);
const threadTypes = new Set([10, 11, 12]);

export type DiscordMessage = {
  id: string;
  channel_id: string;
  guild_id?: string;
  webhook_id?: string;
  content?: string;
  author?: {
    id: string;
    username?: string;
    discriminator?: string;
    global_name?: string | null;
    bot?: boolean;
  };
};

/**
 * Discord through the Gateway, an outbound WebSocket, and REST. It answers
 * messages that mention the bot in the configured channels, and direct
 * messages when they are allowed.
 */
export class DiscordAdapter implements ChatAdapter {
  readonly id = "discord";
  readonly label = "Discord";
  private state: AdapterStatus["state"] = "disconnected";
  private lastError = "";
  private running = false;
  private socket?: WebSocket;
  private handler?: (message: IncomingMessage) => Promise<void>;
  private seen = new Map<string, number>();
  private session?: { id: string; url: string };
  private seq: number | null = null;
  private bot?: { id: string; name: string };
  private parents = new Map<string, string | null>();
  private retryDelay: number;
  constructor(
    private settings: DiscordSettings,
    private rest: DiscordRest = discordRest(settings.botToken),
    options: { retryDelay?: number } = {},
  ) {
    this.retryDelay = options.retryDelay ?? 1000;
  }
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
    // 1000 ends the session; Discord would otherwise keep it for a resume.
    this.socket?.close(1000);
  }
  private async connectLoop() {
    let delay = this.retryDelay;
    while (this.running) {
      this.state = "connecting";
      let outcome: "ready" | "retry" | "fatal" = "retry";
      try {
        outcome = await this.connect();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        if (error instanceof DiscordError && error.status === 401) outcome = "fatal";
        console.error("Discord connection failed:", this.lastError);
      }
      this.state = "disconnected";
      if (outcome === "fatal") {
        this.running = false;
        console.error(`Discord bot stopped: ${this.lastError}`);
        break;
      }
      if (!this.running) break;
      if (outcome === "ready") delay = this.retryDelay;
      await sleep(delay);
      if (outcome !== "ready") delay = Math.min(delay * 2, 60_000);
    }
  }
  /** Resolves when the socket closes, saying whether the session had started and whether to go on. */
  private async connect(): Promise<"ready" | "retry" | "fatal"> {
    const resume = this.session && this.seq !== null ? this.session : undefined;
    if (!resume) this.seq = null;
    const base = resume?.url ?? (await this.rest<{ url: string }>("GET", "/gateway/bot")).url;
    const url = new URL(base);
    url.searchParams.set("v", "10");
    url.searchParams.set("encoding", "json");
    const ws = new WebSocket(url);
    this.socket = ws;
    let ready = false,
      acked = true,
      timer: NodeJS.Timeout | undefined;
    const send = (payload: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };
    const beat = () => send({ op: 1, d: this.seq });
    // Discord keeps a session resumable after closes other than 1000 and 1001.
    const reconnect = () => ws.close(4000);
    ws.on("message", (data) => {
      let payload: { op: number; d: any; s?: number | null; t?: string | null };
      try {
        payload = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (typeof payload.s === "number") this.seq = payload.s;
      switch (payload.op) {
        case 10: {
          const interval = Number(payload.d?.heartbeat_interval) || 41_250;
          const tick = () => {
            // No acknowledgement since the last heartbeat: the connection is
            // a zombie that would leave the bot silently deaf.
            if (!acked) {
              this.lastError = "Discord stopped acknowledging heartbeats";
              ws.terminate();
              return;
            }
            acked = false;
            beat();
            timer = setTimeout(tick, interval);
          };
          timer = setTimeout(tick, interval * Math.random());
          if (resume)
            send({
              op: 6,
              d: { token: this.settings.botToken, session_id: resume.id, seq: this.seq },
            });
          else
            send({
              op: 2,
              d: {
                token: this.settings.botToken,
                intents: discordIntents,
                properties: { os: process.platform, browser: "proxdesk", device: "proxdesk" },
              },
            });
          break;
        }
        case 11:
          acked = true;
          break;
        case 1:
          beat();
          break;
        case 7:
          reconnect();
          break;
        case 9:
          if (!payload.d) {
            this.session = undefined;
            this.seq = null;
          }
          reconnect();
          break;
        case 0:
          this.dispatch(payload.t ?? "", payload.d);
          if (payload.t === "READY" || payload.t === "RESUMED") {
            ready = true;
            this.state = "connected";
            this.lastError = "";
          }
          break;
      }
    });
    const code = await new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
      ws.on("error", (error) => {
        this.lastError = error.message;
        resolve(0);
      });
    });
    clearTimeout(timer);
    ws.terminate();
    if (fatalCloses[code]) {
      this.lastError = `${fatalCloses[code]} (close code ${code})`;
      return "fatal";
    }
    if (freshCloses.has(code)) {
      this.session = undefined;
      this.seq = null;
    }
    return ready ? "ready" : "retry";
  }
  private dispatch(type: string, data: any) {
    if (type === "READY") {
      this.session = { id: data.session_id, url: data.resume_gateway_url };
      this.bot = {
        id: data.user.id,
        name: data.user.global_name || data.user.username || "",
      };
    } else if (type === "MESSAGE_CREATE") void this.handleMessage(data);
  }
  /** Discord may deliver an event again after a resume; replaying it must not repeat a power action. */
  private firstDelivery(id: string) {
    const now = Date.now();
    for (const [key, expires] of this.seen) if (expires < now) this.seen.delete(key);
    if (this.seen.has(id)) return false;
    this.seen.set(id, now + 10 * 60_000);
    return true;
  }
  /** The channel a thread belongs to, so a thread under an allowed channel is allowed. */
  private async parent(channel: string) {
    if (this.settings.channels.includes(channel)) return channel;
    if (!this.parents.has(channel)) {
      try {
        const info = await this.rest<{ type: number; parent_id?: string }>(
          "GET",
          `/channels/${channel}`,
        );
        this.parents.set(channel, threadTypes.has(info.type) ? info.parent_id ?? null : null);
      } catch {
        return channel;
      }
    }
    return this.parents.get(channel) ?? channel;
  }
  async handleMessage(message: DiscordMessage) {
    const bot = this.bot;
    const author = message.author;
    if (!bot || !author || author.bot || message.webhook_id || author.id === bot.id) return;
    const direct = !message.guild_id;
    const content = message.content ?? "";
    const mention = new RegExp(`<@!?${bot.id}>`, "g");
    if (!direct && !content.match(mention)) return;
    if (!this.firstDelivery(message.id)) return;
    try {
      const target: ChatTarget = {
        conversation: message.channel_id,
        thread: message.id,
        user: author.id,
        ...(direct ? {} : { guild: message.guild_id }),
      };
      await this.handler?.({
        platform: this.id,
        userRef: author.id,
        userName: author.global_name || author.username || author.id,
        // Accounts that predate unique usernames are told apart by a discriminator.
        userHandle:
          author.username && author.discriminator && author.discriminator !== "0"
            ? `${author.username}#${author.discriminator}`
            : author.username || "",
        conversation: direct ? discordDirect : await this.parent(message.channel_id),
        thread: message.id,
        text: content.replace(mention, " ").trim(),
        target,
        botName: bot.name,
      });
    } catch (error) {
      console.error("Discord request failed:", error);
    }
  }
  private async post(channel: string, target: ChatTarget, message: ChatMessage, inReply: boolean) {
    let content = render(message, discordMarkup, target.user);
    if (content.length > 2000) content = `${content.slice(0, 1999)}…`;
    await this.rest("POST", `/channels/${channel}/messages`, {
      content,
      // Only the requester is ever pinged, whatever the text contains.
      allowed_mentions: { parse: [], users: [target.user], replied_user: false },
      ...(inReply && target.thread
        ? { message_reference: { message_id: target.thread, fail_if_not_exists: false } }
        : {}),
    });
  }
  async reply(target: ChatTarget, message: ChatMessage) {
    await this.post(target.conversation, target, message, true);
  }
  notify(target: ChatTarget, message: ChatMessage) {
    return this.reply(target, message);
  }
  /**
   * A direct message to the requester. When Discord refuses it, the channel
   * gets a notice without the content, which may be a link code.
   */
  async privateReply(target: ChatTarget, message: ChatMessage) {
    if (!target.guild) return this.reply(target, message);
    try {
      const dm = await this.rest<{ id: string }>("POST", "/users/@me/channels", {
        recipient_id: target.user,
      });
      await this.post(dm.id, target, message, false);
    } catch (error) {
      if (!(error instanceof DiscordError && error.code === 50007))
        console.error("Discord direct message failed:", error);
      await this.reply(
        target,
        text(
          requester,
          " ",
          icon("error"),
          " I couldn't send you a direct message. Allow direct messages from server members in this server's privacy settings, then ask again.",
        ),
      );
    }
  }
}
