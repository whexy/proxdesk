import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import { ChatBot } from "../../lib/chat/bot";
import { SlackAdapter, type SlackCall } from "../../lib/chat/slack";
import { cleanup, setup } from "./helpers";

const CHANNEL = "C0VMREQUESTS";
const adapters: SlackAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.stop();
  cleanup();
});

function slack(channels = [CHANNEL]) {
  const { s } = setup();
  const calls: { method: string; params: Record<string, string> }[] = [];
  let socketUrl = "",
    failDirectory = false;
  const call: SlackCall = async (_token, method, params) => {
    calls.push({ method, params });
    if (method === "apps.connections.open") return { ok: true, url: socketUrl };
    if (method === "auth.test") return { ok: true, user: "proxdesk", user_id: "U0BOT" };
    if (method === "conversations.members")
      return {
        ok: true,
        members: params.channel === CHANNEL ? ["U0DANG", "U0BOT"] : ["U0DANG", "U0OTHER"],
      };
    if (method === "users.list") {
      if (failDirectory) throw new Error("Slack users.list failed: ratelimited");
      const people = ["U0BOT", "U0DANG", "U0OTHER", "U0ELSEWHERE"].map((id) =>
        id === "U0BOT"
          ? { id, is_bot: true }
          : {
              id,
              name: id.toLowerCase(),
              profile: { real_name: id === "U0DANG" ? "Dang Le" : id === "U0OTHER" ? "Other" : "Elsewhere", display_name: "" },
            },
      );
      // Two pages, to exercise the cursor.
      return params.cursor
        ? { ok: true, members: people.slice(2) }
        : { ok: true, members: people.slice(0, 2), response_metadata: { next_cursor: "page2" } };
    }
    if (method === "users.info")
      return params.user === "U0BOT"
        ? { ok: true, user: { is_bot: true } }
        : {
            ok: true,
            user: {
              name: params.user.toLowerCase(),
              profile: { real_name: params.user === "U0DANG" ? "Dang Le" : "Other", display_name: "" },
            },
          };
    return { ok: true };
  };
  const adapter = new SlackAdapter(
    { appToken: "xapp-test", botToken: "xoxb-test", channels },
    call,
  );
  adapters.push(adapter);
  const bot = new ChatBot(s);
  bot.add(adapter, { conversations: channels });
  const posts = (method = "chat.postMessage") =>
    calls.filter((c) => c.method === method).map((c) => c.params);
  const mention = (user: string, text: string, channel = CHANNEL) =>
    adapter.handleMention({
      user,
      channel,
      text: `<@U0BOT> ${text}`,
      ts: "1700000000.000100",
    });
  return {
    s,
    adapter,
    calls,
    posts,
    mention,
    setSocketUrl: (url: string) => (socketUrl = url),
    failDirectory: (fail: boolean) => (failDirectory = fail),
  };
}

test("Slack replies are mrkdwn in the thread, addressed to the requester", async () => {
  const { s, posts, mention, calls } = slack();
  s.hypervisor.action = async () => "UPID:test";
  s.hypervisor.task = async () => ({ status: "running" });
  await mention("U0DEMOSAM", "status");
  const [status] = posts();
  assert.equal(status.channel, CHANNEL);
  assert.equal(status.thread_ts, "1700000000.000100");
  assert.match(status.text, /^<@U0DEMOSAM> \*shared-storage\* \(VM 120\) is \*running\* · up /);
  await mention("U0DEMOSAM", "dance");
  assert.match(posts()[1].text, /• `@proxdesk reset \[vm\]`: hard reset; unsaved work is lost/);
  assert.equal(calls.filter((c) => c.method === "auth.test").length, 1);
  // The sender's name is looked up once, for link codes.
  await mention("U0DEMOSAM", "link");
  const [ephemeral] = posts("chat.postEphemeral");
  assert.equal(ephemeral.user, "U0DEMOSAM");
  assert.equal(ephemeral.thread_ts, "1700000000.000100");
  assert.match(ephemeral.text, /^:link: <http:\/\/localhost:3000\/link\/[A-Za-z0-9_-]{43}\|Open this link> within 10 minutes/);
  assert.equal(calls.filter((c) => c.method === "users.info").length, 1);
  const code = ephemeral.text.match(/\/link\/([A-Za-z0-9_-]{43})/)![1];
  assert.equal(s.store.linkCode(code)?.handle, "u0demosam");
  await mention("U0DEMOSAM", "reboot");
  assert.match(posts().at(-1)!.text, /^<@U0DEMOSAM> :hourglass_flowing_sand: Rebooting \*shared-storage\*…$/);
});

