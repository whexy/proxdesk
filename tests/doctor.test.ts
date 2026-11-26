import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../lib/config";
import {
  analyzePermissions,
  doctor,
  type Permissions,
  type ProxmoxApi,
} from "../lib/doctor";
import type { SlackCall } from "../lib/chat/slack";
import { DiscordError, type DiscordRest } from "../lib/chat/discord";
import { Store } from "../lib/store";

const minimal: Permissions = {
  "/vms/104": { "VM.Audit": 1, "VM.PowerMgmt": 1, "VM.Console": 1 },
};

test("permission analysis accepts the minimal role", () => {
  const checks = analyzePermissions(minimal);
  assert.deepEqual(
    checks.map((c) => c.status),
    ["ok"],
  );
});

test("permission analysis reports missing privileges", () => {
  const checks = analyzePermissions({
    "/vms/104": { "VM.Audit": 1 },
    "/storage": { "VM.Console": 1 },
  });
  assert.equal(checks[0].status, "fail");
  assert.match(checks[0].message, /VM\.PowerMgmt, VM\.Console/);
});

test("permission analysis warns about dangerous extra privileges per path", () => {
  const checks = analyzePermissions({
    "/": { "VM.Audit": 1, "VM.PowerMgmt": 1, "VM.Console": 1, "Sys.Modify": 1 },
    "/vms": { "VM.Allocate": 1, "VM.Audit": 1 },
    "/storage/local": { "Datastore.Allocate": 1 },
  });
  assert.equal(checks[0].status, "ok");
  const warnings = checks.filter((c) => c.status === "warn");
  assert.equal(warnings.length, 3);
  assert.match(warnings.map((w) => w.message).join("\n"), /Sys\.Modify on \//);
  assert.match(warnings.map((w) => w.message).join("\n"), /VM\.Allocate on \/vms/);
  assert.match(
    warnings.map((w) => w.message).join("\n"),
    /Datastore\.Allocate on \/storage\/local/,
  );
});

function liveConfig(overrides: Partial<Config> = {}): Config {
  const database = join(mkdtempSync(join(tmpdir(), "proxdesk-doctor-")), "db.sqlite");
  const store = new Store(database);
  store.createUser({
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
    enabled: true,
    password: "admin-password-1",
  });
  store.close();
  return {
    demo: false,
    origin: "https://portal.example",
    database,
    secureCookies: true,
    proxmoxUrl: "https://pve.example:8006",
    tokenId: "proxdesk@pve!portal",
    tokenSecret: "synthetic",
    ...overrides,
  };
}

function fakeProxmox(responses: Record<string, unknown | Error>): ProxmoxApi {
  return {
    async request<T>(path: string) {
      const value = responses[path];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`unexpected ${path}`);
      return value as T;
    },
  };
}

const healthy = {
  "/version": { version: "8.4.1" },
  "/access/permissions": minimal,
  "/cluster/resources?type=vm": [{ type: "qemu", vmid: 104 }],
};

test("doctor passes a healthy deployment", async () => {
  const checks = await doctor({
    config: () => liveConfig(),
    proxmox: () => fakeProxmox(healthy),
  });
  assert.deepEqual(
    checks.filter((c) => c.status !== "ok"),
    [],
  );
  assert.match(checks.map((c) => c.message).join("\n"), /version 8\.4\.1/);
});

test("doctor explains an untrusted Proxmox certificate", async () => {
  const cause = Object.assign(new Error("self-signed certificate"), {
    code: "DEPTH_ZERO_SELF_SIGNED_CERT",
  });
  const presented = Array(32).fill("AB").join(":");
  const checks = await doctor({
    config: () => liveConfig(),
    proxmox: () =>
      fakeProxmox({ "/version": new Error("Cannot reach Proxmox.", { cause }) }),
    fingerprint: async () => presented,
  });
  assert.match(checks.map((c) => c.message).join("\n"), /TLS trust: system trust store/);
  const failure = checks.find((c) => c.status === "fail")!;
  assert.match(failure.message, /DEPTH_ZERO_SELF_SIGNED_CERT/);
  assert.ok(failure.message.includes(`PROXMOX_FINGERPRINT=${presented}`));
  assert.match(failure.message, /PROXMOX_CA_FILE/);

  const unreachable = await doctor({
    config: () => liveConfig(),
    proxmox: () =>
      fakeProxmox({ "/version": new Error("Cannot reach Proxmox.", { cause }) }),
    fingerprint: async () => {
      throw new Error("connection refused");
    },
  });
  assert.match(
    unreachable.find((c) => c.status === "fail")!.message,
    /set PROXMOX_CA_FILE .* or pin it with PROXMOX_FINGERPRINT/i,
  );
});

test("doctor reports invalid configuration and a missing administrator", async () => {
  const invalid = await doctor({
    config: () => {
      throw new Error("PROXMOX_URL must use HTTPS");
    },
  });
  assert.deepEqual(invalid.map((c) => c.status), ["fail"]);

  // A chat-only administrator left by an older release cannot sign in.
  const empty = join(mkdtempSync(join(tmpdir(), "proxdesk-doctor-")), "db.sqlite");
  const chatOnly = new Store(empty);
  chatOnly.db
    .prepare("INSERT INTO users (id,email,name,role,enabled) VALUES ('c',NULL,'Chat','admin',1)")
    .run();
  chatOnly.close();
  const checks = await doctor({
    config: () => liveConfig({ database: empty }),
    proxmox: () => fakeProxmox(healthy),
  });
  assert.match(
    checks.find((c) => c.status === "fail")!.message,
    /create-admin/,
  );

  // Without a bootstrap administrator the first start would fail too.
  const missing = join(mkdtempSync(join(tmpdir(), "proxdesk-doctor-")), "db.sqlite");
  const fresh = await doctor({
    config: () => liveConfig({ database: missing }),
    proxmox: () => fakeProxmox(healthy),
  });
  const database = fresh.find((c) => c.message.includes(missing))!;
  assert.equal(database.status, "fail");
  assert.match(database.message, /BOOTSTRAP_ADMIN_EMAIL.*create-admin/);
  const bootstrapped = await doctor({
    config: () =>
      liveConfig({
        database: missing,
        bootstrapEmail: "admin@example.com",
        bootstrapPassword: "admin-password-1",
      }),
    proxmox: () => fakeProxmox(healthy),
  });
  const ready = bootstrapped.find((c) => c.message.includes(missing))!;
  assert.equal(ready.status, "warn");
  assert.match(ready.message, /the first start creates it/);
});

