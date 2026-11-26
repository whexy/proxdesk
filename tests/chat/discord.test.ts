import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import { ChatBot } from "../../lib/chat/bot";
import {
  DiscordAdapter,
  DiscordError,
  discordIntents,
  discordRest,
  type DiscordRest,
} from "../../lib/chat/discord";
import {
  bold,
  code,
  discordDirect,
  discordMarkup,
  link,
  render,
  requester,
  text,
} from "../../lib/chat/message";
import { cleanup, setup } from "./helpers";

const BOT = "900000000000000001",
  USER = "900000000000000002",
  STRANGER = "900000000000000003",
  CHANNEL = "900000000000000010",
  OTHER_CHANNEL = "900000000000000011",
  THREAD = "900000000000000012",
  DM = "900000000000000020",
  GUILD = "900000000000000100";

const servers: WebSocketServer[] = [];
const adapters: DiscordAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.stop();
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate();
    server.close();
  }
  cleanup();
});

async function until(condition: () => unknown, what = "condition", timeout = 3000) {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type Payload = { op: number; d: any };
/** One client connection to the fake gateway, with everything the client sent. */
class Connection {
  received: Payload[] = [];
  closed = false;
  /** Acknowledges heartbeats as they arrive, as Discord does. */
  autoAck = false;
  constructor(
    public socket: WebSocket,
    public path: string,
  ) {
    socket.on("message", (data) => {
      const payload = JSON.parse(data.toString());
      this.received.push(payload);
      if (this.autoAck && payload.op === 1) this.send({ op: 11 });
    });
    socket.on("close", () => (this.closed = true));
  }
  send(payload: Record<string, unknown>) {
    this.socket.send(JSON.stringify(payload));
  }
  async next(op: number) {
    const seen = this.received.filter((p) => p.op === op).length;
    await until(() => this.received.filter((p) => p.op === op).length > seen, `op ${op}`);
    return this.received.filter((p) => p.op === op).at(-1)!;
  }
  async first(op: number) {
    await until(() => this.received.some((p) => p.op === op), `op ${op}`);
    return this.received.find((p) => p.op === op)!;
  }
  hello(interval = 60_000) {
    this.send({ op: 10, d: { heartbeat_interval: interval } });
  }
  ready(seq = 1) {
    this.send({
      op: 0,
      s: seq,
      t: "READY",
      d: {
        session_id: "S1",
        resume_gateway_url: `ws://127.0.0.1:${port(this.socket)}/resume`,
        user: { id: BOT, username: "proxdesk", global_name: "Proxdesk" },
      },
    });
  }
  message(seq: number, d: Record<string, unknown>) {
    this.send({ op: 0, s: seq, t: "MESSAGE_CREATE", d });
  }
}
const ports = new WeakMap<WebSocket, number>();
const port = (socket: WebSocket) => ports.get(socket)!;

async function gateway() {
  const server = new WebSocketServer({ port: 0 });
  servers.push(server);
  await once(server, "listening");
  const address = server.address() as { port: number };
  const connections: Connection[] = [];
  server.on("connection", (socket, request) => {
    ports.set(socket, address.port);
    connections.push(new Connection(socket, request.url ?? ""));
  });
  const connection = async (index: number) => {
    await until(() => connections[index], `connection ${index}`);
    return connections[index];
  };
  return { url: `ws://127.0.0.1:${address.port}`, connections, connection };
}

type Call = { method: string; path: string; body?: any };
function discord(options: { allowDMs?: boolean; dmClosed?: boolean } = {}) {
  const { s } = setup();
  const calls: Call[] = [];
  let gatewayUrl = "";
  const rest: DiscordRest = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === "/gateway/bot") return { url: gatewayUrl } as any;
    if (path === "/users/@me/channels") {
      if (options.dmClosed)
        throw new DiscordError(403, 50007, "Discord POST failed: 403 Cannot send messages to this user");
      return { id: DM } as any;
    }
    if (path === `/channels/${THREAD}`) return { type: 11, parent_id: CHANNEL } as any;
    if (path.startsWith("/channels/") && method === "GET") return { type: 0 } as any;
    return { id: "reply" } as any;
  };
  const settings = { botToken: "MTIz.NDU2.Nzg5", channels: [CHANNEL], allowDMs: !!options.allowDMs };
  const adapter = new DiscordAdapter(settings, rest, { retryDelay: 10 });
  adapters.push(adapter);
  const bot = new ChatBot(s);
  bot.add(adapter, {
    conversations: [...settings.channels, ...(settings.allowDMs ? [discordDirect] : [])],
  });
  const posts = (channel?: string) =>
    calls
      .filter((c) => c.method === "POST" && c.path.endsWith("/messages"))
      .filter((c) => !channel || c.path === `/channels/${channel}/messages`)
      .map((c) => c.body);
  return { s, adapter, calls, posts, setGateway: (url: string) => (gatewayUrl = url) };
}

