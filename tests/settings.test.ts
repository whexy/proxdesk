import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/api";
import type { Config } from "../lib/config";
import { Services } from "../lib/services";
import type { VM } from "../lib/types";

// Demo pools: alex-dev 104 and alex-sandbox 117 in "students", maya-research
// 132 in "research" (tagged gpu), shared-storage 120 in no pool.
const apps: Services[] = [];
function setup(database = ":memory:") {
  const config: Config = {
    demo: true,
    origin: "http://localhost:3000",
    database,
    backupDir: join(mkdtempSync(join(tmpdir(), "proxdesk-settings-")), "backups"),
    secureCookies: false,
  };
  const s = new Services(config);
  apps.push(s);
  const alex = s.store.findEmail("alex@example.com")!,
    admin = s.store.findEmail("admin@example.com")!;
  const memberSession = s.store.createSession(alex.id),
    adminSession = s.store.createSession(admin.id);
  async function call(
    path: string,
    method = "GET",
    data?: unknown,
    token = adminSession,
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
  return { s, alex, admin, memberSession, adminSession, call };
}
afterEach(() => {
  apps.splice(0).forEach((s) => s.store.close());
});
const ids = async (response: Response) =>
  ((await response.json()).vms as VM[]).map((vm) => vm.id);

test("settings endpoints are for administrators only and origin-checked", async () => {
  const { call, memberSession } = setup();
  for (const [path, method, body] of [
    ["/settings", "GET", undefined],
    ["/settings", "PUT", { workspaceName: "Mine" }],
    ["/settings/check", "POST", undefined],
    ["/backups", "POST", undefined],
  ] as const)
    assert.equal(
      (await call(path, method, body, memberSession)).status,
      403,
      `${method} ${path}`,
    );
  assert.equal(
    (
      await call(
        "/settings",
        "PUT",
        { workspaceName: "Evil" },
        undefined,
        "https://evil.example",
      )
    ).status,
    403,
  );
  assert.equal((await call("/settings")).status, 200);
});

test("administrators rename the workspace; the change is validated and audited", async () => {
  const { s, call, memberSession } = setup();
  const initial = await (await call("/auth/session")).json();
  assert.equal(initial.workspaceName, "Proxdesk");
  const anonymous = await handleApi(
    new Request("http://localhost:3000/api/auth/session"),
    s,
  );
  assert.equal((await anonymous.json()).workspaceName, undefined);

  const response = await call("/settings", "PUT", { workspaceName: "GPU Lab" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).settings.workspaceName, "GPU Lab");
  const member = await (
    await call("/auth/session", "GET", undefined, memberSession)
  ).json();
  assert.equal(member.workspaceName, "GPU Lab");
  const audit = s.store
    .audits(s.store.findEmail("admin@example.com")!)
    .find((e) => e.action === "Updated settings")!;
  assert.match(audit.detail, /GPU Lab/);

  for (const body of [
    { workspaceName: "" },
    { workspaceName: "x".repeat(61) },
    { scope: { type: "pool" } },
    { scope: { type: "tag", tag: "bad tag" } },
    { backups: { intervalHours: 0 } },
    { backups: { retention: 1.5 } },
    { unknown: true },
  ])
    assert.equal(
      (await call("/settings", "PUT", body)).status,
      400,
      JSON.stringify(body),
    );
  const before = s.store.audits(s.store.findEmail("admin@example.com")!).length;
  await call("/settings", "PUT", { workspaceName: "GPU Lab" });
  assert.equal(
    s.store.audits(s.store.findEmail("admin@example.com")!).length,
    before,
  );
});

test("VMs outside the managed scope disappear from inventory, actions, and grants", async () => {
  const { s, call, memberSession, alex } = setup();
  assert.deepEqual(await ids(await call("/vms")), [104, 117, 120, 132]);
  await call("/settings", "PUT", { scope: { type: "pool", pool: "research" } });
  assert.deepEqual(await ids(await call("/vms")), [132]);
  assert.deepEqual(await ids(await call("/vms", "GET", undefined, memberSession)), []);
  assert.equal(
    (await call("/vms/104/actions", "POST", { action: "reboot" }, memberSession))
      .status,
    404,
  );
  assert.equal(
    (await call("/vms/104/actions", "POST", { action: "reboot" })).status,
    404,
  );
  assert.equal(
    (
      await call("/grants", "PUT", {
        userId: alex.id,
        vmId: 104,
        permissions: ["view"],
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await call(`/users/${alex.id}`, "PATCH", {
        assignments: [{ vmId: 120, permissions: ["view"] }],
      })
    ).status,
    400,
  );
  // Grants survive a scope change and apply again once the VM is back in scope.
  assert.ok(s.store.grants(alex.id).some((g) => g.vmId === 104));
  await call("/settings", "PUT", { scope: { type: "tag", tag: "GPU" } });
  assert.deepEqual(await ids(await call("/vms")), [132]);
  await call("/settings", "PUT", { scope: { type: "all" } });
  assert.deepEqual(
    await ids(await call("/vms", "GET", undefined, memberSession)),
    [104, 117],
  );
});

test("consoles cannot open outside the scope and close when the scope changes", async () => {
  const { s, alex, memberSession } = setup();
  s.config.demo = false;
  s.hypervisor.console = async () => ({
    url: "wss://pve.example/console",
    headers: {},
    password: "vnc",
  });
  const opened = await s.openConsole(alex, 104, memberSession);
  const ticket = new URL(opened.path!, s.config.origin).searchParams.get(
    "ticket",
  )!;
  const entry = s.consoles.get(ticket)!;
  assert.equal(s.consoleAllowed(entry), true);
  s.store.updateSettings({ scope: { type: "pool", pool: "research" } });
  assert.equal(s.consoleAllowed(entry), false);
  assert.throws(() => s.consumeConsole(ticket, memberSession), /expired/);
  await assert.rejects(s.openConsole(alex, 104, memberSession), /not found/);
});

test("open consoles close when their VM leaves the scope inside Proxmox", async (t) => {
  const { s, alex, memberSession } = setup();
  s.config.demo = false;
  s.hypervisor.console = async () => ({
    url: "wss://pve.example/console",
    headers: {},
    password: "vnc",
  });
  s.store.updateSettings({ scope: { type: "pool", pool: "students" } });
  const original = s.hypervisor.inventory.bind(s.hypervisor);
  let moved = false,
    calls = 0;
  s.hypervisor.inventory = async () => {
    calls++;
    return (await original()).map((vm) =>
      vm.id === 104 && moved ? { ...vm, pool: "archive" } : vm,
    );
  };
  const open = async (vmId: number) => {
    const { path } = await s.openConsole(alex, vmId, memberSession);
    const ticket = new URL(path!, s.config.origin).searchParams.get("ticket")!;
    return s.consumeConsole(ticket, memberSession);
  };
  const first = await open(104),
    second = await open(104);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  calls = 0;
  assert.deepEqual(
    await Promise.all([first, second, first].map((e) => s.consoleStillAllowed(e))),
    [true, true, true],
  );
  assert.equal(calls, 1, "one Proxmox call serves every open console");
  moved = true;
  t.mock.timers.tick(4000);
  assert.equal(await s.consoleStillAllowed(first), true, "the snapshot is reused");
  t.mock.timers.tick(1000);
  assert.equal(await s.consoleStillAllowed(first), false);
  assert.equal(await s.consoleStillAllowed(second), false);
  assert.equal(calls, 2);
  // Back in scope it is allowed again; a Proxmox that cannot be asked is not.
  moved = false;
  t.mock.timers.tick(5000);
  assert.equal(await s.consoleStillAllowed(second), true);
  s.hypervisor.inventory = async () => (await original()).filter((vm) => vm.id !== 104);
  t.mock.timers.tick(5000);
  assert.equal(await s.consoleStillAllowed(second), false, "a vanished VM");
  s.hypervisor.inventory = async () => {
    throw new Error("Cannot reach Proxmox.");
  };
  t.mock.timers.tick(5000);
  await assert.rejects(s.consoleStillAllowed(second), /Cannot reach Proxmox/);
});

test("the Proxmox check and manual backups report through the API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proxdesk-settings-db-"));
  const { s, call } = setup(join(dir, "proxdesk.sqlite"));
  const check = await (await call("/settings/check", "POST")).json();
  assert.match(
    check.checks.map((c: { message: string }) => c.message).join("\n"),
    /4 simulated VMs in scope/,
  );
  const created = await call("/backups", "POST");
  assert.equal(created.status, 201);
  const data = await created.json();
  assert.equal(data.backups.files.length, 1);
  assert.equal(data.backups.dir, s.config.backupDir);
  assert.deepEqual(readdirSync(s.config.backupDir!), [data.backups.files[0].name]);
  const events = s.store.audits(s.store.findEmail("admin@example.com")!);
  assert.equal(events.filter((e) => e.action === "Created backup").length, 1);
  const info = await (await call("/settings")).json();
  assert.equal(info.backups.files[0].name, data.backups.files[0].name);
  assert.ok(!JSON.stringify(info).includes("password"));

  const failing = setup();
  const failed = await failing.call("/backups", "POST");
  assert.equal(failed.status, 409);
  assert.match((await failed.json()).error, /Backup failed/);
  assert.ok(
    failing.s.store
      .audits(failing.admin)
      .some((e) => e.action === "Backup failed"),
  );
});
