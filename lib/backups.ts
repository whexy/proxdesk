import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { backupDatabase } from "./maintenance";
import type { BackupSettings } from "./settings";

export const backupPattern =
  /^proxdesk-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sqlite$/;
export const backupName = (date: Date) =>
  `proxdesk-${date.toISOString().replace(/[:.]/g, "-")}.sqlite`;

export type BackupFile = { name: string; size: number; modifiedAt: string };
export type BackupStatus = {
  running: boolean;
  lastSuccess?: { at: string; file: string };
  lastFailure?: { at: string; error: string };
};

/** Newest first. Only files Proxdesk names itself are listed, so pruning never touches anything else. */
export function listBackups(dir: string): BackupFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => backupPattern.test(name))
    .sort()
    .reverse()
    .flatMap((name) => {
      try {
        const stat = statSync(join(dir, name));
        return stat.isFile()
          ? [{ name, size: stat.size, modifiedAt: stat.mtime.toISOString() }]
          : [];
      } catch {
        return [];
      }
    });
}

export function pruneBackups(dir: string, retention: number) {
  const removed: string[] = [];
  for (const file of listBackups(dir).slice(retention)) {
    unlinkSync(join(dir, file.name));
    removed.push(file.name);
  }
  return removed;
}

const minute = 60_000;
// A failed backup is retried at most hourly rather than on every tick.
const retryDelay = 60 * minute;

export class BackupScheduler {
  status: BackupStatus = { running: false };
  private timer?: ReturnType<typeof setInterval>;
  private retryAfter = 0;
  constructor(
    private deps: {
      database: string;
      dir: string;
      settings: () => BackupSettings;
      now?: () => number;
      setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
      clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
      log?: (message: string) => void;
      error?: (message: string) => void;
    },
  ) {}
  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  start() {
    if (this.timer) return;
    this.timer = (this.deps.setInterval ?? setInterval)(
      () => this.tick(),
      minute,
    );
    this.timer.unref?.();
    this.tick();
  }
  stop() {
    if (this.timer) (this.deps.clearInterval ?? clearInterval)(this.timer);
    this.timer = undefined;
  }
  files() {
    return listBackups(this.deps.dir);
  }
  /** When the next scheduled backup is due, or undefined when scheduling is off. */
  nextRun() {
    const settings = this.deps.settings();
    if (!settings.enabled) return undefined;
    // Basing the schedule on the newest file carries it across restarts.
    const newest = this.files()[0];
    const due = newest
      ? Date.parse(newest.modifiedAt) + settings.intervalHours * 3600_000
      : 0;
    return Math.max(due, this.retryAfter);
  }
  /** Runs a scheduled backup when one is due; does nothing until start(). */
  tick() {
    if (!this.timer || this.status.running || this.now() < this.retryAfter)
      return;
    try {
      const next = this.nextRun();
      if (next === undefined || next > this.now()) return;
      const { file } = this.run();
      (this.deps.log ?? console.log)(`Scheduled backup written to ${file}`);
    } catch (error) {
      const message = (error as Error).message;
      this.status.lastFailure = {
        at: new Date(this.now()).toISOString(),
        error: message,
      };
      this.retryAfter = this.now() + retryDelay;
      (this.deps.error ?? console.error)(`Scheduled backup failed: ${message}`);
    }
  }
  run() {
    if (this.status.running) throw new Error("A backup is already running");
    this.status.running = true;
    const at = new Date(this.now());
    try {
      if (!existsSync(this.deps.database))
        throw new Error(`No database at ${this.deps.database}`);
      mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
      const file = join(this.deps.dir, backupName(at));
      backupDatabase(this.deps.database, file);
      const removed = pruneBackups(this.deps.dir, this.deps.settings().retention);
      this.status.lastSuccess = { at: at.toISOString(), file };
      this.retryAfter = 0;
      return { file, removed };
    } catch (error) {
      this.status.lastFailure = {
        at: at.toISOString(),
        error: (error as Error).message,
      };
      this.retryAfter = at.getTime() + retryDelay;
      throw error;
    } finally {
      this.status.running = false;
    }
  }
}