/** A started adapter with a READY session, and a way to send it messages. */
async function connected(options: Parameters<typeof discord>[0] = {}) {
  const d = discord(options);
  const g = await gateway();
  d.setGateway(g.url);
  d.adapter.start();
  const c = await g.connection(0);
  c.hello();
  await c.first(2);
  c.ready();
  await until(() => d.adapter.status().state === "connected", "READY");
  let seq = 1,
    id = 1000;
  const say = (content: string, extra: Record<string, unknown> = {}) =>
    c.message(++seq, {
      id: String(900000000000010000n + BigInt(++id)),
      channel_id: CHANNEL,
      guild_id: GUILD,
      content,
      author: { id: USER, username: "dang", global_name: "Dang Le" },
      ...extra,
    });
  return { ...d, g, c, say };
}

test("the gateway identifies without privileged intents and heartbeats with the sequence", async () => {
  const { adapter, setGateway } = discord();
  const g = await gateway();
  setGateway(g.url);
  adapter.start();
  const c = await g.connection(0);
  assert.match(c.path, /^\/\?v=10&encoding=json$/);
  c.autoAck = true;
  c.hello(40);
  const identify = await c.first(2);
  assert.equal(identify.d.token, "MTIz.NDU2.Nzg5");
  assert.equal(identify.d.intents, discordIntents);
  assert.equal(identify.d.intents & (1 << 15), 0, "MESSAGE_CONTENT is privileged");
  assert.equal(identify.d.intents & (1 << 1), 0, "GUILD_MEMBERS is privileged");
  c.ready(5);
  await until(() => adapter.status().state === "connected", "connected");
  const beat = await c.next(1);
  assert.equal(beat.d, 5);
  c.send({ op: 0, s: 6, t: "TYPING_START", d: {} });
  await until(() => c.received.filter((p) => p.op === 1).some((p) => p.d === 6), "heartbeat with seq 6");
  // A heartbeat requested by Discord is sent at once.
  const count = c.received.filter((p) => p.op === 1).length;
  c.send({ op: 1 });
  await until(() => c.received.filter((p) => p.op === 1).length > count, "requested heartbeat");
  assert.equal(c.closed, false);
  assert.equal(g.connections.length, 1);
});

test("a connection whose heartbeats go unacknowledged is replaced and the session resumed", async () => {
  const { adapter, setGateway } = discord();
  const g = await gateway();
  setGateway(g.url);
  adapter.start();
  const c = await g.connection(0);
  c.hello(30);
  await c.first(2);
  c.ready(7);
  await c.first(1);
  // No ACK: the next heartbeat finds the connection a zombie.
  const next = await g.connection(1);
  assert.equal(next.path, "/resume?v=10&encoding=json");
  next.hello();
  const resume = await next.first(6);
  assert.deepEqual(resume.d, { token: "MTIz.NDU2.Nzg5", session_id: "S1", seq: 7 });
  assert.equal(next.received.some((p) => p.op === 2), false);
  next.send({ op: 0, s: 8, t: "RESUMED", d: {} });
  await until(() => adapter.status().state === "connected", "resumed");
});

test("RECONNECT resumes, and a non-resumable INVALID_SESSION identifies again", async () => {
  const { adapter, setGateway } = discord();
  const g = await gateway();
  setGateway(g.url);
  adapter.start();
  const c = await g.connection(0);
  c.hello();
  await c.first(2);
  c.ready(3);
  await until(() => adapter.status().state === "connected", "connected");
  c.send({ op: 7, d: null });
  const second = await g.connection(1);
  assert.match(second.path, /^\/resume/);
  second.hello();
  assert.equal((await second.first(6)).d.seq, 3);
  second.send({ op: 9, d: true });
  const third = await g.connection(2);
  assert.match(third.path, /^\/resume/, "a resumable invalid session resumes");
  third.hello();
  await third.first(6);
  third.send({ op: 9, d: false });
  const fourth = await g.connection(3);
  assert.match(fourth.path, /^\/\?v=10/, "a fresh session uses the gateway URL");
  fourth.hello();
  await fourth.first(2);
  assert.equal(fourth.received.some((p) => p.op === 6), false);
});

