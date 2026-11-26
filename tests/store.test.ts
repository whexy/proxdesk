import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Store,
  chatActions,
  migrate,
  migrations,
  schemaVersion,
  userVersion,
} from "../lib/store";

const tempDb = () =>
  join(mkdtempSync(join(tmpdir(), "proxdesk-store-")), "test.sqlite");
const schema = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();

const legacySchema = `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL, enabled INTEGER NOT NULL, password TEXT, oidc_issuer TEXT, oidc_subject TEXT, UNIQUE(oidc_issuer, oidc_subject));
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS grants (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, vm_id INTEGER NOT NULL, permissions TEXT NOT NULL, PRIMARY KEY(user_id, vm_id));
  CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, vm_id INTEGER NOT NULL, vm_name TEXT NOT NULL, user_id TEXT NOT NULL, user_name TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, task TEXT, node TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS one_active_operation ON operations(vm_id) WHERE status IN ('pending','running');
  CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, user_id TEXT, user_name TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS oidc_flows (state TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS slack_bindings (slack_user_id TEXT PRIMARY KEY, slack_name TEXT NOT NULL, vm_id INTEGER NOT NULL, created_at TEXT NOT NULL);`;

test("a fresh database receives every migration", () => {
  const store = new Store(tempDb());
  assert.equal(userVersion(store.db), schemaVersion);
  const reference = new DatabaseSync(":memory:");
  reference.exec(legacySchema);
  for (const migration of migrations.slice(1)) migration(reference);
  assert.deepEqual(schema(store.db), schema(reference));
  store.close();
});

