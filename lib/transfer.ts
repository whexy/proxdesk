import { z } from "zod";
import { settingsSchema } from "./settings";
import {
  accountLabel,
  adminSignInError,
  chatActions,
  lastAdminError,
  type Store,
} from "./store";
import { permissions, type Permission, type User } from "./types";

// The export holds configuration only. Password hashes, sessions, operations,
// and audit history stay in the database and its backups.

const email = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
const vmId = z.number().int().positive();
const name = z.string().trim().min(1).max(100);
const role = z.enum(["admin", "member"]);
const grantPermissions = z
  .array(z.enum(permissions))
  .min(1)
  .max(permissions.length);
const platform = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const userRef = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
/**
 * A chat-only member has no email, and database IDs differ between
 * installations, so the file names one by a chat identity it owns, as
 * "<platform>:<user ID>", such as "slack:U0123ABCD".
 */
const account = z.string().regex(/^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9._:-]{1,128}$/);
const accountKey = (platform: string, userRef: string) => `${platform}:${userRef}`;

const webUser = z.strictObject({
  email,
  name,
  role,
  enabled: z.boolean(),
  oidc: z
    .object({
      issuer: z.string().min(1).max(512),
      subject: z.string().min(1).max(512),
    })
    .optional(),
});
const chatOnlyUser = z.strictObject({
  email: z.null(),
  account,
  name,
  role,
  enabled: z.boolean(),
});
const grantEntry = z.union([
  z.strictObject({ email, vmId, permissions: grantPermissions }),
  z.strictObject({ account, vmId, permissions: grantPermissions }),
]);
const identityFields = {
  platform,
  userRef,
  displayName: z.string().trim().min(1).max(100),
};
const chatIdentityEntry = z.union([
  z.strictObject({ ...identityFields, email }),
  z.strictObject({ ...identityFields, account }),
]);

export const exportSchema = z
  .object({
    format: z.literal("proxdesk-export"),
    version: z.literal(2),
    exportedAt: z.string(),
    settings: settingsSchema.partial(),
    users: z.array(z.union([webUser, chatOnlyUser])).max(10_000),
    grants: z.array(grantEntry).max(100_000),
    chatIdentities: z.array(chatIdentityEntry).max(10_000),
  })
  .superRefine((data, ctx) => {
    const keys = new Set<string>();
    for (const user of data.users) {
      const key = userKey(user);
      if (keys.has(key))
        ctx.addIssue({ code: "custom", message: `Duplicate user ${key}` });
      keys.add(key);
    }
    for (const grant of data.grants)
      if (!keys.has(userKey(grant)))
        ctx.addIssue({
          code: "custom",
          message: `Grant for ${userKey(grant)} has no matching user`,
        });
    const identities = new Set<string>();
    for (const identity of data.chatIdentities) {
      const key = accountKey(identity.platform, identity.userRef);
      if (identities.has(key))
        ctx.addIssue({ code: "custom", message: `Duplicate chat identity ${key}` });
      identities.add(key);
      if (!keys.has(userKey(identity)))
        ctx.addIssue({
          code: "custom",
          message: `Chat identity ${key} has no matching user ${userKey(identity)}`,
        });
    }
    for (const user of data.users)
      if (
        user.email === null &&
        !data.chatIdentities.some(
          (i) =>
            "account" in i &&
            i.account === user.account &&
            accountKey(i.platform, i.userRef) === user.account,
        )
      )
        ctx.addIssue({
          code: "custom",
          message: `Chat-only user ${user.account} has no chat identity ${user.account}`,
        });
  });
export type ExportFile = z.infer<typeof exportSchema>;
type UserEntry = ExportFile["users"][number];
/** How the file refers to a user: by email, or by account key for a chat-only member. */
function userKey(entry: { email: string | null } | { account: string }) {
  return "email" in entry && entry.email !== null
    ? entry.email
    : (entry as { account: string }).account;
}

