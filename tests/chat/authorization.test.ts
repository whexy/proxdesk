import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, settle, setup } from "./helpers";

afterEach(cleanup);

test("chat requests use the linked account's grants, as the web does", async () => {
  const { s, adapter, alex, session, call } = setup();
  s.hypervisor.action = async () => "UPID:test";
  s.hypervisor.task = async () => ({ status: "running" });
  // Alex may reboot alex-dev but not reset it, on the web and in chat alike.
  const web = await call(session(alex.id), "/vms/104/actions", "POST", { action: "reset" });
  assert.equal(web.status, 403);
  assert.match(await adapter.send("U0DEMOALEX", "reset alex-dev"), /You do not have permission/);
  assert.equal(s.store.activeOperations().length, 0);
  // An unlinked sender is told how to link.
  assert.match(
    await adapter.send("U0STRANGER", "status"),
    /Your Slack account is not linked to a Proxdesk account\. Mention me with link/,
  );
  // A chat-only member with every action may reset its VM.
  assert.match(await adapter.send("U0DEMOSAM", "reset"), /Force-resetting shared-storage…/);
  const [op] = s.store.activeOperations();
  assert.equal(op.userName, "Sam Rivera");
  const admin = s.store.findEmail("admin@example.com")!;
  const audit = s.store.audits(admin).find((e) => e.action === "Requested reset")!;
  assert.equal(audit.userName, "Sam Rivera");
  assert.equal(audit.detail, "VM 120 · via Slack");
});

test("a disabled account is refused", async () => {
  const { s, adapter, sam } = setup();
  s.store.updateUser(sam.id, { enabled: false });
  for (const command of ["status", "vms", "reset"])
    assert.match(await adapter.send("U0DEMOSAM", command), /Your Proxdesk account is disabled/);
  assert.equal(s.store.activeOperations().length, 0);
});

test("a VM outside the managed scope is treated as nonexistent", async () => {
  const { s, adapter } = setup();
  assert.match(await adapter.send("U0DEMOSAM", "status"), /shared-storage/);
  s.store.updateSettings({ scope: { type: "tag", tag: "gpu" } });
  assert.match(await adapter.send("U0DEMOSAM", "status"), /You have no VM you can use this way/);
  assert.match(await adapter.send("U0DEMOSAM", "reboot 120"), /You have no VM called 120/);
  assert.equal(s.store.activeOperations().length, 0);
});

test("a grant revoked during the VM lookup blocks submission", async () => {
  const { s, adapter, sam } = setup();
  let lookups = 0,
    submitted = false;
  const original = s.hypervisor.inventory.bind(s.hypervisor);
  s.hypervisor.inventory = async () => {
    // The bot looks up the VM, then act() looks it up again before submitting.
    if (++lookups === 2) s.store.grant(sam.id, 120, ["view"]);
    return original();
  };
  s.hypervisor.action = async () => {
    submitted = true;
    return "never";
  };
  assert.match(await adapter.send("U0DEMOSAM", "reboot"), /You do not have permission/);
  assert.equal(submitted, false);
  assert.equal(lookups, 2);

  // Disabling the account during the final lookup is refused the same way.
  s.store.grant(sam.id, 120, ["view", "reboot"]);
  lookups = 0;
  s.hypervisor.inventory = async () => {
    if (++lookups === 2) s.store.updateUser(sam.id, { enabled: false });
    return original();
  };
  assert.match(await adapter.send("U0DEMOSAM", "reboot"), /Account disabled/);
  assert.equal(submitted, false);
});

test("power requests reply when accepted and again when Proxmox finishes", async () => {
  const { s, adapter } = setup();
  s.hypervisor.action = async () => "UPID:test";
  s.hypervisor.task = async () => ({ status: "running" });
  await adapter.send("U0DEMOSAM", "stop");
  const [op] = s.store.activeOperations();
  assert.equal(op.action, "shutdown");
  assert.match(adapter.sent[0].text, /@U0DEMOSAM Shutting down shared-storage…/);
  assert.match(await adapter.send("U0DEMOSAM", "reboot"), /already in progress/);
  s.hypervisor.task = async () => ({ status: "stopped", exitstatus: "OK" });
  await s.poll();
  await settle();
  const last = adapter.sent.at(-1)!;
  assert.equal(last.kind, "notify");
  assert.equal(last.text, "@U0DEMOSAM shared-storage is shut down.");
  assert.deepEqual(last.target, { conversation: "C0CHAN", thread: "1.1", user: "U0DEMOSAM" });
});

test("a failed submission is reported once, through the completion notification", async () => {
  const { s, adapter } = setup();
  s.hypervisor.action = async () => {
    throw new Error("Connection reset.");
  };
  await adapter.send("U0DEMOSAM", "reboot");
  await settle();
  assert.deepEqual(
    adapter.sent.map((m) => [m.kind, m.text]),
    [
      [
        "notify",
        "@U0DEMOSAM reboot of shared-storage has an unknown outcome: Connection reset. Check VM state before retrying.",
      ],
    ],
  );
});
