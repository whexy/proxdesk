import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../lib/cli";
import { Store, chatActions } from "../lib/store";
import {
  exportConfiguration,
  formatPlan,
  importConfiguration,
  parseExport,
  type ExportFile,
} from "../lib/transfer";

const tempDb = () =>
  join(mkdtempSync(join(tmpdir(), "proxdesk-transfer-")), "proxdesk.sqlite");

function source() {
  const store = new Store(tempDb());
  const admin = store.createUser({
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
    enabled: true,
    password: "admin-password-1",
  });
  const alex = store.createUser({
    email: "alex@example.com",
    name: "Alex",
    role: "member",
    enabled: true,
    password: "alex-password-12",
  });
  const sso = store.oidcUser(
    "https://issuer.example",
    "subject-sso",
    "sso@example.com",
    "SSO Person",
  );
  store.updateUser(sso.id, { enabled: true });
  store.grant(alex.id, 104, ["console", "reboot"]);
  store.grant(sso.id, 117, ["view"]);
  const sam = store.createUser({
    email: null,
    name: "Sam",
    role: "member",
    enabled: true,
  });
  store.grant(sam.id, 120, chatActions);
  store.linkChatIdentity("slack", "U0SAM", "Sam R", sam.id);
  store.linkChatIdentity("slack", "U0ALEX", "Alex", alex.id);
  store.updateSettings({
    workspaceName: "Research Lab",
    scope: { type: "pool", pool: "students" },
    backups: { retention: 5 },
  });
  store.createSession(admin.id);
  return { store, admin, alex, sso };
}

test("an export holds configuration without passwords or sessions", () => {
  const { store } = source();
  const data = exportConfiguration(store, new Date("2026-11-26T00:00:00Z"));
  store.close();
  assert.equal(data.format, "proxdesk-export");
  assert.equal(data.version, 2);
  assert.equal(data.exportedAt, "2026-11-26T00:00:00.000Z");
  assert.equal(data.settings.workspaceName, "Research Lab");
  assert.deepEqual(
    data.users.map((u) => [
      u.email ?? ("account" in u ? u.account : ""),
      u.role,
      u.enabled,
      "oidc" in u && !!u.oidc,
    ]),
    [
      ["admin@example.com", "admin", true, false],
      ["alex@example.com", "member", true, false],
      ["sso@example.com", "member", true, true],
      ["slack:U0SAM", "member", true, false],
    ],
  );
  assert.deepEqual(data.grants, [
    {
      email: "alex@example.com",
      vmId: 104,
      permissions: ["view", "reboot", "console"],
    },
    { email: "sso@example.com", vmId: 117, permissions: ["view"] },
    { account: "slack:U0SAM", vmId: 120, permissions: chatActions },
  ]);
  assert.deepEqual(data.chatIdentities, [
    { platform: "slack", userRef: "U0ALEX", displayName: "Alex", email: "alex@example.com" },
    { platform: "slack", userRef: "U0SAM", displayName: "Sam R", account: "slack:U0SAM" },
  ]);
  const text = JSON.stringify(data);
  assert.ok(!/password|token|session|:[0-9a-f]{64,}/i.test(text));
});