// Version 1 linked Slack users directly to one VM each.
const exportSchemaV1 = z.object({
  format: z.literal("proxdesk-export"),
  version: z.literal(1),
  exportedAt: z.string(),
  settings: settingsSchema.partial(),
  users: z.array(webUser.strip()).max(10_000),
  grants: z
    .array(z.object({ email, vmId, permissions: grantPermissions }))
    .max(100_000),
  slackBindings: z
    .array(
      z.object({
        slackUserId: z.string().regex(/^[UW][A-Z0-9]+$/),
        slackName: z.string().min(1).max(100),
        vmId,
      }),
    )
    .max(10_000),
});
/** Converts each Slack link as the database migration does: a chat-only member with every action on its VM. */
function fromV1(v1: z.infer<typeof exportSchemaV1>) {
  const key = (id: string) => accountKey("slack", id);
  return {
    format: v1.format,
    version: 2,
    exportedAt: v1.exportedAt,
    settings: v1.settings,
    users: [
      ...v1.users,
      ...v1.slackBindings.map((b) => ({
        email: null,
        account: key(b.slackUserId),
        name: b.slackName,
        role: "member",
        enabled: true,
      })),
    ],
    grants: [
      ...v1.grants,
      ...v1.slackBindings.map((b) => ({
        account: key(b.slackUserId),
        vmId: b.vmId,
        permissions: chatActions,
      })),
    ],
    chatIdentities: v1.slackBindings.map((b) => ({
      platform: "slack",
      userRef: b.slackUserId,
      displayName: b.slackName,
      account: key(b.slackUserId),
    })),
  };
}

export type ImportPlan = {
  sections: { title: string; changes: string[] }[];
  warnings: string[];
};
type Context = {
  plan: ImportPlan;
  changes: string[];
  /** Database user ID for each user key in the file, filled by the users section. */
  ids: Map<string, string>;
};

/**
 * One section of the export. A section exports its part of the file and
 * imports it, describing each change; import order follows this list, since
 * later sections refer to users by email.
 */
type Section<K extends keyof ExportFile> = {
  key: K;
  title: string;
  export(store: Store): ExportFile[K];
  import(store: Store, data: ExportFile, ctx: Context): void;
};
const section = <K extends keyof ExportFile>(value: Section<K>) => value;

const permissionList = (list: Permission[]) =>
  [...list].sort((a, b) => permissions.indexOf(a) - permissions.indexOf(b));

