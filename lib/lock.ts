import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// The lock is an SQLite file held with an exclusive lock for the life of the
// process. The operating system releases it when the process exits, even after
// a crash, so a stale lock never blocks a restore.
export const lockPath = (database: string) => `${database}.lock`;

export function acquireServiceLock(database: string) {
  if (database === ":memory:") return { release() {} };
  const file = lockPath(database);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file, { timeout: 0 });
  chmodSync(file, 0o600);
  try {
    db.exec(
      "PRAGMA journal_mode=OFF; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;",
    );
  } catch {
    db.close();
    throw new Error(
      `Another Proxdesk process is using ${database}. Stop it first.`,
    );
  }
  return { release: () => db.close() };
}