test("a fatal close code stops reconnecting and reports why", async () => {
  const { adapter, setGateway } = discord();
  const g = await gateway();
  setGateway(g.url);
  adapter.start();
  const c = await g.connection(0);
  c.hello();
  await c.first(2);
  c.socket.close(4004, "Authentication failed");
  await until(() => /4004/.test(adapter.status().lastError), "lastError");
  assert.match(adapter.status().lastError, /rejected the bot token/);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(g.connections.length, 1);
  assert.equal(adapter.status().state, "disconnected");
});

test("an ordinary close reconnects with backoff and resumes", async () => {
  const { adapter, setGateway } = discord();
  const g = await gateway();
  setGateway(g.url);
  adapter.start();
  const c = await g.connection(0);
  c.hello();
  await c.first(2);
  c.ready();
  await until(() => adapter.status().state === "connected", "connected");
  c.socket.close(4008, "Rate limited");
  const next = await g.connection(1);
  next.hello();
  await next.first(6);
});

test("only mentions in allowed channels act, with the mention stripped, once per message", async () => {
  const { s, say, posts, adapter } = await connected();
  s.store.linkChatIdentity("discord", USER, "Dang Le", s.store.chatIdentity("slack", "U0DEMOSAM")!.userId);
  const submitted: string[] = [];
  s.hypervisor.action = async (vm, action) => {
    submitted.push(`${action} ${vm.name}`);
    return "UPID:test";
  };
  s.hypervisor.task = async () => ({ status: "running" });
  say("reboot shared-storage");
  say(`<@${BOT}> reboot`, { author: { id: "900000000000000099", bot: true } });
  say(`<@${BOT}> reboot`, { webhook_id: "1" });
  say(`<@${BOT}> reboot`, { author: { id: BOT, username: "proxdesk" } });
  const id = "900000000000020001";
  say(`<@!${BOT}>   reboot shared-storage`, { id });
  say(`<@!${BOT}>   reboot shared-storage`, { id });
  await until(() => posts().length, "reply");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(submitted, ["reboot shared-storage"]);
  assert.equal(posts().length, 1);
  const [reply] = posts(CHANNEL);
  assert.equal(reply.content, `<@${USER}> ⏳ Rebooting **shared-storage**…`);
  assert.deepEqual(reply.allowed_mentions, { parse: [], users: [USER], replied_user: false });
  assert.deepEqual(reply.message_reference, { message_id: id, fail_if_not_exists: false });
  const [op] = s.store.activeOperations();
  assert.equal(op.vmName, "shared-storage");
  const audit = s.store.db
    .prepare("SELECT detail FROM audit WHERE action='Requested reboot'")
    .get() as { detail: string };
  assert.equal(audit.detail, "VM 120 · via Discord");
  assert.equal(adapter.status().state, "connected");
});

test("Discord requests use the linked account's grants, like Slack", async () => {
  const { s, say, posts } = await connected();
  say(`<@${BOT}> reboot shared-storage`);
  await until(() => posts().length === 1, "unlinked refusal");
  assert.match(posts()[0].content, /Your Discord account is not linked to a Proxdesk account/);
  const maya = s.store.findEmail("maya@example.com")!;
  s.store.linkChatIdentity("discord", USER, "Dang Le", maya.id);
  say(`<@${BOT}> reboot shared-storage`);
  await until(() => posts().length === 2, "no-VM refusal");
  assert.match(posts()[1].content, /You have no VM called shared-storage\. Yours: \*\*maya-research\*\*/);
  s.store.updateUser(maya.id, { enabled: false });
  say(`<@${BOT}> status`);
  await until(() => posts().length === 3, "disabled refusal");
  assert.match(posts()[2].content, /Your Proxdesk account is disabled/);
  assert.equal(s.store.activeOperations().length, 0);
});

test("other channels get a pointer, and threads under an allowed channel count as it", async () => {
  const { say, posts, s } = await connected();
  s.store.linkChatIdentity("discord", USER, "Dang Le", s.store.chatIdentity("slack", "U0DEMOSAM")!.userId);
  say(`<@${BOT}> status`, { channel_id: OTHER_CHANNEL });
  await until(() => posts().length === 1, "pointer");
  // The pointer is private: a direct message, not a post in the other channel.
  assert.equal(posts(OTHER_CHANNEL).length, 0);
  assert.equal(posts(DM)[0].content, `I only take VM requests in <#${CHANNEL}>.`);
  say(`<@${BOT}> status`, { channel_id: THREAD });
  await until(() => posts(THREAD).length === 1, "thread reply");
  assert.match(posts(THREAD)[0].content, /\*\*shared-storage\*\* \(VM 120\) is \*\*running\*\*/);
});