const sections = [
  section({
    key: "settings",
    title: "Settings",
    export: (store) => store.settings(),
    import(store, data, ctx) {
      const before = store.settings();
      const { settings, changed } = store.updateSettings(data.settings);
      for (const key of changed)
        ctx.changes.push(
          `${key}: ${JSON.stringify(before[key])} → ${JSON.stringify(settings[key])}`,
        );
    },
  }),
  section({
    key: "users",
    title: "Users",
    export: (store) => {
      const keys = chatOnlyKeys(store);
      const users = store.usersWithIdentity();
      return [
        ...users.flatMap(({ email, name, role, enabled, oidc }) =>
          email === null ? [] : [{ email, name, role, enabled, ...(oidc ? { oidc } : {}) }],
        ),
        ...users
          .filter((u) => keys.has(u.id))
          .map(({ id, name, role, enabled }) => ({
            email: null,
            account: keys.get(id)!,
            name,
            role,
            enabled,
          }))
          .sort((a, b) => a.account.localeCompare(b.account)),
      ];
    },
    import(store, data, ctx) {
      const linked = new Map(
        store
          .usersWithIdentity()
          .filter((u) => u.oidc)
          .map((u) => [`${u.oidc!.issuer}\n${u.oidc!.subject}`, u.email]),
      );
      const key = (oidc: { issuer: string; subject: string }) =>
        `${oidc.issuer}\n${oidc.subject}`;
      const identityFree = (oidc: { issuer: string; subject: string }) =>
        !linked.has(key(oidc));
      const link = (
        id: string,
        email: string,
        oidc: { issuer: string; subject: string },
      ) => {
        store.linkOidc(id, oidc.issuer, oidc.subject);
        linked.set(key(oidc), email);
      };
      const existing = (entry: UserEntry) =>
        entry.email === null ? chatOnlyOwner(store, entry.account) : store.findEmail(entry.email);
      const demotes = (entry: UserEntry) => {
        const current = existing(entry);
        return (
          current?.role === "admin" &&
          current.enabled &&
          (entry.role !== "admin" || !entry.enabled)
        );
      };
      // Promotions and new administrators apply first, so a file that hands
      // the administrator role to someone else can demote the current ones.
      const ordered = [
        ...data.users.filter((u) => !demotes(u)),
        ...data.users.filter(demotes),
      ];
      for (const entry of ordered) {
        if (entry.email === null) {
          importChatOnly(store, entry, ctx);
          continue;
        }
        const current = store.findEmail(entry.email);
        if (!current) {
          const oidc =
            entry.oidc && identityFree(entry.oidc) ? entry.oidc : undefined;
          if (entry.oidc && !oidc)
            ctx.plan.warnings.push(
              `${entry.email}: its SSO identity belongs to another account; created without it`,
            );
          // Without a password or an SSO identity the account cannot sign in,
          // so it stays disabled until an administrator sets a password, and
          // cannot be an administrator until then.
          const enabled = oidc ? entry.enabled : false;
          const role = entry.role === "admin" && !oidc ? "member" : entry.role;
          if (role !== entry.role)
            ctx.plan.warnings.push(
              `${entry.email}: created as a member; it cannot sign in yet, so make it an administrator after setting a password`,
            );
          const created = store.createUser({
            email: entry.email,
            name: entry.name,
            role,
            enabled,
            oidc,
          });
          if (oidc) linked.set(key(oidc), entry.email);
          ctx.ids.set(entry.email, created.id);
          ctx.changes.push(
            `create ${entry.email} (${role}, ${
              enabled
                ? "enabled, SSO"
                : oidc
                  ? "disabled, SSO"
                  : "disabled until an administrator sets a password"
            })`,
          );
          continue;
        }
        ctx.ids.set(entry.email, current.id);
        const identity = store
          .usersWithIdentity()
          .find((u) => u.id === current.id)!;
        // An account that cannot sign in stays disabled, as when it was created.
        const enabled =
          entry.enabled &&
          (current.enabled ||
            identity.hasPassword ||
            !!identity.oidc ||
            (!!entry.oidc && identityFree(entry.oidc)));
        const diff: string[] = [];
        // Linking first lets an account that signs in only by SSO become an administrator.
        if (entry.oidc && !identity.oidc) {
          if (identityFree(entry.oidc)) {
            link(current.id, entry.email, entry.oidc);
            diff.push("link SSO identity");
          } else
            ctx.plan.warnings.push(
              `${entry.email}: its SSO identity belongs to another account; not linked`,
            );
        }
        if (current.name !== entry.name)
          diff.push(`name ${current.name} → ${entry.name}`);
        const roleDiff =
          current.role !== entry.role ? `role ${current.role} → ${entry.role}` : "";
        const enableDiff =
          current.enabled !== enabled ? (enabled ? "enable" : "disable") : "";
        if (
          !updateImported(store, ctx, current.id, entry.email, {
            name: entry.name,
            role: entry.role,
            enabled,
          })
        ) {
          if (roleDiff) diff.push(roleDiff);
          if (enableDiff) diff.push(enableDiff);
        }
        if (
          entry.oidc &&
          identity.oidc &&
          (identity.oidc.issuer !== entry.oidc.issuer ||
            identity.oidc.subject !== entry.oidc.subject)
        )
          ctx.plan.warnings.push(
            `${entry.email}: already linked to a different SSO identity; kept`,
          );
        if (diff.length) ctx.changes.push(`update ${entry.email}: ${diff.join(", ")}`);
      }
    },
  }),
  section({
    key: "grants",
    title: "VM grants",
    export: (store) => {
      const keys = chatOnlyKeys(store);
      const ref = new Map(
        store
          .users()
          .flatMap((u): [string, { email: string } | { account: string }][] =>
            u.email !== null
              ? [[u.id, { email: u.email }]]
              : keys.has(u.id)
                ? [[u.id, { account: keys.get(u.id)! }]]
                : [],
          ),
      );
      return store
        .grants()
        .filter((g) => ref.has(g.userId))
        .map((g) => ({
          ...ref.get(g.userId)!,
          vmId: g.vmId,
          permissions: permissionList(g.permissions),
        }))
        .sort(
          (a, b) =>
            Number("account" in a) - Number("account" in b) ||
            userKey(a).localeCompare(userKey(b)) ||
            a.vmId - b.vmId,
        );
    },
    import(store, data, ctx) {
      // Grants are replaced only for users in the file; everyone else keeps theirs.
      for (const entry of data.users) {
        const key = userKey(entry);
        const userId = ctx.ids.get(key)!;
        const describe = (list: { vmId: number; permissions: Permission[] }[]) =>
          list
            .map((g) => `VM ${g.vmId} (${permissionList(g.permissions).join(", ")})`)
            .sort()
            .join("; ") || "none";
        const before = describe(store.grants(userId));
        for (const grant of store.grants(userId))
          store.grant(userId, grant.vmId, []);
        for (const grant of data.grants.filter((g) => userKey(g) === key))
          store.grant(userId, grant.vmId, grant.permissions);
        const after = describe(store.grants(userId));
        if (before !== after) ctx.changes.push(`${key}: ${before} → ${after}`);
      }
    },
  }),
  section({
    key: "chatIdentities",
    title: "Chat identities",
    export: (store) => {
      const keys = chatOnlyKeys(store);
      const users = new Map(store.users().map((u) => [u.id, u]));
      return store
        .chatIdentities()
        .filter((i) => users.has(i.userId))
        .map(({ platform, userRef, displayName, userId }) => {
          const owner = users.get(userId)!;
          return owner.email !== null
            ? { platform, userRef, displayName, email: owner.email }
            : { platform, userRef, displayName, account: keys.get(userId)! };
        })
        .sort(
          (a, b) =>
            a.platform.localeCompare(b.platform) ||
            a.userRef.localeCompare(b.userRef),
        );
    },
    import(store, data, ctx) {
      for (const entry of data.chatIdentities) {
        const key = accountKey(entry.platform, entry.userRef);
        const userId = ctx.ids.get(userKey(entry))!;
        const target = store.getUser(userId)!;
        const current = store.chatIdentity(entry.platform, entry.userRef);
        if (current?.userId === userId && current.displayName === entry.displayName)
          continue;
        store.linkChatIdentity(entry.platform, entry.userRef, entry.displayName, userId);
        const previous = current && store.getUser(current.userId);
        if (!current)
          ctx.changes.push(`link ${key} (${entry.displayName}) to ${accountLabel(target)}`);
        else if (current.userId === userId)
          ctx.changes.push(`${key}: name ${current.displayName} → ${entry.displayName}`);
        else {
          ctx.changes.push(
            `${key}: ${previous ? accountLabel(previous) : "unknown account"} → ${accountLabel(target)}`,
          );
          if (previous?.email === null && !store.chatIdentities(previous.id).length)
            ctx.plan.warnings.push(
              `${previous.name}: this chat-only member has no chat account left; disable it under Members`,
            );
        }
      }
    },
  }),
];

