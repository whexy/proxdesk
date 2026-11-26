import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  CommandRegistry,
  registerCommand,
  registry,
  optionalVM,
} from "../../lib/chat/commands";
import { builtins } from "../../lib/chat/builtins";
import { ChatBot } from "../../lib/chat/bot";
import { text } from "../../lib/chat/message";
import { CHANNEL, FakeAdapter, cleanup, setup } from "./helpers";

afterEach(cleanup);

test("only an exact command with acceptable arguments parses", () => {
  const r = new CommandRegistry();
  for (const command of builtins) r.register(command);
  assert.equal(r.parse("reboot")?.command.name, "reboot");
  assert.equal(r.parse("  RESTART  ")?.command.name, "reboot");
  assert.deepEqual(r.parse("stop alex-dev")?.args, { vm: "alex-dev" });
  assert.equal(r.parse("shutdown 104")?.command.name, "stop");
  for (const sentence of [
    "",
    "dance",
    "reboot my vm please",
    "please reboot",
    "reboot alex-dev now",
    "reboot <@U0X>",
    "status?",
    "help me",
    "vms all",
  ])
    assert.equal(r.parse(sentence), undefined, sentence);
  assert.throws(() => r.register({ ...builtins[0] }), /already registered/);
  assert.throws(
    () => r.register({ name: "two words", summary: "", run: async () => {} }),
    /single word/,
  );
  assert.deepEqual(optionalVM([]), { vm: undefined });
  assert.equal(optionalVM(["a b"]), undefined);
});

test("anything but a command gets the help in thread and changes nothing", async () => {
  const { s, adapter } = setup();
  for (const words of ["dance", "", "reboot my vm please", "why is my disk full"])
    await adapter.send("U0DEMOALEX", words);
  await adapter.send("U0STRANGER", "hello");
  assert.equal(adapter.sent.length, 5);
  for (const { kind, text, target } of adapter.sent) {
    assert.equal(kind, "reply");
    assert.equal(target.thread, "1.1");
    assert.match(text, /^@U0[A-Z]+ I can manage your VMs\. Mention me with one of these:/);
    assert.match(text, /- @proxdesk reset \[vm\]: hard reset; unsaved work is lost/);
    assert.match(text, /- @proxdesk link: link your account to Proxdesk/);
  }
  assert.equal(s.store.activeOperations().length, 0);
});

test("requests outside the allowed channels get one private pointer per person", async () => {
  const { s, adapter } = setup();
  for (let i = 0; i < 5; i++) await adapter.send("U0DEMOALEX", "reboot", "C0ELSEWHERE");
  await adapter.send("U0DEMOSAM", "status", "C0ELSEWHERE");
  assert.deepEqual(adapter.sent.map((m) => [m.kind, m.target.user, m.text]), [
    ["private", "U0DEMOALEX", "I only take VM requests in #C0CHAN."],
    ["private", "U0DEMOSAM", "I only take VM requests in #C0CHAN."],
  ]);
  assert.equal(s.store.activeOperations().length, 0);
});

test("a VM is resolved by name or ID among the account's VMs, or the only one", async () => {
  const { s, adapter, alex } = setup();
  s.hypervisor.action = async () => "UPID:test";
  s.hypervisor.task = async () => ({ status: "running" });
  // Alex sees alex-dev (104, running) and alex-sandbox (117, stopped).
  assert.match(await adapter.send("U0DEMOALEX", "status"), /Which VM\? Add its name or ID: alex-dev \(104\), alex-sandbox \(117\)/);
  assert.match(await adapter.send("U0DEMOALEX", "status 117"), /alex-sandbox \(VM 117\) is stopped/);
  assert.match(await adapter.send("U0DEMOALEX", "status ALEX-DEV"), /alex-dev \(VM 104\) is running/);
  assert.match(
    await adapter.send("U0DEMOALEX", "status maya-research"),
    /You have no VM called maya-research\. Yours: alex-dev \(104\), alex-sandbox \(117\)\./,
  );
  assert.match(await adapter.send("U0DEMOALEX", "vms"), /alex-dev \(VM 104\): running\n- alex-sandbox \(VM 117\): stopped/);
  // Only alex-dev is running, but either VM allows reboot, so the VM must be named.
  assert.match(await adapter.send("U0DEMOALEX", "reboot"), /Which VM\?/);
  s.store.grant(alex.id, 117, ["view"]);
  assert.match(await adapter.send("U0DEMOALEX", "reboot"), /Rebooting alex-dev…/);
  assert.equal(s.store.activeOperations()[0].vmId, 104);
  assert.match(await adapter.send("U0DEMOALEX", "reboot 117"), /You do not have permission/);
  s.store.grant(alex.id, 104, []);
  assert.match(await adapter.send("U0DEMOALEX", "start"), /You have no VM you can use this way/);
});

test("third-party commands registered on the shared registry run with the resolved account", async () => {
  const { s, adapter } = setup();
  registerCommand<{ word: string }>({
    name: "echo",
    summary: "repeat a word",
    usage: "<word>",
    args: (words) => (words.length === 1 ? { word: words[0] } : undefined),
    async run(ctx) {
      await ctx.reply(text(`${ctx.args.word} from ${ctx.account?.name ?? "nobody"}`));
    },
  });
  try {
    assert.equal(await adapter.send("U0DEMOALEX", "echo hi"), "@U0DEMOALEX hi from Alex Chen");
    assert.equal(await adapter.send("U0STRANGER", "echo hi"), "@U0STRANGER hi from nobody");
    assert.match(await adapter.send("U0DEMOALEX", "echo"), /- @proxdesk echo <word>: repeat a word/);
  } finally {
    // The registry is process-wide; remove the test command for other tests.
    (registry as unknown as { list: unknown[] }).list.pop();
  }
  // A bot can use its own registry instead.
  const own = new CommandRegistry();
  const other = new FakeAdapter("other", "Other");
  const bot = new ChatBot(s, own);
  bot.add(other);
  assert.match(await other.send("U1", "help"), /I can manage your VMs/);
  assert.equal(other.sent.at(-1)!.text.includes("reboot"), false);
  void CHANNEL;
});

test("the bot answers within the per-user rate limit", async () => {
  const { adapter } = setup();
  for (let i = 0; i < 20; i++) await adapter.send("U0DEMOALEX", "whoami");
  assert.match(await adapter.send("U0DEMOALEX", "whoami"), /Too many attempts/);
  assert.match(await adapter.send("U0DEMOALEX", "help"), /I can manage/);
  assert.match(await adapter.send("U0DEMOSAM", "whoami"), /linked to Sam Rivera \(chat only\)/);
});