test("direct messages need no mention when allowed and get a pointer otherwise", async () => {
  const closed = await connected();
  closed.say("status", { channel_id: DM, guild_id: undefined });
  await until(() => closed.posts().length === 1, "pointer");
  assert.equal(closed.posts(DM)[0].content, `I only take VM requests in <#${CHANNEL}>.`);
  closed.adapter.stop();

  const open = await connected({ allowDMs: true });
  open.s.store.linkChatIdentity(
    "discord",
    USER,
    "Dang Le",
    open.s.store.chatIdentity("slack", "U0DEMOSAM")!.userId,
  );
  open.say("status", { channel_id: DM, guild_id: undefined });
  await until(() => open.posts().length === 1, "status");
  assert.match(open.posts(DM)[0].content, /shared-storage/);
});

test("link codes go by direct message and never into the channel", async () => {
  const { s, say, posts, calls } = await connected();
  say(`<@${BOT}> link`);
  await until(() => posts().length === 1, "direct message");
  assert.deepEqual(calls.find((c) => c.path === "/users/@me/channels")!.body, {
    recipient_id: USER,
  });
  const [dm] = posts(DM);
  assert.match(dm.content, /^🔗 \[Open this link\]\(<http:\/\/localhost:3000\/link\/[A-Za-z0-9_-]{43}>\) within 10 minutes/);
  assert.equal(dm.message_reference, undefined);
  assert.equal(posts(CHANNEL).length, 0);
  // The link page identifies the sender by username and ID, not display name.
  const code = dm.content.match(/\/link\/([A-Za-z0-9_-]{43})/)[1];
  assert.deepEqual(
    (({ userRef, handle, displayName }) => ({ userRef, handle, displayName }))(
      s.store.linkCode(code)!,
    ),
    { userRef: USER, handle: "dang", displayName: "Dang Le" },
  );
});

test("when direct messages are closed, the channel gets a notice without the code", async () => {
  const { say, posts } = await connected({ dmClosed: true });
  say(`<@${BOT}> link`);
  await until(() => posts().length === 1, "notice");
  const [notice] = posts(CHANNEL);
  assert.match(notice.content, /^<@900000000000000002> ❌ I couldn't send you a direct message\./);
  assert.doesNotMatch(JSON.stringify(posts()), /\/link\//);
});

test("REST retries a 429 after retry_after, a bounded number of times", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  let limited = 1;
  const fake = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    if (limited-- > 0)
      return new Response(JSON.stringify({ retry_after: 0.01, global: false }), { status: 429 });
    return new Response(JSON.stringify({ id: "1" }), { status: 200 });
  }) as typeof fetch;
  const rest = discordRest("tok.en.x", { base: "https://discord.test/api/v10", fetch: fake, retries: 2 });
  assert.deepEqual(await rest("POST", "/channels/1/messages", { content: "hi" }), { id: "1" });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://discord.test/api/v10/channels/1/messages");
  assert.equal((requests[0].init.headers as Record<string, string>).Authorization, "Bot tok.en.x");
  limited = 10;
  requests.length = 0;
  await assert.rejects(rest("GET", "/users/@me"), (error: unknown) => {
    assert.ok(error instanceof DiscordError);
    assert.equal(error.status, 429);
    return true;
  });
  assert.equal(requests.length, 3);
  const failing = (async () =>
    new Response(JSON.stringify({ code: 50007, message: "Cannot send messages to this user" }), {
      status: 403,
    })) as unknown as typeof fetch;
  await assert.rejects(discordRest("t.o.k", { fetch: failing })("POST", "/users/@me/channels", {}), (
    error: unknown,
  ) => error instanceof DiscordError && error.code === 50007);
});

test("Discord markup escapes markdown and mentions in user-controlled text", () => {
  const rendered = render(
    text(
      requester,
      " ",
      bold("**x** @everyone <@123> [a](http://e)"),
      " ",
      "_y_ ~~z~~ ||s|| `c` \\",
      " ",
      code("a`b"),
      " ",
      link("http://localhost/x", "click [here]"),
    ),
    discordMarkup,
    USER,
  );
  assert.equal(
    rendered,
    `<@${USER}> **\\*\\*x\\*\\* @\u200beveryone \\<@\u200b123> \\[a\\](http://e)** \\_y\\_ \\~\\~z\\~\\~ \\|\\|s\\|\\| \\\`c\\\` \\\\ \`aˋb\` [click \\[here\\]](<http://localhost/x>)`,
  );
  assert.equal(render(text("# heading"), discordMarkup, USER), "\\# heading");
  assert.equal(render(text("1. item"), discordMarkup, USER), "1\\. item");
  assert.equal(discordMarkup.conversation(discordDirect), "direct messages");
});