/**
 * Applies a web user's role and status, or only its name when the store
 * refuses them; returns whether it fell back, after recording a warning.
 */
function updateImported(
  store: Store,
  ctx: Context,
  id: string,
  label: string,
  patch: { name: string; role: "admin" | "member"; enabled: boolean },
) {
  try {
    store.updateUser(id, patch);
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message !== lastAdminError && message !== adminSignInError) throw error;
    store.updateUser(id, { name: patch.name });
    ctx.plan.warnings.push(
      message === lastAdminError
        ? `${label}: kept as an enabled administrator; the import would leave none`
        : `${label}: kept as a ${store.getUser(id)!.role}; it cannot sign in yet, so it cannot be an administrator`,
    );
    return true;
  }
}
/** The chat identity, as "<platform>:<user ID>", that names each chat-only member in an export. */
function chatOnlyKeys(store: Store) {
  const users = new Map(store.users().map((u) => [u.id, u]));
  const keys = new Map<string, string>();
  for (const identity of store.chatIdentities()) {
    const key = accountKey(identity.platform, identity.userRef);
    const current = keys.get(identity.userId);
    if (users.get(identity.userId)?.email === null && (!current || key < current))
      keys.set(identity.userId, key);
  }
  return keys;
}
/** The chat-only member that owns this account key's identity, if any. */
function chatOnlyOwner(store: Store, key: string): User | undefined {
  const [platform, ...rest] = key.split(":");
  const identity = store.chatIdentity(platform, rest.join(":"));
  const owner = identity && store.getUser(identity.userId);
  return owner?.email === null ? owner : undefined;
}
function importChatOnly(
  store: Store,
  entry: Extract<UserEntry, { email: null }>,
  ctx: Context,
) {
  const current = chatOnlyOwner(store, entry.account);
  if (entry.role === "admin")
    ctx.plan.warnings.push(
      `${entry.account}: imported as a member; a chat-only member cannot sign in, so it cannot be an administrator`,
    );
  if (!current) {
    const created = store.createUser({
      email: null,
      name: entry.name,
      role: "member",
      enabled: entry.enabled,
    });
    ctx.ids.set(entry.account, created.id);
    ctx.changes.push(
      `create ${entry.name} (chat only, ${entry.account}, member, ${entry.enabled ? "enabled" : "disabled"})`,
    );
    return;
  }
  ctx.ids.set(entry.account, current.id);
  const diff: string[] = [];
  if (current.name !== entry.name) diff.push(`name ${current.name} → ${entry.name}`);
  // A chat-only administrator left by an older release can be demoted, never kept or made one.
  const role = "member";
  if (current.role !== role) diff.push(`role ${current.role} → ${role}`);
  if (current.enabled !== entry.enabled) diff.push(entry.enabled ? "enable" : "disable");
  store.updateUser(current.id, { name: entry.name, role, enabled: entry.enabled });
  if (diff.length)
    ctx.changes.push(`update ${entry.name} (chat only, ${entry.account}): ${diff.join(", ")}`);
}

