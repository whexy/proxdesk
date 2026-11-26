import { handleApi } from "../../lib/api";
import type { Config } from "../../lib/config";
import type {
  AdapterStatus,
  ChatAdapter,
  ChatMember,
  ChatTarget,
  IncomingMessage,
} from "../../lib/chat/adapter";
import { ChatBot } from "../../lib/chat/bot";
import { plain, type ChatMessage } from "../../lib/chat/message";
import { Services } from "../../lib/services";

export const CHANNEL = "C0CHAN";

/** Records what the bot sends; messages render as plain text with "@<user>" for the requester. */
export class FakeAdapter implements ChatAdapter {
  readonly id: string;
  readonly label: string;
  sent: { kind: "reply" | "notify" | "private"; target: ChatTarget; text: string }[] = [];
  members: ChatMember[] = [
    { ref: "U0DEMOMAYA", name: "Maya Patel", handle: "maya" },
    { ref: "U0NEW", name: "New Person", handle: "new" },
  ];
  private handler?: (message: IncomingMessage) => Promise<void>;
  constructor(id = "slack", label = "Slack", private hasPrivate = true) {
    this.id = id;
    this.label = label;
    if (!hasPrivate) this.privateReply = undefined;
  }
  status(): AdapterStatus {
    return { state: "connected", lastError: "" };
  }
  start() {}
  stop() {}
  onMessage(handler: (message: IncomingMessage) => Promise<void>) {
    this.handler = handler;
  }
  private record(kind: "reply" | "notify" | "private", target: ChatTarget, m: ChatMessage) {
    this.sent.push({ kind, target, text: plain(m, `@${target.user}`) });
  }
  async reply(target: ChatTarget, m: ChatMessage) {
    this.record("reply", target, m);
  }
  async notify(target: ChatTarget, m: ChatMessage) {
    this.record("notify", target, m);
  }
  privateReply?: (target: ChatTarget, m: ChatMessage) => Promise<void> = async (
    target,
    m,
  ) => this.record("private", target, m);
  async directory() {
    return this.members;
  }
  async send(userRef: string, text: string, conversation = CHANNEL, userName = userRef) {
    const target = { conversation, thread: "1.1", user: userRef };
    await this.handler?.({
      platform: this.id,
      userRef,
      userName,
      userHandle: userRef.toLowerCase(),
      conversation,
      thread: "1.1",
      text,
      target,
      botName: "proxdesk",
    });
    return this.sent.at(-1)?.text ?? "";
  }
}

const apps: Services[] = [];
export function setup(database = ":memory:") {
  const config: Config = {
    demo: true,
    origin: "http://localhost:3000",
    database,
    secureCookies: false,
  };
  const s = new Services(config);
  apps.push(s);
  const adapter = new FakeAdapter();
  const bot = new ChatBot(s);
  bot.add(adapter, { conversations: [CHANNEL] });
  s.chat = bot;
  const alex = s.store.findEmail("alex@example.com")!,
    admin = s.store.findEmail("admin@example.com")!,
    maya = s.store.findEmail("maya@example.com")!;
  const sam = s.store.getUser(s.store.chatIdentity("slack", "U0DEMOSAM")!.userId)!;
  const session = (userId: string) => s.store.createSession(userId);
  async function call(
    token: string,
    path: string,
    method = "GET",
    data?: unknown,
    origin = config.origin,
  ) {
    return handleApi(
      new Request(`${config.origin}/api${path}`, {
        method,
        headers: {
          cookie: `management_session=${token}`,
          origin,
          "content-type": "application/json",
        },
        ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
      }),
      s,
    );
  }
  return { s, bot, adapter, alex, admin, maya, sam, session, call };
}
export function cleanup() {
  for (const s of apps.splice(0)) {
    s.chat?.stop();
    if (s.store.db.isOpen) s.store.close();
  }
}
/** Lets completion notifications, which are sent without awaiting, go out. */
export const settle = () => new Promise((resolve) => setImmediate(resolve));
