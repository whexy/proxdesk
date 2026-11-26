import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import type {
  Action,
  Audit,
  Grant,
  Operation,
  ChatIdentity,
  Permission,
  User,
} from "./types";
import {
  defaultSettings,
  settingsSchema,
  type Settings,
  type SettingsPatch,
} from "./settings";

type Row = Record<string, any>;
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
const dummyHash = hashPassword("not-a-valid-login");
function verifyPassword(password: string, encoded: string) {
  const [salt, hash] = encoded.split(":");
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function user(row: Row): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    enabled: !!row.enabled,
  };
}
function operation(row: Row): Operation {
  return {
    id: row.id,
    vmId: row.vm_id,
    vmName: row.vm_name,
    userId: row.user_id,
    userName: row.user_name,
    action: row.action,
    status: row.status,
    task: row.task,
    node: row.node,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function chatIdentity(row: Row): ChatIdentity {
  return {
    platform: row.platform,
    userRef: row.user_ref,
    displayName: row.display_name,
    userId: row.user_id,
    createdAt: row.created_at,
  };
}
/** Every action a Slack binding allowed; console needs the web, so it is not included. */
export const chatActions: Permission[] = [
  "view",
  "start",
  "reboot",
  "shutdown",
  "reset",
];
/** How a user appears in audit targets: chat-only members have no email. */
export const accountLabel = (who: Pick<User, "email" | "name">) =>
  who.email ?? who.name;
export const lastAdminError =
  "Keep at least one enabled administrator who can sign in";
export const adminSignInError =
  "Only an account that can sign in to the web can be an administrator; give it an email and a password or single sign-on first";
export type Migration = (db: DatabaseSync) => void;
// Append only: a released migration must never change, because user_version
// records which ones a database has already applied.
export const migrations: Migration[] = [
  // Databases created before versioning have user_version 0 and some or all
  // of these tables, so this migration must tolerate existing objects.
  (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL, enabled INTEGER NOT NULL, password TEXT, oidc_issuer TEXT, oidc_subject TEXT, UNIQUE(oidc_issuer, oidc_subject));
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS grants (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, vm_id INTEGER NOT NULL, permissions TEXT NOT NULL, PRIMARY KEY(user_id, vm_id));
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, vm_id INTEGER NOT NULL, vm_name TEXT NOT NULL, user_id TEXT NOT NULL, user_name TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, task TEXT, node TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_operation ON operations(vm_id) WHERE status IN ('pending','running');
      CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, user_id TEXT, user_name TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oidc_flows (state TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS slack_bindings (slack_user_id TEXT PRIMARY KEY, slack_name TEXT NOT NULL, vm_id INTEGER NOT NULL, created_at TEXT NOT NULL);
      DROP TABLE IF EXISTS agent_sessions;
    `),
  (db) =>
    db.exec(
      "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    ),
  // Chat-only members have no email. SQLite cannot drop NOT NULL in place, so
  // users is rebuilt; migrate() turns foreign keys off around it so dropping
  // the old table does not cascade into sessions and grants.
  (db) => {
    db.exec(`
      CREATE TABLE users_new (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL, enabled INTEGER NOT NULL, password TEXT, oidc_issuer TEXT, oidc_subject TEXT, UNIQUE(oidc_issuer, oidc_subject));
      INSERT INTO users_new (id,email,name,role,enabled,password,oidc_issuer,oidc_subject) SELECT id,email,name,role,enabled,password,oidc_issuer,oidc_subject FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      CREATE TABLE chat_identities (platform TEXT NOT NULL, user_ref TEXT NOT NULL, display_name TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY(platform, user_ref));
      CREATE INDEX chat_identities_user ON chat_identities(user_id);
      CREATE TABLE chat_link_codes (code TEXT PRIMARY KEY, platform TEXT NOT NULL, user_ref TEXT NOT NULL, display_name TEXT NOT NULL, expires INTEGER NOT NULL);
      ALTER TABLE operations ADD COLUMN notify TEXT;
    `);
    // Each Slack binding becomes a chat-only member with every action on its
    // VM, which is exactly what the binding allowed.
    const bindings = db
      .prepare("SELECT * FROM slack_bindings ORDER BY slack_name")
      .all() as Row[];
    for (const binding of bindings) {
      const id = randomUUID();
      db.prepare(
        "INSERT INTO users (id,email,name,role,enabled,password) VALUES (?,NULL,?,'member',1,NULL)",
      ).run(id, binding.slack_name);
      db.prepare("INSERT INTO grants VALUES (?,?,?)").run(
        id,
        binding.vm_id,
        JSON.stringify(chatActions),
      );
      db.prepare("INSERT INTO chat_identities VALUES ('slack',?,?,?,?)").run(
        binding.slack_user_id,
        binding.slack_name,
        id,
        binding.created_at,
      );
    }
    db.exec("DROP TABLE slack_bindings");
  },
  // The link page shows the username, which unlike the display name cannot be
  // set to imitate someone else.
  (db) =>
    db.exec(
      "ALTER TABLE chat_link_codes ADD COLUMN handle TEXT NOT NULL DEFAULT ''",
    ),
];
export const schemaVersion = migrations.length;
export function userVersion(db: DatabaseSync) {
  return (db.prepare("PRAGMA user_version").get() as Row).user_version as number;
}
export function migrate(db: DatabaseSync) {
  const from = userVersion(db);
  if (from > schemaVersion)
    throw new Error(
      `Database schema version ${from} is newer than this Proxdesk release supports (${schemaVersion}). Upgrade Proxdesk or restore a compatible backup.`,
    );
  // Table rebuilds need foreign keys off, and the pragma is ignored inside a
  // transaction; foreign_key_check keeps the result consistent instead.
  const foreignKeys = (db.prepare("PRAGMA foreign_keys").get() as Row)
    .foreign_keys as number;
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    for (let version = from + 1; version <= schemaVersion; version++) {
      db.exec("BEGIN IMMEDIATE");
      try {
        // Another process may have applied this migration since user_version
        // was read; only the value inside the write lock is authoritative.
        if (userVersion(db) >= version) {
          db.exec("COMMIT");
          continue;
        }
        migrations[version - 1](db);
        if (db.prepare("PRAGMA foreign_key_check").all().length)
          throw new Error(
            `Migration ${version} would leave rows referring to missing records`,
          );
        db.exec(`PRAGMA user_version=${version}`);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  } finally {
    if (foreignKeys) db.exec("PRAGMA foreign_keys=ON");
  }
  return { from, to: schemaVersion };
}
export class Store {
  db: DatabaseSync;
  /**
   * Whether single sign-on is configured, so an account with an email but no
   * password can still sign in and link its identity on first use.
   */
  sso = false;
  constructor(filename: string) {
    if (filename !== ":memory:")
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    // Command-line tools write while the server runs; wait out its short transactions.
    this.db = new DatabaseSync(filename, { timeout: 5000 });
    if (filename !== ":memory:") chmodSync(filename, 0o600);
    try {
      this.db.exec("PRAGMA foreign_keys=ON");
      migrate(this.db);
      this.db.exec("PRAGMA journal_mode=WAL");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  /** With rollback, the work runs and is then discarded, which previews its effects exactly. */
  transaction<T>(work: () => T, options: { rollback?: boolean } = {}): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec(options.rollback ? "ROLLBACK" : "COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  users() {
    return (
      this.db.prepare("SELECT * FROM users ORDER BY name").all() as Row[]
    ).map(user);
  }
  getUser(id: string) {
    const row = this.db.prepare("SELECT * FROM users WHERE id=?").get(id) as
      Row | undefined;
    return row && user(row);
  }
  findEmail(email: string) {
    const row = this.db
      .prepare("SELECT * FROM users WHERE email=?")
      .get(email.toLowerCase()) as Row | undefined;
    return row && user(row);
  }
  /** Whether the account has a way to sign in to the web. */
  private canSignIn(account: {
    email: string | null;
    password: boolean;
    oidc: boolean;
  }) {
    return account.email !== null && (account.password || account.oidc || this.sso);
  }
  /** Enabled administrators who can sign in; chat-only ones cannot manage anything. */
  private signInAdmins() {
    return (
      this.db
        .prepare("SELECT * FROM users WHERE role='admin' AND enabled=1")
        .all() as Row[]
    ).filter((row) =>
      this.canSignIn({
        email: row.email,
        password: !!row.password,
        oidc: !!row.oidc_subject,
      }),
    );
  }
  /** Whether removing this enabled administrator would leave none who can sign in. */
  private isLastAdmin(id: string) {
    const admins = this.signInAdmins();
    return admins.length <= 1 && admins.some((row) => row.id === id);
  }
  createUser(input: {
    email: string | null;
    name: string;
    role: "admin" | "member";
    enabled: boolean;
    password?: string;
    oidc?: { issuer: string; subject: string };
  }) {
    if (
      input.role === "admin" &&
      !this.canSignIn({
        email: input.email,
        password: !!input.password,
        oidc: !!input.oidc,
      })
    )
      throw new Error(adminSignInError);
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO users (id,email,name,role,enabled,password,oidc_issuer,oidc_subject) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.email?.toLowerCase() ?? null,
        input.name,
        input.role,
        +input.enabled,
        input.password ? hashPassword(input.password) : null,
        input.oidc?.issuer ?? null,
        input.oidc?.subject ?? null,
      );
    return this.getUser(id)!;
  }
  authenticate(email: string, password: string) {
    const row = this.db
      .prepare("SELECT * FROM users WHERE email=?")
      .get(email.toLowerCase()) as Row | undefined;
    const valid = verifyPassword(password, row?.password || dummyHash);
    return valid && row?.password && row.enabled ? user(row) : undefined;
  }
  oidcUser(issuer: string, subject: string, email: string, name: string) {
    let row = this.db
      .prepare("SELECT * FROM users WHERE oidc_issuer=? AND oidc_subject=?")
      .get(issuer, subject) as Row | undefined;
    if (row) return user(row);
    const existing = this.findEmail(email);
    const result =
      existing ||
      this.createUser({ email, name, role: "member", enabled: false });
    this.db
      .prepare(
        "UPDATE users SET oidc_issuer=?,oidc_subject=? WHERE id=? AND oidc_subject IS NULL",
      )
      .run(issuer, subject, result.id);
    row = this.db
      .prepare("SELECT * FROM users WHERE oidc_issuer=? AND oidc_subject=?")
      .get(issuer, subject) as Row | undefined;
    if (!row)
      throw new Error("This email is already linked to a different identity");
    return user(row);
  }
  usersWithIdentity() {
    return (
      this.db.prepare("SELECT * FROM users ORDER BY email").all() as Row[]
    ).map((row) => ({
      ...user(row),
      hasPassword: !!row.password,
      oidc: row.oidc_subject
        ? { issuer: row.oidc_issuer as string, subject: row.oidc_subject as string }
        : undefined,
    }));
  }
  linkOidc(id: string, issuer: string, subject: string) {
    this.db
      .prepare(
        "UPDATE users SET oidc_issuer=?,oidc_subject=? WHERE id=? AND oidc_subject IS NULL",
      )
      .run(issuer, subject, id);
  }
  updateUser(
    id: string,
    patch: {
      enabled?: boolean;
      role?: "admin" | "member";
      password?: string;
      name?: string;
      /** Only a chat-only member's missing email can be set, which lets them sign in. */
      email?: string;
    },
  ) {
    const row = this.db.prepare("SELECT * FROM users WHERE id=?").get(id) as
      Row | undefined;
    if (!row) throw new Error("User not found");
    const current = user(row);
    if (
      (patch.enabled === false || patch.role === "member") &&
      this.isLastAdmin(id)
    )
      throw new Error(lastAdminError);
    if (
      patch.role === "admin" &&
      !this.canSignIn({
        email: current.email ?? patch.email ?? null,
        password: !!row.password || !!patch.password,
        oidc: !!row.oidc_subject,
      })
    )
      throw new Error(adminSignInError);
    this.db
      .prepare("UPDATE users SET enabled=?,role=?,name=? WHERE id=?")
      .run(
        +(patch.enabled ?? current.enabled),
        patch.role ?? current.role,
        patch.name ?? current.name,
        id,
      );
    if (patch.email !== undefined && patch.email.toLowerCase() !== current.email) {
      if (current.email !== null)
        throw new Error("Only a chat-only member's email can be set");
      if (this.findEmail(patch.email))
        throw new Error("This email already has an account");
      this.db
        .prepare("UPDATE users SET email=? WHERE id=?")
        .run(patch.email.toLowerCase(), id);
    }
    if (patch.password)
      this.db
        .prepare("UPDATE users SET password=? WHERE id=?")
        .run(hashPassword(patch.password), id);
    if (patch.enabled === false || patch.password)
      this.db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
    return this.getUser(id)!;
  }
  /** Removes the account with its grants, chat identities, and sessions. */
  deleteUser(id: string) {
    const current = this.getUser(id);
    if (!current) throw new Error("User not found");
    if (this.isLastAdmin(id)) throw new Error(lastAdminError);
    // The schema cascades through foreign keys; an explicit delete keeps this
    // true on a connection that has them turned off.
    for (const table of ["grants", "chat_identities", "sessions"])
      this.db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(id);
    this.db.prepare("DELETE FROM users WHERE id=?").run(id);
    return current;
  }
  createSession(userId: string) {
    const token = randomBytes(32).toString("base64url");
    this.db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    this.db
      .prepare("INSERT INTO sessions VALUES (?,?,?)")
      .run(digest(token), userId, Date.now() + 12 * 3600_000);
    return token;
  }
  session(token?: string) {
    if (!token) return undefined;
    const row = this.db
      .prepare(
        "SELECT users.* FROM users JOIN sessions ON sessions.user_id=users.id WHERE sessions.token=? AND sessions.expires>? AND users.enabled=1",
      )
      .get(digest(token), Date.now()) as Row | undefined;
    return row && user(row);
  }
  deleteSession(token: string) {
    this.db.prepare("DELETE FROM sessions WHERE token=?").run(digest(token));
  }
  grants(userId?: string): Grant[] {
    const rows = (
      userId
        ? this.db.prepare("SELECT * FROM grants WHERE user_id=?").all(userId)
        : this.db.prepare("SELECT * FROM grants").all()
    ) as Row[];
    return rows.map((r) => ({
      userId: r.user_id,
      vmId: r.vm_id,
      permissions: JSON.parse(r.permissions),
    }));
  }
  grant(userId: string, vmId: number, permissions: Permission[]) {
    if (!permissions.length)
      this.db
        .prepare("DELETE FROM grants WHERE user_id=? AND vm_id=?")
        .run(userId, vmId);
    else
      this.db
        .prepare(
          "INSERT INTO grants VALUES (?,?,?) ON CONFLICT(user_id,vm_id) DO UPDATE SET permissions=excluded.permissions",
        )
        .run(
          userId,
          vmId,
          JSON.stringify([...new Set(["view", ...permissions])]),
        );
  }
  allowed(who: User, vmId: number, permission: Permission) {
    return (
      who.enabled &&
      (who.role === "admin" ||
        !!this.grants(who.id)
          .find((g) => g.vmId === vmId)
          ?.permissions.includes(permission))
    );
  }
  audit(
    who: Pick<User, "id" | "name"> | undefined,
    action: string,
    target: string,
    detail = "",
  ) {
    this.db
      .prepare("INSERT INTO audit VALUES (?,?,?,?,?,?,?)")
      .run(
        randomUUID(),
        who?.id ?? null,
        who?.name ?? "System",
        action,
        target,
        detail,
        new Date().toISOString(),
      );
  }
  audits(who: User): Audit[] {
    const rows = (
      who.role === "admin"
        ? this.db
            .prepare("SELECT * FROM audit ORDER BY created_at DESC LIMIT 100")
            .all()
        : this.db
            .prepare(
              "SELECT * FROM audit WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
            )
            .all(who.id)
    ) as Row[];
    return rows.map((r) => ({
      id: r.id,
      userName: r.user_name,
      action: r.action,
      target: r.target,
      detail: r.detail,
      createdAt: r.created_at,
    }));
  }
  /** notify is opaque JSON a chat bot stores to report the outcome later. */
  createOperation(
    who: Pick<User, "id" | "name">,
    vm: { id: number; name: string; node: string },
    action: Action,
    notify?: unknown,
  ) {
    const id = randomUUID(),
      now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO operations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        vm.id,
        vm.name,
        who.id,
        who.name,
        action,
        "pending",
        null,
        vm.node,
        null,
        now,
        now,
        notify === undefined ? null : JSON.stringify(notify),
      );
    return this.getOperation(id)!;
  }
  operationNotify(id: string): unknown {
    const row = this.db
      .prepare("SELECT notify FROM operations WHERE id=?")
      .get(id) as Row | undefined;
    return row?.notify ? JSON.parse(row.notify) : undefined;
  }
  getOperation(id: string) {
    const row = this.db
      .prepare("SELECT * FROM operations WHERE id=?")
      .get(id) as Row | undefined;
    return row && operation(row);
  }
  activeOperations() {
    return (
      this.db
        .prepare(
          "SELECT * FROM operations WHERE status IN ('pending','running')",
        )
        .all() as Row[]
    ).map(operation);
  }
  updateOperation(
    id: string,
    status: Operation["status"],
    task: string | null,
    error: string | null = null,
  ) {
    this.db
      .prepare(
        "UPDATE operations SET status=?,task=?,error=?,updated_at=? WHERE id=?",
      )
      .run(status, task, error, new Date().toISOString(), id);
  }
  putFlow(state: string, data: object) {
    this.db.prepare("DELETE FROM oidc_flows WHERE expires<?").run(Date.now());
    this.db
      .prepare("INSERT INTO oidc_flows VALUES (?,?,?)")
      .run(digest(state), JSON.stringify(data), Date.now() + 10 * 60_000);
  }
  consumeFlow(state: string): Row | undefined {
    const row = this.db
      .prepare(
        "DELETE FROM oidc_flows WHERE state=? AND expires>? RETURNING data",
      )
      .get(digest(state), Date.now()) as Row | undefined;
    return row && JSON.parse(row.data);
  }
  /** Each key falls back to its default when absent or no longer valid. */
  settings(): Settings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as Row[];
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const result = structuredClone(defaultSettings) as Record<string, unknown>;
    for (const [key, schema] of Object.entries(settingsSchema.shape)) {
      if (!(key in stored)) continue;
      let value: unknown;
      try {
        value = JSON.parse(stored[key]);
      } catch {
        continue;
      }
      const parsed = schema.safeParse(value);
      if (parsed.success) result[key] = parsed.data;
    }
    return result as Settings;
  }
  /** Returns the keys whose values changed. */
  updateSettings(patch: SettingsPatch) {
    const current = this.settings();
    const next = settingsSchema.parse({
      ...current,
      ...patch,
      backups: { ...current.backups, ...patch.backups },
    });
    const changed = (Object.keys(next) as (keyof Settings)[]).filter(
      (key) => JSON.stringify(next[key]) !== JSON.stringify(current[key]),
    );
    const write = this.db.prepare(
      "INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    );
    for (const key of changed) write.run(key, JSON.stringify(next[key]));
    return { settings: next, changed };
  }
  chatIdentities(userId?: string): ChatIdentity[] {
    const rows = (
      userId
        ? this.db
            .prepare(
              "SELECT * FROM chat_identities WHERE user_id=? ORDER BY platform, display_name",
            )
            .all(userId)
        : this.db
            .prepare(
              "SELECT * FROM chat_identities ORDER BY platform, display_name",
            )
            .all()
    ) as Row[];
    return rows.map(chatIdentity);
  }
  chatIdentity(platform: string, userRef: string) {
    const row = this.db
      .prepare("SELECT * FROM chat_identities WHERE platform=? AND user_ref=?")
      .get(platform, userRef) as Row | undefined;
    return row && chatIdentity(row);
  }
  /** Links the identity to the account, moving it if another account had it. */
  linkChatIdentity(
    platform: string,
    userRef: string,
    displayName: string,
    userId: string,
  ) {
    this.db
      .prepare(
        "INSERT INTO chat_identities VALUES (?,?,?,?,?) ON CONFLICT(platform,user_ref) DO UPDATE SET display_name=excluded.display_name, user_id=excluded.user_id, created_at=excluded.created_at",
      )
      .run(platform, userRef, displayName, userId, new Date().toISOString());
    return this.chatIdentity(platform, userRef)!;
  }
  unlinkChatIdentity(platform: string, userRef: string) {
    const existing = this.chatIdentity(platform, userRef);
    this.db
      .prepare("DELETE FROM chat_identities WHERE platform=? AND user_ref=?")
      .run(platform, userRef);
    return existing;
  }
  /** A single-use code valid for ten minutes; only its hash is stored. */
  createLinkCode(
    platform: string,
    userRef: string,
    displayName: string,
    handle: string,
  ) {
    const code = randomBytes(32).toString("base64url");
    this.db
      .prepare(
        "DELETE FROM chat_link_codes WHERE expires<? OR (platform=? AND user_ref=?)",
      )
      .run(Date.now(), platform, userRef);
    this.db
      .prepare(
        "INSERT INTO chat_link_codes (code,platform,user_ref,display_name,expires,handle) VALUES (?,?,?,?,?,?)",
      )
      .run(
        digest(code),
        platform,
        userRef,
        displayName,
        Date.now() + 10 * 60_000,
        handle,
      );
    return code;
  }
  linkCode(code: string) {
    const row = this.db
      .prepare("SELECT * FROM chat_link_codes WHERE code=? AND expires>?")
      .get(digest(code), Date.now()) as Row | undefined;
    return (
      row && {
        platform: row.platform as string,
        userRef: row.user_ref as string,
        displayName: row.display_name as string,
        handle: row.handle as string,
        expires: row.expires as number,
      }
    );
  }
  deleteLinkCode(code: string) {
    return (
      Number(
        this.db
          .prepare("DELETE FROM chat_link_codes WHERE code=?")
          .run(digest(code)).changes,
      ) > 0
    );
  }
}
