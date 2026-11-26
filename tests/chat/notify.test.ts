import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatBot } from "../../lib/chat/bot";
import { CHANNEL, FakeAdapter, cleanup, settle, setup } from "./helpers";

afterEach(cleanup);

test("completion notifications survive a restart while the task runs", async () => {
  const database = join(mkdtempSync(join(tmpdir(), "proxdesk-chat-")), "db.sqlite");
  const first = setup(database);
  first.s.hypervisor.action = async (vm) => `UPID:${vm.id}`;
  first.s.hypervisor.task = async () => ({ status: "running" });
  await first.adapter.send("U0DEMOSAM", "reboot");
  await first.adapter.send("U0DEMOALEX", "reboot alex-dev");
  assert.equal(first.s.store.activeOperations().length, 2);
  // alex-dev finishes while the bot is already stopping: nobody is told.
  first.bot.stop();
  first.s.hypervisor.task = async (_node, task) =>
    task === "UPID:104" ? { status: "stopped", exitstatus: "OK" } : { status: "running" };
  await first.s.poll();
  await settle();
  assert.equal(first.adapter.sent.filter((m) => m.kind === "notify").length, 0);
  first.s.store.close();

  const second = setup(database);
  second.s.hypervisor.task = async () => ({ status: "stopped", exitstatus: "OK" });
  await second.s.poll();
  await settle();
  assert.deepEqual(
    second.adapter.sent.map((m) => [m.kind, m.text, m.target]),
    [
      [
        "notify",
        "@U0DEMOSAM shared-storage has rebooted.",
        { conversation: CHANNEL, thread: "1.1", user: "U0DEMOSAM" },
      ],
    ],
  );
});

test("a notification for a platform that is not configured is dropped", async () => {
  const { s, adapter } = setup();
  s.hypervisor.action = async () => "UPID:1";
  s.hypervisor.task = async () => ({ status: "running" });
  await adapter.send("U0DEMOSAM", "reboot");
  const [op] = s.store.activeOperations();
  assert.deepEqual(s.store.operationNotify(op.id), {
    platform: "slack",
    target: { conversation: CHANNEL, thread: "1.1", user: "U0DEMOSAM" },
  });
  const other = new ChatBot(s);
  other.add(new FakeAdapter("discord", "Discord"));
  s.hypervisor.task = async () => ({ status: "stopped", exitstatus: "OK" });
  await s.poll();
  await settle();
  // The original bot notified once; the bot without Slack did nothing.
  assert.equal(adapter.sent.filter((m) => m.kind === "notify").length, 1);
});
