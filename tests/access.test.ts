import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Services } from "../lib/services";
import { handleApi } from "../lib/api";
import type { Config } from "../lib/config";
import type { Hypervisor } from "../lib/proxmox";
import type { VM } from "../lib/types";

const apps: Services[] = [];
function setup() {
  const config: Config = {
    demo: true,
    origin: "http://localhost:3000",
    database: ":memory:",
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
    token = memberSession,
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

test("inventory contains only assigned VMs and never credentials", async () => {
  const { call } = setup();
  const response = await call("/vms");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(
    data.vms.map((vm: VM) => vm.id),
    [104, 117],
  );
  assert.ok(!JSON.stringify(data).includes("tokenSecret"));
  assert.equal((await call("/users")).status, 403);
  assert.equal((await call("/grants")).status, 403);
});

test("guessed VM IDs cannot execute power actions or open a console", async () => {
  const { call } = setup();
  for (const id of [120, 132, 999]) {
    assert.equal(
      (await call(`/vms/${id}/actions`, "POST", { action: "reboot" })).status,
      403,
    );
    assert.equal((await call(`/vms/${id}/console`, "POST")).status, 403);
  }
  assert.equal(
    (await call("/vms/104/actions", "POST", { action: "reset" })).status,
    403,
  );
});

test("mutations reject cross-origin and missing-origin requests", async () => {
  const { call } = setup();
  assert.equal(
    (
      await call(
        "/vms/104/actions",
        "POST",
        { action: "reboot" },
        undefined,
        "https://evil.example",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/auth/login",
        "POST",
        { email: "alex@example.com", password: "demo-proxdesk" },
        undefined,
        "",
      )
    ).status,
    403,
  );
});

test("empty POST streams work for console and logout; malformed and oversized bodies are rejected", async () => {
  const { s, memberSession } = setup();
  const request = (path: string, raw: string) =>
    handleApi(
      new Request(`${s.config.origin}/api${path}`, {
        method: "POST",
        headers: {
          origin: s.config.origin,
          "content-type": "application/json",
          cookie: `management_session=${memberSession}`,
        },
        body: raw,
      }),
      s,
    );
  assert.equal((await request("/vms/104/console", "")).status, 200);
  assert.equal((await request("/auth/login", "{bad")).status, 400);
  assert.equal((await request("/auth/login", "x".repeat(17000))).status, 413);
  assert.equal((await request("/auth/logout", "")).status, 200);
});

test("configured LAN login uses a LAN cookie while HTTPS retains Secure cookies", async () => {
  const { s, call } = setup();
  s.config.origin = "https://portal.example";
  s.config.secureCookies = true;
  s.config.additionalOrigins = ["http://192.168.1.10:3000"];
  const login = { email: "alex@example.com", password: "demo-proxdesk" };
  const lan = await call(
    "/auth/login",
    "POST",
    login,
    undefined,
    "http://192.168.1.10:3000",
  );
  assert.equal(lan.status, 200);
  assert.ok(!lan.headers.get("set-cookie")!.includes("Secure"));
  assert.ok(lan.headers.get("set-cookie")!.includes("HttpOnly; SameSite=Lax"));
  const secure = await call(
    "/auth/login",
    "POST",
    login,
    undefined,
    "https://portal.example",
  );
  assert.equal(secure.status, 200);
  assert.ok(secure.headers.get("set-cookie")!.includes("Secure"));
  assert.equal(
    (
      await call(
        "/auth/login",
        "POST",
        login,
        undefined,
        "https://attacker.example",
      )
    ).status,
    403,
  );
  const logout = await call(
    "/auth/logout",
    "POST",
    undefined,
    undefined,
    "http://192.168.1.10:3000",
  );
  assert.equal(logout.status, 200);
  assert.ok(!logout.headers.get("set-cookie")!.includes("Secure"));
});

test("logout and disabling an account immediately invalidate sessions", async () => {
  const { s, call, alex, memberSession, adminSession } = setup();
  assert.equal(
    (await call(`/users/${alex.id}`, "PATCH", { enabled: false }, adminSession))
      .status,
    200,
  );
  assert.equal((await call("/vms")).status, 401);
  assert.equal(s.store.session(memberSession), undefined);
  assert.equal(
    (await call("/auth/logout", "POST", undefined, adminSession)).status,
    200,
  );
  assert.equal(
    (await call("/vms", "GET", undefined, adminSession)).status,
    401,
  );
});

test("last administrator protection rolls back all assignments atomically", async () => {
  const { s, admin, adminSession, call } = setup();
  const result = await call(
    `/users/${admin.id}`,
    "PATCH",
    { enabled: false, assignments: [{ vmId: 104, permissions: ["view"] }] },
    adminSession,
  );
  assert.equal(result.status, 409);
  assert.equal(s.store.getUser(admin.id)?.enabled, true);
  assert.equal(s.store.grants(admin.id).length, 0);
});

test("power operations serialize per VM and validate machine state", async () => {
  const { s, call } = setup();
  const responses = await Promise.all([
    call("/vms/104/actions", "POST", { action: "reboot" }),
    call("/vms/104/actions", "POST", { action: "shutdown" }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [202, 409]);
  assert.equal(s.store.activeOperations().length, 1);
  assert.equal(
    (await call("/vms/117/actions", "POST", { action: "reboot" })).status,
    409,
  );
  assert.equal(
    (await call("/vms/104/actions", "POST", { action: "start" })).status,
    409,
  );
});

test("accepted action is pending until Proxmox confirms success; failures remain failures", async () => {
  const { s, call } = setup();
  s.hypervisor.action = async () => "UPID:test";
  s.hypervisor.task = async () => ({ status: "running" });
  const { operation } = await (
    await call("/vms/104/actions", "POST", { action: "reboot" })
  ).json();
  assert.equal(operation.status, "running");
  await s.poll();
  assert.equal(s.store.getOperation(operation.id)?.status, "running");
  s.hypervisor.task = async () => ({
    status: "stopped",
    exitstatus: "guest did not respond",
  });
  await s.poll();
  assert.equal(s.store.getOperation(operation.id)?.status, "failed");
  assert.equal(
    s.store.getOperation(operation.id)?.error,
    "guest did not respond",
  );
  s.hypervisor.task = async () => ({ status: "stopped", exitstatus: "OK" });
  const second = await (
    await call("/vms/104/actions", "POST", { action: "reboot" })
  ).json();
  await s.poll();
  assert.equal(s.store.getOperation(second.operation.id)?.status, "succeeded");
});

test("submission network errors report unknown outcomes without retrying the action", async () => {
  const { s, call } = setup();
  let submissions = 0;
  s.hypervisor.action = async () => {
    submissions++;
    throw new Error("Connection lost");
  };
  const data = await (
    await call("/vms/104/actions", "POST", { action: "reboot" })
  ).json();
  assert.equal(data.operation.status, "unknown");
  assert.equal(submissions, 1);
  assert.match(data.operation.error, /Check VM state/);
});

test("revoking a grant while a VM lookup is in progress blocks submission", async () => {
  const { s, alex, call } = setup();
  const original = s.hypervisor.inventory.bind(s.hypervisor);
  let submitted = false;
  s.hypervisor.inventory = async () => {
    s.store.grant(alex.id, 104, []);
    return original();
  };
  s.hypervisor.action = async () => {
    submitted = true;
    return "never";
  };
  assert.equal(
    (await call("/vms/104/actions", "POST", { action: "reboot" })).status,
    403,
  );
  assert.equal(submitted, false);
});

test("members cannot read another user’s operations or audit events", async () => {
  const { s, call, adminSession } = setup();
  const { operation } = await (
    await call("/vms/120/actions", "POST", { action: "reboot" }, adminSession)
  ).json();
  assert.equal((await call(`/operations/${operation.id}`)).status, 404);
  assert.equal((await (await call("/audit")).json()).events.length, 0);
  assert.ok(s.store.activeOperations().length);
});

test("password change rotates the current session and invalidates other sessions", async () => {
  const { call, s, alex, memberSession } = setup();
  const secondSession = s.store.createSession(alex.id);
  assert.equal(
    (
      await call("/auth/password", "POST", {
        currentPassword: "incorrect",
        newPassword: "a-better-password",
      })
    ).status,
    403,
  );
  const response = await call("/auth/password", "POST", {
    currentPassword: "demo-proxdesk",
    newPassword: "a-better-password",
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie")!, /HttpOnly; SameSite=Lax/);
  assert.equal(s.store.session(memberSession), undefined);
  assert.equal(s.store.session(secondSession), undefined);
  assert.equal(
    s.store.authenticate(alex.email!, "demo-proxdesk"),
    undefined,
  );
  assert.equal(
    s.store.authenticate(alex.email!, "a-better-password")?.id,
    alex.id,
  );
});

test("login attempts are rate limited", async () => {
  const { call } = setup();
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await call("/auth/login", "POST", {
          email: "alex@example.com",
          password: "bad",
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await call("/auth/login", "POST", {
        email: "alex@example.com",
        password: "bad",
      })
    ).status,
    429,
  );
});

test("console tickets are short-lived, single-use, session-bound, and recheck permission", async () => {
  const { s, alex, memberSession } = setup();
  s.config.demo = false;
  s.hypervisor.console = async () => ({
    url: "wss://pve.example/console",
    headers: { Authorization: "server-secret" },
    password: "short-lived-password",
  });
  const data = await s.openConsole(alex, 104, memberSession);
  assert.ok(!JSON.stringify(data).includes("server-secret"));
  const ticket = new URL(data.path!, s.config.origin).searchParams.get(
    "ticket",
  )!;
  const connection = s.consumeConsole(ticket, memberSession);
  assert.equal(connection.connection.headers.Authorization, "server-secret");
  assert.throws(() => s.consumeConsole(ticket, memberSession));
  const next = await s.openConsole(alex, 104, memberSession);
  const nextTicket = new URL(next.path!, s.config.origin).searchParams.get(
    "ticket",
  )!;
  s.store.grant(alex.id, 104, ["view"]);
  assert.throws(() => s.consumeConsole(nextTicket, memberSession));
  s.store.grant(alex.id, 104, ["view", "console"]);
  const expired = await s.openConsole(alex, 104, memberSession);
  const expiredTicket = new URL(
    expired.path!,
    s.config.origin,
  ).searchParams.get("ticket")!;
  s.consoles.get(expiredTicket)!.expires = Date.now() - 1;
  assert.throws(() => s.consumeConsole(expiredTicket, memberSession));
  const other = await s.openConsole(alex, 104, memberSession);
  const otherTicket = new URL(other.path!, s.config.origin).searchParams.get(
    "ticket",
  )!;
  assert.throws(() =>
    s.consumeConsole(otherTicket, s.store.createSession(alex.id)),
  );
});

test("new OIDC identities await approval; subject changes cannot take over an existing binding", () => {
  const { s } = setup();
  const pending = s.store.oidcUser(
    "https://issuer.example",
    "subject-1",
    "new@example.com",
    "New Member",
  );
  assert.equal(pending.enabled, false);
  assert.equal(
    s.store.oidcUser(
      "https://issuer.example",
      "subject-1",
      "changed@example.com",
      "New",
    ).id,
    pending.id,
  );
  assert.throws(() =>
    s.store.oidcUser(
      "https://issuer.example",
      "subject-2",
      "new@example.com",
      "Imposter",
    ),
  );
});
