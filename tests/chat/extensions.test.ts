import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRegistry } from "../../lib/chat/commands";
import { builtins } from "../../lib/chat/builtins";
import { ChatBot } from "../../lib/chat/bot";
import { loadExtensions } from "../../lib/extensions";
import { CHANNEL, FakeAdapter, cleanup, setup } from "./helpers";

const uptime = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../examples/extensions/uptime.mjs",
);
afterEach(cleanup);

/** A bot with its own registry, so extensions loaded here do not leak into other tests. */
function bot() {
  const { s } = setup();
  const registry = new CommandRegistry();
  for (const command of builtins) registry.register(command);
  const chat = new ChatBot(s, registry);
  const adapter = new FakeAdapter();
  chat.add(adapter, { conversations: [CHANNEL] });
  return { s, chat, registry, adapter };
}

function module(source: string) {
  const file = join(mkdtempSync(join(tmpdir(), "proxdesk-ext-")), "ext.mjs");
  writeFileSync(file, source);
  return file;
}

test("the example uptime extension answers with the linked account's permissions", async () => {
  const { s, chat, registry, adapter } = bot();
  const logged: unknown[][] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => logged.push(args);
  try {
    assert.equal(await loadExtensions([uptime], { services: s, bot: chat, registry }), 1);
  } finally {
    console.log = log;
  }
  assert.deepEqual(logged, [[`[extension ${uptime}]`, "registered the uptime command"]]);
  assert.match(await adapter.send("U0DEMOSAM", "uptime"), /^@U0DEMOSAM shared-storage has been up for \d+d \d+h \d+m\.$/);
  assert.match(await adapter.send("U0DEMOSAM", "uptime alex-dev"), /You have no VM called alex-dev/);
  assert.match(await adapter.send("U0NOBODY", "uptime"), /not linked to a Proxdesk account/);
  assert.match(await adapter.send("U0DEMOSAM", "help"), /uptime \[vm\]: how long a VM has been running/);
  const alex = s.store.findEmail("alex@example.com")!;
  s.store.linkChatIdentity("slack", "U0ALEX", "Alex", alex.id);
  assert.equal(await adapter.send("U0ALEX", "uptime alex-sandbox"), "@U0ALEX alex-sandbox is stopped.");
});

test("extensions can add chat adapters and see API version 1", async () => {
  const { s, chat, registry } = bot();
  const file = module(`
    export default (api) => {
      if (api.version !== 1) throw new Error("unexpected API");
      api.addChatAdapter({
        id: "fake", label: "Fake",
        start() {}, stop() {}, status: () => ({ state: "connected", lastError: "" }),
        onMessage() {}, async reply() {}, async notify() {},
      }, { conversations: ["room"] });
      api.log.warn(Object.isFrozen(api) && Object.isFrozen(api.log) && Object.isFrozen(api.messages));
    };
  `);
  const warned: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warned.push(args);
  try {
    await loadExtensions([file], { services: s, bot: chat, registry });
  } finally {
    console.warn = warn;
  }
  assert.equal(chat.adapter("fake")?.label, "Fake");
  assert.deepEqual(chat.list().find((a) => a.adapter.id === "fake")?.options, { conversations: ["room"] });
  assert.equal(warned[0][1], true);
});

test("a broken extension stops loading with a message naming it", async () => {
  const { s, chat, registry } = bot();
  const context = { services: s, bot: chat, registry };
  const missing = join(tmpdir(), "proxdesk-no-such-extension.mjs");
  await assert.rejects(loadExtensions([missing], context), new RegExp(`^Error: Cannot load extension ${missing}: `));
  await assert.rejects(
    loadExtensions([module("export const x = 1;")], context),
    /default export must be a function/,
  );
  await assert.rejects(
    loadExtensions([module(`export default () => { throw new Error("boom"); };`)], context),
    /Cannot load extension .*ext\.mjs: boom$/,
  );
  await assert.rejects(
    loadExtensions([module(`export default (api) => api.registerCommand({ name: "help", summary: "x", run() {} });`)], context),
    /Chat command "help" is already registered/,
  );
  await assert.rejects(loadExtensions(["proxdesk-no-such-package"], context), /Cannot load extension proxdesk-no-such-package/);
});