test("a migration another process applied first is skipped", () => {
  const file = tempDb();
  const setup = new DatabaseSync(file);
  setup.exec(legacySchema);
  migrations[0](setup);
  setup.exec("PRAGMA user_version=1");
  setup.close();
  // The first connection reads version 1; a second process migrates the
  // file before the first one takes the write lock.
  const db = new DatabaseSync(file, { timeout: 5000 });
  let raced = false;
  const racing = new Proxy(db, {
    get(target, prop) {
      if (prop === "exec")
        return (sql: string) => {
          if (!raced && sql === "BEGIN IMMEDIATE") {
            raced = true;
            new Store(file).close();
          }
          return target.exec(sql);
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  assert.deepEqual(migrate(racing), { from: 1, to: schemaVersion });
  assert.ok(raced);
  assert.equal(userVersion(db), schemaVersion);
  db.close();
});

test("settings fall back to defaults per key and record only real changes", () => {
  const store = new Store(tempDb());
  assert.deepEqual(store.settings(), {
    workspaceName: "Proxdesk",
    scope: { type: "all" },
    backups: { enabled: true, intervalHours: 24, retention: 14 },
  });
  const first = store.updateSettings({
    workspaceName: "  Lab  ",
    backups: { retention: 3 },
  });
  assert.deepEqual(first.changed, ["workspaceName", "backups"]);
  assert.equal(store.settings().workspaceName, "Lab");
  assert.deepEqual(store.settings().backups, {
    enabled: true,
    intervalHours: 24,
    retention: 3,
  });
  assert.deepEqual(store.updateSettings({ workspaceName: "Lab" }).changed, []);
  assert.throws(() => store.updateSettings({ workspaceName: "" }));
  store.db
    .prepare("UPDATE settings SET value=? WHERE key='backups'")
    .run('{"enabled":"yes"}');
  store.db
    .prepare("INSERT INTO settings VALUES ('scope', 'not json')")
    .run();
  assert.deepEqual(store.settings().backups.retention, 14);
  assert.deepEqual(store.settings().scope, { type: "all" });
  assert.equal(store.settings().workspaceName, "Lab");
  store.close();
});

test("a database created before versioning keeps its data", () => {
  const file = tempDb();
  const legacy = new DatabaseSync(file);
  legacy.exec(legacySchema);
  legacy.exec(
    "CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
  );
  legacy
    .prepare("INSERT INTO users VALUES (?,?,?,?,?,?,?,?)")
    .run("u1", "old@example.com", "Old Admin", "admin", 1, "x:y", null, null);
  legacy.prepare("INSERT INTO grants VALUES (?,?,?)").run("u1", 104, '["view"]');
  legacy
    .prepare("INSERT INTO slack_bindings VALUES (?,?,?,?)")
    .run("U1", "Old", 104, "2026-01-01T00:00:00.000Z");
  legacy.close();

  const store = new Store(file);
  assert.equal(userVersion(store.db), schemaVersion);
  assert.equal(store.findEmail("old@example.com")?.name, "Old Admin");
  assert.deepEqual(store.grants("u1"), [
    { userId: "u1", vmId: 104, permissions: ["view"] },
  ]);
  const identity = store.chatIdentity("slack", "U1")!;
  assert.equal(store.getUser(identity.userId)?.name, "Old");
  assert.equal(
    store.db
      .prepare("SELECT name FROM sqlite_master WHERE name='agent_sessions'")
      .get(),
    undefined,
  );
  store.close();
  const reopened = new Store(file);
  assert.equal(reopened.users().length, 2);
  reopened.close();
});

test("a database from a newer release is refused unchanged", () => {
  const file = tempDb();
  const newer = new DatabaseSync(file);
  newer.exec(`CREATE TABLE future (x); PRAGMA user_version=${schemaVersion + 1}`);
  newer.close();
  assert.throws(() => new Store(file), /newer than this Proxdesk release/);
  const check = new DatabaseSync(file);
  assert.equal(userVersion(check), schemaVersion + 1);
  assert.equal(
    check.prepare("SELECT name FROM sqlite_master WHERE name='users'").get(),
    undefined,
  );
  check.close();
});

test("Slack bindings become chat-only members without disturbing other rows", () => {
  const file = tempDb();
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(legacySchema);
  migrations[0](db);
  migrations[1](db);
  db.exec("PRAGMA user_version=2");
  db.prepare("INSERT INTO users VALUES (?,?,?,?,?,?,?,?)").run(
    "web",
    "web@example.com",
    "Web Person",
    "member",
    1,
    "x:y",
    null,
    null,
  );
  db.prepare("INSERT INTO sessions VALUES (?,?,?)").run("t", "web", Date.now() + 60_000);
  db.prepare("INSERT INTO grants VALUES (?,?,?)").run("web", 117, '["view","console"]');
  db.prepare("INSERT INTO slack_bindings VALUES (?,?,?,?)").run(
    "U0DANG",
    "Dang Le",
    104,
    "2026-01-01T00:00:00.000Z",
  );
  db.prepare("INSERT INTO slack_bindings VALUES (?,?,?,?)").run(
    "U0MAYA",
    "Maya",
    132,
    "2026-02-01T00:00:00.000Z",
  );
  db.close();

  const store = new Store(file);
  assert.equal(userVersion(store.db), schemaVersion);
  assert.equal(
    (store.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
      .foreign_keys,
    1,
  );
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM sessions").get()!.n,
    1,
  );
  assert.deepEqual(store.grants("web"), [
    { userId: "web", vmId: 117, permissions: ["view", "console"] },
  ]);
  assert.equal(
    store.db
      .prepare("SELECT name FROM sqlite_master WHERE name='slack_bindings'")
      .get(),
    undefined,
  );
  const dang = store.chatIdentity("slack", "U0DANG")!;
  assert.equal(dang.displayName, "Dang Le");
  assert.equal(dang.createdAt, "2026-01-01T00:00:00.000Z");
  const member = store.getUser(dang.userId)!;
  assert.deepEqual(
    { email: member.email, name: member.name, role: member.role, enabled: member.enabled },
    { email: null, name: "Dang Le", role: "member", enabled: true },
  );
  assert.deepEqual(store.grants(member.id), [
    { userId: member.id, vmId: 104, permissions: chatActions },
  ]);
  assert.notEqual(store.chatIdentity("slack", "U0MAYA")!.userId, member.id);
  // Chat-only members share the empty email; real emails stay unique.
  assert.throws(() =>
    store.createUser({ email: "web@example.com", name: "Dup", role: "member", enabled: true }),
  );
  // Deleting the account still removes its identity.
  store.db.prepare("DELETE FROM users WHERE id=?").run(member.id);
  assert.equal(store.chatIdentity("slack", "U0DANG"), undefined);
  store.close();
});

test("link codes are single use, stored hashed, and expire", () => {
  const store = new Store(tempDb());
  const code = store.createLinkCode("slack", "U1", "One", "one");
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM chat_link_codes WHERE code=?").get(code)!.n,
    0,
  );
  assert.equal(store.linkCode(code)?.userRef, "U1");
  const newer = store.createLinkCode("slack", "U1", "One", "one");
  assert.equal(store.linkCode(code), undefined);
  assert.equal(store.deleteLinkCode(newer), true);
  assert.equal(store.deleteLinkCode(newer), false);
  const expired = store.createLinkCode("slack", "U2", "Two", "two");
  store.db.prepare("UPDATE chat_link_codes SET expires=?").run(Date.now() - 1);
  assert.equal(store.linkCode(expired), undefined);
  store.close();
});
