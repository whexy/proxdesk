import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackupScheduler,
  backupName,
  listBackups,
  pruneBackups,
} from "../lib/backups";
import type { BackupSettings } from "../lib/settings";
import { Store } from "../lib/store";

const hour = 3600_000;

function setup(settings: BackupSettings) {
  const root = mkdtempSync(join(tmpdir(), "proxdesk-backups-"));
  const database = join(root, "proxdesk.sqlite");
  const store = new Store(database);
  store.createUser({
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
    enabled: true,
    password: "admin-password-1",
  });
  store.close();
  const dir = join(root, "backups");
  let now = Date.parse("2026-11-26T00:00:00.000Z");
  let tickFn: (() => void) | undefined;
  const logs: string[] = [];
  const scheduler = new BackupScheduler({
    database,
    dir,
    settings: () => settings,
    now: () => now,
    setInterval: (fn) => {
      tickFn = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => {
      tickFn = undefined;
    },
    log: (message) => logs.push(message),
    error: (message) => logs.push(message),
  });
  return {
    root,
    dir,
    database,
    scheduler,
    logs,
    advance(ms: number) {
      now += ms;
      tickFn?.();
    },
    now: () => now,
  };
}

test("backup files are named by UTC time and only those names are listed", () => {
  assert.equal(
    backupName(new Date("2026-11-26T07:08:09.010Z")),
    "proxdesk-2026-11-26T07-08-09-010Z.sqlite",
  );
  const dir = mkdtempSync(join(tmpdir(), "proxdesk-backups-"));
  for (const name of [
    "proxdesk-2026-11-25T00-00-00-000Z.sqlite",
    "proxdesk-2026-11-26T00-00-00-000Z.sqlite",
    "proxdesk-2026-11-24T00-00-00-000Z.sqlite",
    "manual-copy.sqlite",
    "proxdesk-2026-11-26T00-00-00-000Z.sqlite.tmp",
  ])
    writeFileSync(join(dir, name), "x");
  assert.deepEqual(
    listBackups(dir).map((f) => f.name),
    [
      "proxdesk-2026-11-26T00-00-00-000Z.sqlite",
      "proxdesk-2026-11-25T00-00-00-000Z.sqlite",
      "proxdesk-2026-11-24T00-00-00-000Z.sqlite",
    ],
  );
  assert.deepEqual(pruneBackups(dir, 1), [
    "proxdesk-2026-11-25T00-00-00-000Z.sqlite",
    "proxdesk-2026-11-24T00-00-00-000Z.sqlite",
  ]);
  assert.deepEqual(readdirSync(dir).sort(), [
    "manual-copy.sqlite",
    "proxdesk-2026-11-26T00-00-00-000Z.sqlite",
    "proxdesk-2026-11-26T00-00-00-000Z.sqlite.tmp",
  ]);
  assert.deepEqual(listBackups(join(dir, "missing")), []);
});

test("the scheduler backs up on start, every interval, and prunes to the retention", () => {
  const settings = { enabled: true, intervalHours: 6, retention: 2 };
  const t = setup(settings);
  t.scheduler.start();
  assert.equal(listBackups(t.dir).length, 1);
  assert.equal(statSync(t.dir).mode & 0o777, 0o700);
  const [first] = listBackups(t.dir);
  assert.equal(statSync(join(t.dir, first.name)).mode & 0o777, 0o600);
  // The schedule follows file times; pin them to the injected clock.
  const touch = () => {
    for (const file of listBackups(t.dir))
      utimesSync(join(t.dir, file.name), new Date(t.now()), new Date(t.now()));
  };
  touch();
  t.advance(5 * hour);
  assert.equal(listBackups(t.dir).length, 1);
  t.advance(1 * hour);
  touch();
  assert.equal(listBackups(t.dir).length, 2);
  t.advance(6 * hour);
  touch();
  assert.equal(listBackups(t.dir).length, 2);
  assert.ok(!listBackups(t.dir).some((f) => f.name === first.name));
  assert.equal(t.logs.filter((l) => l.startsWith("Scheduled backup written")).length, 3);

  settings.enabled = false;
  t.advance(24 * hour);
  assert.equal(t.scheduler.nextRun(), undefined);
  assert.equal(t.logs.length, 3);
  t.scheduler.stop();
});

test("after a restart the schedule continues from the newest backup", () => {
  const settings = { enabled: true, intervalHours: 24, retention: 14 };
  const t = setup(settings);
  t.scheduler.run();
  const [file] = listBackups(t.dir);
  const twoHoursAgo = new Date(t.now() - 2 * hour);
  utimesSync(join(t.dir, file.name), twoHoursAgo, twoHoursAgo);
  t.scheduler.start();
  assert.equal(listBackups(t.dir).length, 1);
  assert.equal(t.scheduler.nextRun(), t.now() + 22 * hour);
  t.advance(22 * hour);
  assert.equal(listBackups(t.dir).length, 2);
});

test("a failed backup is recorded and retried hourly, never in parallel", () => {
  const settings = { enabled: true, intervalHours: 24, retention: 14 };
  const t = setup(settings);
  // A file where the directory should be makes every attempt fail.
  writeFileSync(t.dir, "not a directory");
  t.scheduler.start();
  assert.match(t.scheduler.status.lastFailure!.error, /EEXIST|ENOTDIR/);
  assert.equal(t.logs.length, 1);
  assert.match(t.logs[0], /Scheduled backup failed/);
  t.advance(30 * 60_000);
  assert.equal(t.logs.length, 1);
  t.advance(30 * 60_000);
  assert.equal(t.logs.length, 2);

  t.scheduler.status.running = true;
  assert.throws(() => t.scheduler.run(), /already running/);
  t.advance(2 * hour);
  assert.equal(t.logs.length, 2);
});

test("ticks do nothing until the scheduler is started", () => {
  const t = setup({ enabled: true, intervalHours: 1, retention: 1 });
  t.scheduler.tick();
  assert.deepEqual(listBackups(t.dir), []);
});