test("Slack text from VM names is escaped", async () => {
  const { s, posts, mention } = slack();
  const original = s.hypervisor.inventory.bind(s.hypervisor);
  s.hypervisor.inventory = async () =>
    (await original()).map((vm) => (vm.id === 120 ? { ...vm, name: "a<b>&c" } : vm));
  await mention("U0DEMOSAM", "status");
  assert.match(posts()[0].text, /\*a&lt;b&gt;&amp;c\*/);
});

test("mentions elsewhere get an ephemeral pointer to the bot's channels", async () => {
  const { s, posts, mention } = slack([CHANNEL, "G0PRIVATE"]);
  await mention("U0DEMOSAM", "reboot", "C0ELSEWHERE");
  const [refusal] = posts("chat.postEphemeral");
  assert.equal(refusal.user, "U0DEMOSAM");
  assert.equal(refusal.text, "I only take VM requests in <#C0VMREQUESTS>, <#G0PRIVATE>.");
  await mention("U0DEMOSAM", "status", "G0PRIVATE");
  assert.match(posts()[0].text, /shared-storage/);
  assert.equal(s.store.activeOperations().length, 0);
});

test("only the bot's own mention is removed from a request", async () => {
  const { s, posts, mention } = slack();
  await mention("U0DEMOSAM", "stop <@U0BOB>");
  assert.match(posts()[0].text, /I can manage your VMs/);
  assert.equal(s.store.activeOperations().length, 0);
  await mention("U0DEMOSAM", "status <@U0BOT|proxdesk>");
  assert.match(posts()[1].text, /shared-storage/);
});

test("the directory lists human members of every channel once and is cached", async () => {
  const { adapter, calls, failDirectory } = slack([CHANNEL, "C0SECOND"]);
  const count = (method: string) => calls.filter((c) => c.method === method).length;
  failDirectory(true);
  await assert.rejects(adapter.directory(), /ratelimited/);
  await assert.rejects(adapter.directory(), /ratelimited/);
  assert.equal(count("users.list"), 1, "a failure is cached briefly");
  failDirectory(false);
  // @ts-expect-error: expire the cached failure
  adapter.members.expires = 0;
  const expected = [
    { ref: "U0DANG", name: "Dang Le", handle: "u0dang" },
    { ref: "U0OTHER", name: "Other", handle: "u0other" },
  ];
  assert.deepEqual(await adapter.directory(), expected);
  assert.deepEqual(await adapter.directory(), expected);
  assert.equal(count("users.list"), 3, "one call per page, then cached");
  assert.equal(count("users.info"), 0);
});

test("Socket Mode acknowledges every envelope but acts on a redelivered event once", async () => {
  const { s, adapter, posts, setSocketUrl } = slack();
  s.hypervisor.action = async () => "UPID:test";
  s.hypervisor.task = async () => ({ status: "running" });
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const address = server.address() as { port: number };
  setSocketUrl(`ws://127.0.0.1:${address.port}`);
  adapter.start();
  const [socket] = (await once(server, "connection")) as [WebSocket];
  const acks: string[] = [];
  socket.on("message", (data) => acks.push(JSON.parse(data.toString()).envelope_id));
  socket.send(JSON.stringify({ type: "hello" }));
  const event = {
    type: "app_mention",
    user: "U0DEMOSAM",
    channel: CHANNEL,
    text: "<@U0BOT> reboot",
    ts: "1.2",
  };
  for (const envelope of ["e1", "e2"])
    socket.send(
      JSON.stringify({
        envelope_id: envelope,
        type: "events_api",
        payload: { event_id: "Ev1", event },
      }),
    );
  while (acks.length < 2 || !posts().length)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(acks, ["e1", "e2"]);
  assert.equal(adapter.status().state, "connected");
  assert.equal(s.store.activeOperations().length, 1);
  adapter.stop();
  server.close();
});