export function exportConfiguration(store: Store, now = new Date()): ExportFile {
  const file: Record<string, unknown> = {
    format: "proxdesk-export",
    version: 2,
    exportedAt: now.toISOString(),
  };
  for (const s of sections) file[s.key] = s.export(store);
  return file as ExportFile;
}

export function parseExport(text: string): ExportFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The file is not valid JSON");
  }
  const header = value as { format?: unknown; version?: unknown } | null;
  if (header?.format !== "proxdesk-export")
    throw new Error("The file is not a Proxdesk export");
  if (typeof header.version === "number" && header.version > 2)
    throw new Error(
      `The file has export version ${header.version}; this release reads versions 1 and 2. Upgrade Proxdesk.`,
    );
  const issues = (error: z.ZodError) =>
    new Error(
      error.issues
        .map((i) => `${i.path.join(".") || "file"}: ${i.message}`)
        .join("; "),
    );
  if (header.version === 1) {
    const v1 = exportSchemaV1.safeParse(value);
    if (!v1.success) throw issues(v1.error);
    value = fromV1(v1.data);
  }
  const parsed = exportSchema.safeParse(value);
  if (!parsed.success) throw issues(parsed.error);
  return parsed.data;
}

/** Applies the import, or with dryRun only describes it; both run the same code. */
export function importConfiguration(
  store: Store,
  data: ExportFile,
  options: { dryRun: boolean; source?: string },
): ImportPlan {
  const plan: ImportPlan = { sections: [], warnings: [] };
  const ids = new Map<string, string>();
  return store.transaction(
    () => {
      for (const s of sections) {
        const ctx = { plan, changes: [] as string[], ids };
        s.import(store, data, ctx);
        plan.sections.push({ title: s.title, changes: ctx.changes });
      }
      const total = plan.sections.reduce((n, s) => n + s.changes.length, 0);
      store.audit(
        undefined,
        "Imported configuration",
        options.source || "configuration file",
        `Command line · ${total} change${total === 1 ? "" : "s"}`,
      );
      return plan;
    },
    { rollback: options.dryRun },
  );
}

export function formatPlan(plan: ImportPlan) {
  const lines: string[] = [];
  for (const s of plan.sections) {
    lines.push(`${s.title}: ${s.changes.length ? "" : "no changes"}`.trimEnd());
    for (const change of s.changes) lines.push(`  ${change}`);
  }
  for (const warning of plan.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}