test("doctor checks the Slack tokens and channel membership", async () => {
  const slack = {
    appToken: "xapp-test",
    botToken: "xoxb-test",
    channels: ["C0123456789", "G0PRIVATE"],
  };
  const calls: string[] = [];
  const member = (isMember: boolean): SlackCall =>
    async (token, method) => {
      calls.push(`${token}:${method}`);
      if (method === "auth.test") return { ok: true, user: "proxdesk", team: "Acme" };
      if (method === "apps.connections.open") return { ok: true, url: "wss://x" };
      return { ok: true, channel: { name: "servers", is_member: isMember } };
    };
  const good = await doctor({
    config: () => liveConfig({ slack }),
    proxmox: () => fakeProxmox(healthy),
    slackCall: member(true),
  });
  assert.deepEqual(good.filter((c) => c.status !== "ok"), []);
  assert.deepEqual(calls, [
    "xoxb-test:auth.test",
    "xapp-test:apps.connections.open",
    "xoxb-test:conversations.info",
    "xoxb-test:conversations.info",
  ]);
  const outside = await doctor({
    config: () => liveConfig({ slack }),
    proxmox: () => fakeProxmox(healthy),
    slackCall: member(false),
  });
  assert.match(outside.find((c) => c.status === "fail")!.message, /Invite it/);
  const revoked = await doctor({
    config: () => liveConfig({ slack }),
    proxmox: () => fakeProxmox(healthy),
    slackCall: async () => {
      throw new Error("Slack auth.test failed: invalid_auth");
    },
  });
  assert.deepEqual(
    revoked.filter((c) => c.status === "fail").map((c) => c.message),
    ["SLACK_BOT_TOKEN: Slack auth.test failed: invalid_auth"],
  );
});

test("doctor checks the Discord token and each channel", async () => {
  const discord = {
    botToken: "a.b.c",
    channels: ["123456789012345678", "223456789012345678"],
    allowDMs: false,
  };
  const paths: string[] = [];
  const rest: DiscordRest = async (_method, path) => {
    paths.push(path);
    if (path === "/users/@me") return { username: "proxdesk" } as any;
    if (path === "/channels/123456789012345678") return { name: "servers" } as any;
    throw new DiscordError(403, 50001, "Discord GET failed: 403 Missing Access");
  };
  const checks = await doctor({
    config: () => liveConfig({ discord }),
    proxmox: () => fakeProxmox(healthy),
    discordRest: rest,
  });
  assert.deepEqual(paths, ["/users/@me", "/channels/123456789012345678", "/channels/223456789012345678"]);
  assert.ok(checks.some((c) => c.status === "ok" && c.message === "Discord bot token valid (@proxdesk)"));
  assert.ok(checks.some((c) => c.status === "ok" && c.message === "Discord channel #servers reachable"));
  assert.match(
    checks.find((c) => c.status === "fail")!.message,
    /^DISCORD_CHANNEL_IDS 223456789012345678: .*Missing Access\. Invite the bot/,
  );
  const revoked = await doctor({
    config: () => liveConfig({ discord }),
    proxmox: () => fakeProxmox(healthy),
    discordRest: async () => {
      throw new DiscordError(401, 0, "Discord GET /users/@me failed: 401 Unauthorized");
    },
  });
  assert.deepEqual(
    revoked.filter((c) => c.status === "fail").map((c) => c.message),
    ["DISCORD_BOT_TOKEN: Discord GET /users/@me failed: 401 Unauthorized"],
  );
});

test("doctor counts the VMs inside the stored managed scope", async () => {
  const config = liveConfig({
    proxmoxFingerprint: Array(32).fill("0A").join(":"),
  });
  const store = new Store(config.database);
  store.updateSettings({ scope: { type: "pool", pool: "lab" } });
  store.close();
  const resources = [
    { type: "qemu", vmid: 104, pool: "lab" },
    { type: "qemu", vmid: 105, pool: "other" },
    { type: "qemu", vmid: 106 },
  ];
  const checks = await doctor({
    config: () => config,
    proxmox: () =>
      fakeProxmox({ ...healthy, "/cluster/resources?type=vm": resources }),
  });
  const text = checks.map((c) => c.message).join("\n");
  assert.match(text, /TLS trust: pinned certificate fingerprint 0A:0A/);
  assert.match(text, /can see 3 QEMU VMs; 1 in scope \(VMs in pool lab\)/);

  const empty = new Store(config.database);
  empty.updateSettings({ scope: { type: "tag", tag: "missing" } });
  empty.close();
  const none = await doctor({
    config: () => config,
    proxmox: () =>
      fakeProxmox({ ...healthy, "/cluster/resources?type=vm": resources }),
  });
  assert.equal(
    none.find((c) => c.message.includes("in scope"))?.status,
    "warn",
  );
});