test("importing into an empty database recreates the configuration safely", () => {
  const { store } = source();
  const data = parseExport(JSON.stringify(exportConfiguration(store)));
  store.close();
  const target = new Store(tempDb());
  const operator = target.createUser({
    email: "operator@example.com",
    name: "Operator",
    role: "admin",
    enabled: true,
    password: "operator-password",
  });

  const preview = importConfiguration(target, data, { dryRun: true });
  assert.equal(target.users().length, 1);
  assert.equal(target.settings().workspaceName, "Proxdesk");
  assert.equal(target.audits(operator).length, 0);
  const applied = importConfiguration(target, data, {
    dryRun: false,
    source: "export.json",
  });
  assert.equal(formatPlan(applied), formatPlan(preview));
  assert.match(formatPlan(applied), /create alex@example\.com \(member, disabled until an administrator sets a password\)/);
  assert.match(formatPlan(applied), /create sso@example\.com \(member, enabled, SSO\)/);
  assert.match(formatPlan(applied), /create Sam \(chat only, slack:U0SAM, member, enabled\)/);
  assert.match(formatPlan(applied), /link slack:U0ALEX \(Alex\) to alex@example\.com/);

  assert.equal(target.settings().workspaceName, "Research Lab");
  assert.deepEqual(target.settings().scope, { type: "pool", pool: "students" });
  const alex = target.findEmail("alex@example.com")!;
  assert.equal(alex.enabled, false);
  assert.equal(target.authenticate("alex@example.com", "alex-password-12"), undefined);
  // Without a password it cannot sign in, so it cannot be an administrator yet.
  const admin = target.findEmail("admin@example.com")!;
  assert.equal(admin.role, "member");
  assert.equal(admin.enabled, false);
  assert.match(
    applied.warnings.join("\n"),
    /admin@example\.com: created as a member; it cannot sign in yet/,
  );
  const sso = target.findEmail("sso@example.com")!;
  assert.equal(sso.enabled, true);
  assert.equal(
    target.oidcUser("https://issuer.example", "subject-sso", "x@example.com", "x").id,
    sso.id,
  );
  assert.deepEqual(target.grants(alex.id), [
    { userId: alex.id, vmId: 104, permissions: ["view", "reboot", "console"] },
  ]);
  assert.equal(target.chatIdentity("slack", "U0ALEX")?.userId, alex.id);
  const sam = target.getUser(target.chatIdentity("slack", "U0SAM")!.userId)!;
  assert.equal(sam.email, null);
  assert.equal(sam.enabled, true);
  assert.deepEqual(target.grants(sam.id).map((g) => [g.vmId, g.permissions]), [
    [120, chatActions],
  ]);
  assert.equal(target.findEmail("operator@example.com")?.enabled, true);
  const audit = target.audits(operator).find((e) => e.action === "Imported configuration")!;
  assert.equal(audit.target, "export.json");

  const again = importConfiguration(target, data, { dryRun: true });
  assert.ok(again.sections.every((s) => !s.changes.length), formatPlan(again));
  target.close();
});

test("an import never makes an account that cannot sign in an administrator", () => {
  const { store, alex } = source();
  const legacy = store.createUser({ email: null, name: "Legacy", role: "member", enabled: true });
  store.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(legacy.id);
  store.linkChatIdentity("slack", "U0LEGACY", "Legacy", legacy.id);
  const noPassword = store.createUser({
    email: "nopass@example.com",
    name: "No Password",
    role: "member",
    enabled: false,
  });
  const data = exportConfiguration(store);
  const edited: ExportFile = {
    ...data,
    users: [
      ...data.users.filter((u) => u.email !== "admin@example.com"),
      { email: null, account: "slack:U0NEWADMIN", name: "New", role: "admin" as const, enabled: true },
    ].map((u) =>
      u.email === "nopass@example.com" || ("account" in u && u.account === "slack:U0SAM")
        ? { ...u, role: "admin" as const }
        : u,
    ),
    chatIdentities: [
      ...data.chatIdentities,
      { platform: "slack", userRef: "U0NEWADMIN", displayName: "New", account: "slack:U0NEWADMIN" },
    ],
  };
  const plan = importConfiguration(store, parseExport(JSON.stringify(edited)), {
    dryRun: false,
  });
  const warnings = plan.warnings.join("\n");
  assert.match(warnings, /nopass@example\.com: kept as a member; it cannot sign in yet/);
  assert.match(warnings, /slack:U0SAM: imported as a member/);
  assert.match(warnings, /slack:U0NEWADMIN: imported as a member/);
  assert.match(warnings, /slack:U0LEGACY: imported as a member/);
  assert.equal(store.getUser(noPassword.id)?.role, "member");
  assert.equal(store.getUser(legacy.id)?.role, "member");
  assert.equal(store.getUser(store.chatIdentity("slack", "U0SAM")!.userId)?.role, "member");
  assert.equal(store.getUser(store.chatIdentity("slack", "U0NEWADMIN")!.userId)?.role, "member");
  assert.equal(store.getUser(alex.id)?.role, "member");
  store.close();
});

