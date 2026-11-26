import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { configFromEnv, type Config } from "./config";
import { BackupScheduler } from "./backups";
import { checkProxmox, type Check } from "./doctor";
import { inScope } from "./settings";
import { chatActions, Store } from "./store";
import type { ChatBot } from "./chat/bot";
import {
  DemoHypervisor,
  Proxmox,
  type ConsoleConnection,
  type Hypervisor,
} from "./proxmox";
import {
  permissions,
  type Action,
  type Operation,
  type Permission,
  type User,
  type VM,
} from "./types";

export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export class Services {
  store: Store;
  hypervisor: Hypervisor;
  chat?: ChatBot;
  consoles = new Map<
    string,
    {
      userId: string;
      sessionToken: string;
      vmId: number;
      vm: Pick<VM, "pool" | "tags">;
      expires: number;
      connection: ConsoleConnection;
    }
  >();
  backups: BackupScheduler;
  finished = new Set<(op: Operation) => void>();
  private polling = false;
  private snapshot?: { at: number; vms: Promise<VM[]> };
  private attempts = new Map<string, { count: number; expires: number }>();
  constructor(
    public config: Config,
    hypervisor?: Hypervisor,
  ) {
    this.store = new Store(config.database);
    this.store.sso = !!config.oidcIssuer;
    this.hypervisor =
      hypervisor || (config.demo ? new DemoHypervisor() : new Proxmox(config));
    this.backups = new BackupScheduler({
      database: config.database,
      dir: this.backupDir,
      settings: () => this.store.settings().backups,
    });
    if (config.demo && !this.store.users().length) {
      const admin = this.store.createUser({
        email: "admin@example.com",
        name: "Jordan Admin",
        role: "admin",
        enabled: true,
        password: "demo-proxdesk",
      });
      const alex = this.store.createUser({
        email: "alex@example.com",
        name: "Alex Chen",
        role: "member",
        enabled: true,
        password: "demo-proxdesk",
      });
      const maya = this.store.createUser({
        email: "maya@example.com",
        name: "Maya Patel",
        role: "member",
        enabled: true,
        password: "demo-proxdesk",
      });
      this.store.grant(alex.id, 104, [
        "view",
        "start",
        "reboot",
        "shutdown",
        "console",
      ]);
      this.store.grant(alex.id, 117, [
        "view",
        "start",
        "reboot",
        "shutdown",
        "console",
      ]);
      this.store.grant(maya.id, 132, [
        "view",
        "start",
        "reboot",
        "shutdown",
        "console",
      ]);
      this.store.linkChatIdentity("slack", "U0DEMOALEX", "Alex Chen", alex.id);
      const sam = this.store.createUser({
        email: null,
        name: "Sam Rivera",
        role: "member",
        enabled: true,
      });
      this.store.grant(sam.id, 120, chatActions);
      this.store.linkChatIdentity("slack", "U0DEMOSAM", "Sam Rivera", sam.id);
      this.store.audit(
        admin,
        "Created access grant",
        "alex-dev",
        "Alex Chen · status, start, reboot, shutdown, console",
      );
    }
    if (!config.demo && !this.store.users().length) {
      if (
        !config.bootstrapEmail ||
        !config.bootstrapPassword ||
        config.bootstrapPassword.length < 12
      )
        throw new Error(
          "First startup requires BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (at least 12 characters)",
        );
      const admin = this.store.createUser({
        email: config.bootstrapEmail,
        name: "Administrator",
        role: "admin",
        enabled: true,
        password: config.bootstrapPassword,
      });
      this.store.audit(admin, "Created administrator", config.bootstrapEmail);
    }
    // Without a task identifier, retrying after a restart could repeat a power action.
    for (const op of this.store.activeOperations())
      if (op.status === "pending")
        this.finish(
          op,
          "unknown",
          "The server restarted during submission. Check VM state before retrying.",
        );
  }
  rateLimit(key: string, limit = 10, window = 15 * 60_000) {
    const now = Date.now();
    for (const [k, v] of this.attempts)
      if (v.expires < now) this.attempts.delete(k);
    let entry = this.attempts.get(key);
    if (!entry) {
      entry = { count: 0, expires: now + window };
      this.attempts.set(key, entry);
    }
    if (++entry.count > limit)
      throw new AppError(429, "Too many attempts. Try again later.");
  }
  get backupDir() {
    return (
      this.config.backupDir ?? join(dirname(this.config.database), "backups")
    );
  }
  /** The hypervisor's VMs within the configured scope; anything else is treated as nonexistent. */
  async managedInventory() {
    const scope = this.store.settings().scope;
    return (await this.hypervisor.inventory()).filter((vm) =>
      inScope(vm, scope),
    );
  }
  async proxmoxCheck(): Promise<Check[]> {
    const scope = this.store.settings().scope;
    if (this.config.demo) {
      const count = (await this.managedInventory()).length;
      return [
        {
          status: "warn",
          message: "Demo mode uses simulated VMs; no Proxmox server is checked.",
        },
        {
          status: "ok",
          message: `${count} simulated VM${count === 1 ? "" : "s"} in scope`,
        },
      ];
    }
    const api =
      this.hypervisor instanceof Proxmox
        ? this.hypervisor
        : new Proxmox(this.config);
    return checkProxmox(this.config, api, { scope });
  }
  backupInfo() {
    return {
      dir: this.backupDir,
      files: this.backups.files(),
      status: this.backups.status,
      nextRunAt: (() => {
        const next = this.backups.nextRun();
        return next === undefined ? null : new Date(next).toISOString();
      })(),
    };
  }
  /** One audit event per manual backup, whether it succeeds or fails. */
  manualBackup(who: Pick<User, "id" | "name">) {
    try {
      const { file } = this.backups.run();
      this.store.audit(who, "Created backup", basename(file), this.backupDir);
      return file;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.audit(who, "Backup failed", this.backupDir, message);
      throw new AppError(409, `Backup failed: ${message}`);
    }
  }
  requirePermission(who: User, vmId: number, permission: Permission) {
    if (!this.store.allowed(who, vmId, permission))
      throw new AppError(403, "You do not have permission for this VM action");
  }
  async inventory(who: User) {
    const all = await this.managedInventory();
    const current = this.store.getUser(who.id);
    if (!current?.enabled) throw new AppError(401, "Account disabled");
    who = current;
    const active = this.store.activeOperations();
    return all
      .filter((vm) => this.store.allowed(who, vm.id, "view"))
      .map((vm) => ({
        ...vm,
        permissions:
          who.role === "admin"
            ? [...permissions]
            : this.store.grants(who.id).find((g) => g.vmId === vm.id)!
                .permissions,
        operation: active.find((op) => op.vmId === vm.id),
      }));
  }
  async vm(who: User, id: number, permission: Permission) {
    this.requirePermission(who, id, permission);
    const vm = (await this.managedInventory()).find((vm) => vm.id === id);
    if (!vm) throw new AppError(404, "VM not found in the managed inventory");
    return vm;
  }
  /**
   * via names the chat platform a request came through, for the audit log;
   * notify is stored with the operation for the bot's completion message.
   */
  async act(
    who: User,
    vmId: number,
    action: Action,
    options: { via?: string; notify?: unknown } = {},
  ) {
    const vm = await this.vm(who, vmId, action);
    return this.submit(who, vm, action, options, () => {
      // Recheck after the network await so a revoked grant cannot submit a new action.
      const current = this.store.getUser(who.id);
      if (!current || !current.enabled)
        throw new AppError(403, "Account disabled");
      this.requirePermission(current, vmId, action);
    });
  }
  private async submit(
    actor: Pick<User, "id" | "name">,
    vm: VM,
    action: Action,
    options: { via?: string; notify?: unknown },
    recheck: () => void,
  ) {
    if (action === "start" && vm.status !== "stopped")
      throw new AppError(409, "Only stopped VMs can be started");
    if (action !== "start" && vm.status !== "running")
      throw new AppError(409, "This action requires a running VM");
    recheck();
    let op: Operation;
    try {
      op = this.store.createOperation(actor, vm, action, options.notify);
    } catch {
      throw new AppError(
        409,
        "Another operation is already in progress for this VM",
      );
    }
    this.store.audit(
      actor,
      `Requested ${action}`,
      vm.name,
      options.via ? `VM ${vm.id} · via ${options.via}` : `VM ${vm.id}`,
    );
    try {
      const task = await this.hypervisor.action(vm, action);
      if (typeof task !== "string" || !task)
        throw new Error("Proxmox did not return a task identifier");
      this.store.updateOperation(op.id, "running", task);
    } catch (error) {
      // A lost HTTP response does not establish whether Proxmox accepted the action.
      this.finish(
        op,
        "unknown",
        `${error instanceof Error ? error.message : "Submission failed"} Check VM state before retrying.`,
      );
    }
    return this.store.getOperation(op.id)!;
  }
  private finish(
    op: Operation,
    status: Operation["status"],
    error: string | null = null,
  ) {
    this.store.updateOperation(op.id, status, op.task, error);
    this.store.audit(
      { id: op.userId, name: op.userName },
      `${op.action} ${status}`,
      op.vmName,
      error || `VM ${op.vmId}`,
    );
    const finished = this.store.getOperation(op.id)!;
    for (const listener of this.finished) listener(finished);
  }
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const op of this.store.activeOperations()) {
        if (!op.task) continue;
        try {
          const result = await this.hypervisor.task(op.node, op.task);
          if (result.status === "stopped")
            this.finish(
              op,
              result.exitstatus === "OK" ? "succeeded" : "failed",
              result.exitstatus === "OK"
                ? null
                : result.exitstatus ||
                    "Proxmox task stopped without an exit status",
            );
          else if (Date.now() - Date.parse(op.createdAt) > 30 * 60_000)
            this.finish(
              op,
              "unknown",
              "Task tracking timed out. Check Proxmox and VM state.",
            );
        } catch {
          if (Date.now() - Date.parse(op.createdAt) > 30 * 60_000)
            this.finish(
              op,
              "unknown",
              "Unable to retrieve task outcome. Check Proxmox and VM state.",
            );
        }
      }
    } finally {
      this.polling = false;
    }
  }
  async openConsole(who: User, vmId: number, sessionToken: string) {
    this.rateLimit(`console:${who.id}`, 12, 60_000);
    const vm = await this.vm(who, vmId, "console");
    if (vm.status !== "running")
      throw new AppError(409, "Start the VM before opening its console");
    const connection = this.config.demo
      ? undefined
      : await this.hypervisor.console(vm);
    const current = this.store.session(sessionToken);
    if (!current) throw new AppError(401, "Session expired");
    this.requirePermission(current, vmId, "console");
    this.store.audit(
      who,
      "Opened console",
      vm.name,
      this.config.demo ? "Demo console placeholder" : `VM ${vm.id}`,
    );
    if (!connection) return { demo: true, vmName: vm.name };
    const ticket = randomBytes(32).toString("base64url");
    for (const [key, value] of this.consoles)
      if (value.expires < Date.now()) this.consoles.delete(key);
    this.consoles.set(ticket, {
      userId: who.id,
      sessionToken,
      vmId,
      vm: { pool: vm.pool, tags: vm.tags },
      connection,
      expires: Date.now() + 30_000,
    });
    return {
      demo: false,
      path: `/console-socket?ticket=${ticket}`,
      password: connection.password,
      vmName: vm.name,
    };
  }
  consumeConsole(ticket: string, sessionToken: string) {
    const entry = this.consoles.get(ticket);
    this.consoles.delete(ticket);
    if (
      !entry ||
      entry.expires < Date.now() ||
      entry.sessionToken !== sessionToken ||
      !this.consoleAllowed(entry)
    )
      throw new AppError(403, "Console authorization expired");
    return entry;
  }
  /**
   * The hypervisor's VMs, read at most every five seconds and shared, so open
   * consoles cost one Proxmox call per interval however many there are.
   */
  private recentInventory() {
    const now = Date.now();
    if (!this.snapshot || now - this.snapshot.at >= 5000) {
      const vms = this.hypervisor.inventory();
      this.snapshot = { at: now, vms };
      vms.catch(() => {
        if (this.snapshot?.vms === vms) this.snapshot = undefined;
      });
    }
    return this.snapshot.vms;
  }
  /**
   * Refreshes the console's VM pool and tags from Proxmox and rechecks it, so
   * a VM moved out of the managed scope inside Proxmox loses its console.
   * Rejects when Proxmox cannot be asked; callers treat that as not allowed.
   */
  async consoleStillAllowed(entry: {
    sessionToken: string;
    userId: string;
    vmId: number;
    vm: Pick<VM, "pool" | "tags">;
  }) {
    const vm = (await this.recentInventory()).find((v) => v.id === entry.vmId);
    if (!vm) return false;
    entry.vm = { pool: vm.pool, tags: vm.tags };
    return this.consoleAllowed(entry);
  }
  /** Session, permission, and scope, against the VM's pool and tags as last read. */
  consoleAllowed(entry: {
    sessionToken: string;
    userId: string;
    vmId: number;
    vm: Pick<VM, "pool" | "tags">;
  }) {
    const who = this.store.session(entry.sessionToken);
    return (
      !!who &&
      who.id === entry.userId &&
      this.store.allowed(who, entry.vmId, "console") &&
      inScope(entry.vm, this.store.settings().scope)
    );
  }
}

const globalServices = globalThis as typeof globalThis & {
  proxdeskServices?: Services;
};
export function getServices() {
  return (globalServices.proxdeskServices ||= new Services(configFromEnv()));
}
