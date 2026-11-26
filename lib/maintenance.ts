import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  existsSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { z } from "zod";
import { acquireServiceLock } from "./lock";
import { Store, schemaVersion, userVersion } from "./store";

type Row = Record<string, any>;
const requiredTables = ["users", "sessions", "grants", "operations", "audit"];

export function backupDatabase(database: string, target: string) {
  if (!existsSync(database)) throw new Error(`No database at ${database}`);
  // Creating the empty target exclusively refuses to overwrite and sets the
  // mode before any data is written; VACUUM INTO accepts an empty file.
  try {
    closeSync(openSync(target, "wx", 0o600));
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST")
      throw new Error(`${target} already exists; choose a new file`);
    throw error;
  }
  const db = new DatabaseSync(database, { timeout: 5000 });
  try {
    db.prepare("VACUUM INTO ?").run(target);
  } catch (error) {
    unlinkSync(target);
    throw error;
  } finally {
    db.close();
  }
}

export function validateBackup(file: string) {
  if (!existsSync(file)) throw new Error(`No backup at ${file}`);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    let integrity: unknown;
    try {
      integrity = (db.prepare("PRAGMA quick_check").get() as Row).quick_check;
    } catch {
      throw new Error(`${file} is not an SQLite database`);
    }
    if (integrity !== "ok")
      throw new Error(`${file} failed the SQLite integrity check`);
    const version = userVersion(db);
    if (version > schemaVersion)
      throw new Error(
        `${file} has schema version ${version}, newer than this Proxdesk release supports (${schemaVersion})`,
      );
    const tables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as Row[]
      ).map((row) => row.name),
    );
    const missing = requiredTables.filter((name) => !tables.has(name));
    if (missing.length)
      throw new Error(
        `${file} is not a Proxdesk database (missing ${missing.join(", ")})`,
      );
    return version;
  } finally {
    db.close();
  }
}

export function restoreDatabase(
  database: string,
  backup: string,
  now = new Date(),
) {
  validateBackup(backup);
  const lock = acquireServiceLock(database);
  try {
    const staging = `${database}.restoring`;
    rmSync(staging, { force: true });
    // As in backupDatabase, the copy must never exist with the umask's mode.
    closeSync(openSync(staging, "wx", 0o600));
    // VACUUM INTO also captures a source that still has its own -wal file.
    const source = new DatabaseSync(backup, { readOnly: true });
    try {
      source.prepare("VACUUM INTO ?").run(staging);
    } catch (error) {
      rmSync(staging, { force: true });
      throw error;
    } finally {
      source.close();
    }
    let previous: string | undefined;
    if (existsSync(database)) {
      // Fold committed WAL content into the main file so the kept copy is complete.
      const current = new DatabaseSync(database);
      current.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      current.close();
      previous = `${database}.pre-restore-${now.toISOString().replace(/[:.]/g, "-")}`;
      renameSync(database, previous);
    }
    for (const suffix of ["-wal", "-shm", "-journal"])
      rmSync(database + suffix, { force: true });
    renameSync(staging, database);
    new Store(database).close();
    return { previous };
  } finally {
    lock.release();
  }
}

const adminInput = z.object({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(100).default("Administrator"),
  password: z
    .string()
    .min(12, "The password must be at least 12 characters")
    .max(256, "The password must be at most 256 characters"),
});
export function createAdmin(
  database: string,
  input: { email: string; name?: string; password: string },
) {
  const parsed = adminInput.safeParse(input);
  if (!parsed.success)
    throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
  const { email, name, password } = parsed.data;
  const store = new Store(database);
  try {
    if (store.findEmail(email))
      throw new Error(`An account for ${email.toLowerCase()} already exists`);
    return store.transaction(() => {
      const admin = store.createUser({
        email,
        name,
        role: "admin",
        enabled: true,
        password,
      });
      store.audit(undefined, "Created administrator", email.toLowerCase(), "Command line");
      return admin;
    });
  } finally {
    store.close();
  }
}

export function migrateDatabase(database: string) {
  let from = 0;
  if (existsSync(database)) {
    const db = new DatabaseSync(database, { timeout: 5000 });
    from = userVersion(db);
    db.close();
  }
  new Store(database).close();
  return { from, to: schemaVersion };
}