test("an import updates existing users, replaces their grants, and keeps an administrator", () => {
  const { store, admin, alex } = source();
  const data = exportConfiguration(store);
  const edited: ExportFile = {
    ...data,
    users: [
      { email: "admin@example.com", name: "Admin", role: "member", enabled: true },
      { email: "alex@example.com", name: "Alex Chen", role: "member", enabled: false },
    ],
    grants: [{ email: "alex@example.com", vmId: 132, permissions: ["view"] }],
    chatIdentities: [
      { platform: "slack", userRef: "U0ALEX", displayName: "Alex C", email: "alex@example.com" },
    ],
  };
  const plan = importConfiguration(store, parseExport(JSON.stringify(edited)), {
    dryRun: false,
  });
  assert.match(plan.warnings.join("\n"), /admin@example\.com: kept as an enabled administrator/);
  assert.equal(store.getUser(admin.id)?.role, "admin");
  assert.equal(store.getUser(alex.id)?.name, "Alex Chen");
  assert.equal(store.getUser(alex.id)?.enabled, false);
  assert.deepEqual(
    store.grants(alex.id).map((g) => g.vmId),
    [132],
  );
  const sso = store.findEmail("sso@example.com")!;
  assert.deepEqual(store.grants(sso.id).map((g) => g.vmId), [117]);
  assert.equal(store.chatIdentity("slack", "U0ALEX")?.displayName, "Alex C");
  assert.match(formatPlan(plan), /slack:U0ALEX: name Alex → Alex C/);
  assert.match(formatPlan(plan), /alex@example\.com: VM 104 \(view, reboot, console\) → VM 132 \(view\)/);

  // Handing the role to a new SSO administrator lets the old one be demoted.
  const handover: ExportFile = {
    ...data,
    users: [
      { email: "admin@example.com", name: "Admin", role: "member", enabled: true },
      {
        email: "new-admin@example.com",
        name: "New",
        role: "admin",
        enabled: true,
        oidc: { issuer: "https://issuer.example", subject: "subject-new" },
      },
    ],
    grants: [],
    chatIdentities: [],
  };
  const result = importConfiguration(store, handover, { dryRun: false });
  assert.deepEqual(result.warnings, []);
  assert.equal(store.getUser(admin.id)?.role, "member");
  store.close();
});

test("invalid or foreign files are rejected before anything changes", () => {
  assert.throws(() => parseExport("{"), /not valid JSON/);
  assert.throws(() => parseExport('{"format":"other"}'), /not a Proxdesk export/);
  assert.throws(
    () => parseExport('{"format":"proxdesk-export","version":3}'),
    /export version 3/,
  );
  const base = {
    format: "proxdesk-export",
    version: 1,
    exportedAt: "2026-11-26T00:00:00Z",
    settings: {},
    users: [{ email: "a@example.com", name: "A", role: "member", enabled: true }],
    grants: [],
    slackBindings: [],
  };
  assert.ok(parseExport(JSON.stringify(base)));
  assert.throws(
    () =>
      parseExport(
        JSON.stringify({
          ...base,
          grants: [{ email: "b@example.com", vmId: 1, permissions: ["view"] }],
        }),
      ),
    /no matching user/,
  );
  assert.throws(
    () => parseExport(JSON.stringify({ ...base, users: [...base.users, ...base.users] })),
    /Duplicate user/,
  );
  assert.throws(
    () =>
      parseExport(
        JSON.stringify({ ...base, settings: { scope: { type: "pool" } } }),
      ),
    /settings\.scope/,
  );
  const v2 = {
    ...base,
    version: 2,
    slackBindings: undefined,
    users: [
      ...base.users,
      { email: null, account: "slack:U0SAM", name: "Sam", role: "member", enabled: true },
    ],
    chatIdentities: [
      { platform: "slack", userRef: "U0SAM", displayName: "Sam", account: "slack:U0SAM" },
    ],
  };
  assert.ok(parseExport(JSON.stringify(v2)));
  assert.throws(
    () => parseExport(JSON.stringify({ ...v2, chatIdentities: [] })),
    /Chat-only user slack:U0SAM has no chat identity/,
  );
  assert.throws(
    () =>
      parseExport(
        JSON.stringify({
          ...v2,
          chatIdentities: [
            ...v2.chatIdentities,
            { platform: "slack", userRef: "U0X", displayName: "X", email: "b@example.com" },
          ],
        }),
      ),
    /no matching user b@example\.com/,
  );
  assert.throws(
    () =>
      parseExport(
        JSON.stringify({
          ...v2,
          users: [...v2.users, { email: null, name: "No key", role: "member", enabled: true }],
        }),
      ),
    /users/,
  );
});

