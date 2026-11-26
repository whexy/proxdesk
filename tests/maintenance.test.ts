import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireServiceLock } from "../lib/lock";
import {
  backupDatabase,
  createAdmin,
  migrateDatabase,
  restoreDatabase,
} from "../lib/maintenance";
import { Store, schemaVersion, userVersion } from "../lib/store";

const tempDir = () => mkdtempSync(join(tmpdir(), "proxdesk-maint-"));

function seeded(dir: string, email = "first@example.com") {
  const database = join(dir, "proxdesk.sqlite");
  const store = new Store(database);
  store.createUser({
    email,
    name: "First Admin",
    role: "admin",
    enabled: true,
    password: "first-password-123",
  });
  return { database, store };
}

test("backup snapshots a database in use without overwriting files", () => {
  const dir = tempDir();
  const { database, store } = seeded(dir);
  const target = join(dir, "backup.sqlite");
  backupDatabase(database, target);
  assert.equal(statSync(target).mode & 0o777, 0o600);
  const copy = new Store(target);
  assert.equal(copy.findEmail("first@example.com")?.name, "First Admin");
  copy.close();
  assert.throws(() => backupDatabase(database, target), /already exists/);
  assert.throws(
    () => backupDatabase(join(dir, "missing.sqlite"), join(dir, "x.sqlite")),
    /No database/,
  );
  assert.equal(existsSync(join(dir, "x.sqlite")), false);
  store.close();
});

test("restore replaces a stopped database and keeps the previous one", () => {
  const dir = tempDir();
  const { database, store } = seeded(dir);
  const backup = join(dir, "backup.sqlite");
  backupDatabase(database, backup);
  store.createUser({
    email: "later@example.com",
    name: "Later",
    role: "member",
    enabled: true,
  });
  store.close();

  const { previous } = restoreDatabase(
    database,
    backup,
    new Date("2026-01-02T03:04:05.678Z"),
  );
  assert.equal(previous, `${database}.pre-restore-2026-01-02T03-04-05-678Z`);
  assert.equal(existsSync(`${database}-wal`), false);
  const restored = new Store(database);
  assert.equal(restored.findEmail("later@example.com"), undefined);
  assert.ok(restored.findEmail("first@example.com"));
  restored.close();
  assert.equal(statSync(database).mode & 0o777, 0o600);
  const kept = new Store(previous!);
  assert.ok(kept.findEmail("later@example.com"));
  kept.close();
});

test("the restore staging copy is private before it holds data", () => {
  const dir = tempDir();
  const { database, store } = seeded(dir);
  const backup = join(dir, "backup.sqlite");
  backupDatabase(database, backup);
  store.close();
  writeFileSync(`${database}.restoring`, "stale");
  const prepare = DatabaseSync.prototype.prepare;
  const modes: number[] = [];
  const umask = process.umask(0);
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (!sql.startsWith("VACUUM INTO")) return statement;
    const run = statement.run.bind(statement);
    return Object.assign(statement, {
      run(target: string) {
        const result = run(target);
        modes.push(statSync(target).mode & 0o777);
        return result;
      },
    });
  } as typeof prepare;
  try {
    restoreDatabase(database, backup);
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    process.umask(umask);
  }
  assert.deepEqual(modes, [0o600]);
  assert.equal(existsSync(`${database}.restoring`), false);
});

test("restore refuses while the service holds the lock", () => {
  const dir = tempDir();
  const { database, store } = seeded(dir);
  const backup = join(dir, "backup.sqlite");
  backupDatabase(database, backup);
  const lock = acquireServiceLock(database);
  try {
    assert.throws(() => restoreDatabase(database, backup), /Stop it first/);
    assert.throws(() => acquireServiceLock(database), /Stop it first/);
  } finally {
    lock.release();
  }
  store.close();
  restoreDatabase(database, backup);
});

test("restore rejects files that are not compatible Proxdesk databases", () => {
  const dir = tempDir();
  const database = join(dir, "proxdesk.sqlite");
  new Store(database).close();
  const before = readdirSync(dir).sort();

  const junk = join(dir, "junk.sqlite");
  writeFileSync(junk, "definitely not sqlite, padded to look like a page".repeat(100));
  assert.throws(() => restoreDatabase(database, junk), /not an SQLite database/);

  const other = join(dir, "other.sqlite");
  const db = new DatabaseSync(other);
  db.exec("CREATE TABLE notes (x)");
  db.close();
  assert.throws(() => restoreDatabase(database, other), /not a Proxdesk database/);

  const newer = join(dir, "newer.sqlite");
  backupDatabase(database, newer);
  const n = new DatabaseSync(newer);
  n.exec(`PRAGMA user_version=${schemaVersion + 1}`);
  n.close();
  assert.throws(() => restoreDatabase(database, newer), /newer than this Proxdesk/);
  assert.throws(() => restoreDatabase(database, join(dir, "none")), /No backup/);

  const after = readdirSync(dir)
    .filter((f) => !["junk.sqlite", "other.sqlite", "newer.sqlite"].includes(f))
    .sort();
  assert.deepEqual(after, before);
});

test("create-admin adds an enabled administrator with a strong password", () => {
  const dir = tempDir();
  const database = join(dir, "proxdesk.sqlite");
  const admin = createAdmin(database, {
    email: "Ops@Example.com",
    name: "Ops",
    password: "operator-password-1",
  });
  assert.equal(admin.email, "ops@example.com");
  assert.equal(admin.role, "admin");
  const store = new Store(database);
  assert.equal(
    store.authenticate("ops@example.com", "operator-password-1")?.id,
    admin.id,
  );
  assert.equal(store.audits(admin)[0]?.action, "Created administrator");
  store.close();
  assert.equal(
    createAdmin(database, { email: "b@example.com", password: "another-password" })
      .name,
    "Administrator",
  );
  assert.throws(
    () => createAdmin(database, { email: "ops@example.com", password: "x".repeat(12) }),
    /already exists/,
  );
  assert.throws(
    () => createAdmin(database, { email: "c@example.com", password: "short" }),
    /at least 12/,
  );
  assert.throws(
    () => createAdmin(database, { email: "not-an-email", password: "x".repeat(12) }),
    /email/i,
  );
});

test("migrate upgrades a legacy database and reports the versions", () => {
  const dir = tempDir();
  const database = join(dir, "proxdesk.sqlite");
  const legacy = new DatabaseSync(database);
  legacy.exec(
    "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL, enabled INTEGER NOT NULL, password TEXT, oidc_issuer TEXT, oidc_subject TEXT, UNIQUE(oidc_issuer, oidc_subject)); CREATE TABLE agent_sessions (id TEXT)",
  );
  legacy.close();
  assert.deepEqual(migrateDatabase(database), { from: 0, to: schemaVersion });
  assert.deepEqual(migrateDatabase(database), {
    from: schemaVersion,
    to: schemaVersion,
  });
  const db = new DatabaseSync(database);
  assert.equal(userVersion(db), schemaVersion);
  db.close();
  assert.deepEqual(migrateDatabase(join(dir, "fresh", "new.sqlite")), {
    from: 0,
    to: schemaVersion,
  });
});