test("a version 1 file's Slack links import as chat-only members", () => {
  const store = new Store(tempDb());
  const v1 = {
    format: "proxdesk-export",
    version: 1,
    exportedAt: "2026-11-26T00:00:00Z",
    settings: {},
    users: [{ email: "a@example.com", name: "A", role: "admin", enabled: true }],
    grants: [],
    slackBindings: [
      { slackUserId: "U0DANG", slackName: "Dang", vmId: 104 },
      { slackUserId: "U0MAYA", slackName: "Maya", vmId: 132 },
    ],
  };
  const data = parseExport(JSON.stringify(v1));
  assert.equal(data.version, 2);
  const plan = importConfiguration(store, data, { dryRun: false });
  assert.match(formatPlan(plan), /create Dang \(chat only, slack:U0DANG, member, enabled\)/);
  const dang = store.getUser(store.chatIdentity("slack", "U0DANG")!.userId)!;
  assert.equal(dang.email, null);
  assert.deepEqual(store.grants(dang.id), [
    { userId: dang.id, vmId: 104, permissions: chatActions },
  ]);
  // Importing again matches the members through their identities.
  const again = importConfiguration(store, parseExport(JSON.stringify(v1)), {
    dryRun: false,
  });
  assert.ok(again.sections.every((s) => !s.changes.length), formatPlan(again));
  assert.equal(store.users().length, 3);
  // A later file moves Maya's identity to a web account; her chat-only member is left without one.
  const v2 = exportConfiguration(store);
  const moved = {
    ...v2,
    users: v2.users.filter((u) => !("account" in u) || u.account !== "slack:U0MAYA"),
    grants: v2.grants.filter((g) => !("account" in g) || g.account !== "slack:U0MAYA"),
    chatIdentities: v2.chatIdentities.map((i) =>
      i.userRef === "U0MAYA"
        ? { platform: "slack", userRef: "U0MAYA", displayName: "Maya", email: "a@example.com" }
        : i,
    ),
  };
  const result = importConfiguration(store, parseExport(JSON.stringify(moved)), {
    dryRun: false,
  });
  assert.match(formatPlan(result), /slack:U0MAYA: Maya → a@example\.com/);
  assert.match(result.warnings.join("\n"), /Maya: this chat-only member has no chat account left/);
  store.close();
});

test("proxdesk export and import run from the command line", async () => {
  const { store } = source();
  const database = store.db.location()!;
  store.close();
  const dir = mkdtempSync(join(tmpdir(), "proxdesk-transfer-cli-"));
  const file = join(dir, "export.json");
  const log = console.log,
    error = console.error;
  const output: string[] = [];
  const before = { ...process.env };
  console.log = console.error = (...args: unknown[]) => {
    output.push(args.join(" "));
  };
  try {
    process.env.DATABASE_PATH = database;
    assert.equal(await main(["export", file]), 0);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(await main(["export", file]), 1);
    assert.equal(await main(["export", file, "extra"]), 2);
    const target = tempDb();
    process.env.DATABASE_PATH = target;
    new Store(target).close();
    output.length = 0;
    assert.equal(await main(["import", file]), 0);
    assert.match(output.join("\n"), /Dry run: nothing changed/);
    let check = new Store(target);
    assert.equal(check.users().length, 0);
    check.close();
    assert.equal(await main(["import", file, "--apply"]), 0);
    check = new Store(target);
    assert.equal(check.users().length, 4);
    check.close();
    assert.equal(await main(["import"]), 2);
    const junk = join(dir, "junk.json");
    writeFileSync(junk, "[]");
    assert.equal(await main(["import", junk]), 1);
  } finally {
    console.log = log;
    console.error = error;
    process.env = before;
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(parsed.format, "proxdesk-export");
});
