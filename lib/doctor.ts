import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import type { Config } from "./config";
import { Proxmox, parseResources } from "./proxmox";
import { describeScope, inScope, scopeSchema, type Scope } from "./settings";
import { slackCall as defaultSlackCall, type SlackCall } from "./chat/slack";
import { discordRest, DiscordError, type DiscordRest } from "./chat/discord";
import { schemaVersion, userVersion } from "./store";
import { peerFingerprint, trustMode } from "./tls";

export type Check = { status: "ok" | "warn" | "fail"; message: string };
export type ProxmoxApi = { request<T>(path: string): Promise<T> };
// Proxmox reports privileges per ACL path as { "/vms": { "VM.Audit": 1 } }.
export type Permissions = Record<string, Record<string, number>>;

export const requiredPrivileges = ["VM.Audit", "VM.PowerMgmt", "VM.Console"];
// Anything here lets a stolen token do more than operate existing VMs.
export const dangerousPrivileges = [
  "Sys.Modify",
  "Sys.PowerMgmt",
  "Sys.Console",
  "Permissions.Modify",
  "User.Modify",
  "Realm.Allocate",
  "Group.Allocate",
  "Pool.Allocate",
  "VM.Allocate",
  "VM.Clone",
  "VM.Migrate",
  "VM.Backup",
  "VM.Config.Disk",
  "VM.Config.HWType",
  "VM.Config.Options",
  "VM.Config.CDROM",
  "VM.Config.Cloudinit",
  "VM.GuestAgent.Unrestricted",
  "Datastore.Allocate",
  "Datastore.AllocateSpace",
  "SDN.Allocate",
  "Mapping.Modify",
];

const vmPath = (path: string) =>
  path === "/" ||
  path === "/vms" ||
  path.startsWith("/vms/") ||
  path.startsWith("/pool/");

export function analyzePermissions(permissions: Permissions): Check[] {
  const checks: Check[] = [];
  const granted = new Set(
    Object.entries(permissions)
      .filter(([path]) => vmPath(path))
      .flatMap(([, privileges]) => Object.keys(privileges)),
  );
  const missing = requiredPrivileges.filter((p) => !granted.has(p));
  if (missing.length)
    checks.push({
      status: "fail",
      message: `Token lacks ${missing.join(", ")} on every VM path. Grant them on /vms/<vmid> to both the token and its user.`,
    });
  else
    checks.push({
      status: "ok",
      message: `Token has ${requiredPrivileges.join(", ")}`,
    });
  for (const [path, privileges] of Object.entries(permissions).sort()) {
    const extra = dangerousPrivileges.filter((p) => p in privileges);
    if (extra.length)
      checks.push({
        status: "warn",
        message: `Token has ${extra.join(", ")} on ${path}; Proxdesk does not need them. Remove them to limit the damage a leaked token can do.`,
      });
  }
  return checks;
}

function tlsCause(error: unknown) {
  const cause = (error as Error)?.cause as (Error & { code?: string }) | undefined;
  return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL|FINGERPRINT|ALTNAME/.test(
    cause?.code || "",
  );
}

function describe(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as (Error & { code?: string }) | undefined;
  if (!cause) return error.message;
  return `${error.message} (${cause.code ? `${cause.code}: ` : ""}${cause.message})`;
}

function checkDatabase(config: Config): Check {
  if (!existsSync(config.database))
    return config.demo || (config.bootstrapEmail && config.bootstrapPassword)
      ? {
          status: "warn",
          message: `Database ${config.database} does not exist yet; the first start creates it.`,
        }
      : {
          status: "fail",
          message: `Database ${config.database} does not exist yet, and the first start fails without an administrator. Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD, or run proxdesk create-admin first.`,
        };
  try {
    const db = new DatabaseSync(config.database, { timeout: 5000 });
    try {
      const version = userVersion(db);
      if (version > schemaVersion)
        return {
          status: "fail",
          message: `Database schema version ${version} is newer than this release supports (${schemaVersion}).`,
        };
      let admins = 0;
      try {
        admins = (
          db
            .prepare(
              "SELECT count(*) AS n FROM users WHERE role='admin' AND enabled=1 AND email IS NOT NULL AND (password IS NOT NULL OR oidc_subject IS NOT NULL OR ?)",
            )
            .get(config.oidcIssuer ? 1 : 0) as { n: number }
        ).n;
      } catch {
        // A database that predates its first migration has no users table yet.
      }
      if (
        !admins &&
        !config.demo &&
        !(config.bootstrapEmail && config.bootstrapPassword)
      )
        return {
          status: "fail",
          message: `Database ${config.database} has no enabled administrator who can sign in. Run proxdesk create-admin.`,
        };
      return {
        status: version < schemaVersion ? "warn" : "ok",
        message:
          version < schemaVersion
            ? `Database ${config.database} is at schema ${version}; the next start or proxdesk migrate upgrades it to ${schemaVersion}.`
            : `Database ${config.database} is at schema ${version}`,
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      status: "fail",
      message: `Cannot open database ${config.database}: ${describe(error)}`,
    };
  }
}

export async function checkProxmox(
  config: Config,
  api: ProxmoxApi,
  options: {
    scope?: Scope;
    fingerprint?: (url: string) => Promise<string>;
  } = {},
) {
  const scope = options.scope ?? { type: "all" };
  const checks: Check[] = [
    { status: "ok", message: `Proxmox TLS trust: ${trustMode(config)}` },
  ];
  try {
    const version = await api.request<{ version?: string }>("/version");
    checks.push({
      status: "ok",
      message: `Proxmox reachable at ${config.proxmoxUrl} with a trusted certificate (version ${version?.version ?? "unknown"})`,
    });
  } catch (error) {
    let message = `Proxmox at ${config.proxmoxUrl}: ${describe(error)}`;
    if (tlsCause(error)) {
      // Fetched without trusting it, only so the administrator can compare and pin it.
      let presented = "";
      try {
        presented = await (options.fingerprint ?? peerFingerprint)(
          config.proxmoxUrl!,
        );
      } catch {
        // The original TLS error already explains the failure.
      }
      message += presented
        ? ` The server presents certificate SHA-256 ${presented}. If it matches the fingerprint under the node's System → Certificates in Proxmox, set PROXMOX_FINGERPRINT=${presented}, or set PROXMOX_CA_FILE to the CA that issued it.`
        : " Set PROXMOX_CA_FILE to the CA that issued the Proxmox certificate, or pin it with PROXMOX_FINGERPRINT.";
    }
    checks.push({ status: "fail", message });
    return checks;
  }
  try {
    checks.push(
      ...analyzePermissions(
        await api.request<Permissions>("/access/permissions"),
      ),
    );
  } catch (error) {
    checks.push({
      status: "fail",
      message: `Cannot read token permissions: ${describe(error)}`,
    });
  }
  try {
    const vms = parseResources(
      await api.request<Record<string, unknown>[]>("/cluster/resources?type=vm"),
    );
    const managed = vms.filter((vm) => inScope(vm, scope));
    const plural = (n: number) => `${n} QEMU VM${n === 1 ? "" : "s"}`;
    if (!vms.length)
      checks.push({
        status: "warn",
        message:
          "Token can see no QEMU VMs. Grant VM.Audit on the managed /vms/<vmid> paths.",
      });
    else if (scope.type === "all")
      checks.push({ status: "ok", message: `Token can see ${plural(vms.length)}` });
    else
      checks.push({
        status: managed.length ? "ok" : "warn",
        message: `Token can see ${plural(vms.length)}; ${managed.length} in scope (${describeScope(scope)})`,
      });
  } catch (error) {
    checks.push({
      status: "fail",
      message: `Cannot list VMs: ${describe(error)}`,
    });
  }
  return checks;
}

/** The managed-VM scope stored in the database, read without migrating it. */
function storedScope(database: string): Scope {
  if (!existsSync(database)) return { type: "all" };
  try {
    const db = new DatabaseSync(database, { readOnly: true, timeout: 5000 });
    try {
      const row = db
        .prepare("SELECT value FROM settings WHERE key='scope'")
        .get() as { value: string } | undefined;
      const parsed = row && scopeSchema.safeParse(JSON.parse(row.value));
      return parsed?.success ? parsed.data : { type: "all" };
    } finally {
      db.close();
    }
  } catch {
    return { type: "all" };
  }
}

async function checkSlack(
  slack: NonNullable<Config["slack"]>,
  call: SlackCall,
) {
  const checks: Check[] = [];
  try {
    const auth = await call(slack.botToken, "auth.test", {});
    checks.push({
      status: "ok",
      message: `Slack bot token valid (@${auth.user} in ${auth.team})`,
    });
  } catch (error) {
    checks.push({ status: "fail", message: `SLACK_BOT_TOKEN: ${describe(error)}` });
    return checks;
  }
  try {
    await call(slack.appToken, "apps.connections.open", {});
    checks.push({ status: "ok", message: "Slack app token can open Socket Mode" });
  } catch (error) {
    checks.push({
      status: "fail",
      message: `SLACK_APP_TOKEN: ${describe(error)}. Enable Socket Mode and give the token connections:write.`,
    });
  }
  for (const channel of slack.channels)
    try {
      const info = await call(slack.botToken, "conversations.info", { channel });
      checks.push(
        info.channel?.is_member
          ? {
              status: "ok",
              message: `Slack channel #${info.channel.name} reachable and the bot is a member`,
            }
          : {
              status: "fail",
              message: `The bot is not a member of ${channel}. Invite it to the channel.`,
            },
      );
    } catch (error) {
      checks.push({
        status: "fail",
        message: `SLACK_CHANNEL_ID ${channel}: ${describe(error)}. Invite the bot; private channels are invisible until it joins.`,
      });
    }
  return checks;
}

async function checkDiscord(discord: NonNullable<Config["discord"]>, rest: DiscordRest) {
  const checks: Check[] = [];
  try {
    const me = await rest<{ username: string }>("GET", "/users/@me");
    checks.push({ status: "ok", message: `Discord bot token valid (@${me.username})` });
  } catch (error) {
    checks.push({ status: "fail", message: `DISCORD_BOT_TOKEN: ${describe(error)}` });
    return checks;
  }
  for (const channel of discord.channels)
    try {
      const info = await rest<{ name?: string }>("GET", `/channels/${channel}`);
      checks.push({
        status: "ok",
        message: `Discord channel #${info.name ?? channel} reachable`,
      });
    } catch (error) {
      checks.push({
        status: "fail",
        message: `DISCORD_CHANNEL_IDS ${channel}: ${describe(error)}.${
          error instanceof DiscordError && [403, 404].includes(error.status)
            ? " Invite the bot to the server and let it view the channel."
            : ""
        }`,
      });
    }
  return checks;
}

export async function doctor(deps: {
  config: () => Config;
  proxmox?: (config: Config) => ProxmoxApi;
  fingerprint?: (url: string) => Promise<string>;
  slackCall?: SlackCall;
  discordRest?: DiscordRest;
}) {
  let config: Config;
  try {
    config = deps.config();
  } catch (error) {
    return [{ status: "fail", message: `Configuration: ${describe(error)}` }] as Check[];
  }
  const checks: Check[] = [
    {
      status: "ok",
      message: `Configuration valid for ${config.origin}${config.demo ? " (demo mode)" : ""}`,
    },
    checkDatabase(config),
  ];
  if (config.demo)
    checks.push({
      status: "warn",
      message: "Demo mode uses simulated VMs; Proxmox is not checked.",
    });
  else
    checks.push(
      ...(await checkProxmox(
        config,
        (deps.proxmox ?? ((c) => new Proxmox(c)))(config),
        { scope: storedScope(config.database), fingerprint: deps.fingerprint },
      )),
    );
  if (config.slack)
    checks.push(
      ...(await checkSlack(config.slack, deps.slackCall ?? defaultSlackCall)),
    );
  if (config.discord)
    checks.push(
      ...(await checkDiscord(
        config.discord,
        deps.discordRest ?? discordRest(config.discord.botToken),
      )),
    );
  return checks;
}

export function formatChecks(checks: Check[]) {
  const label = { ok: "ok  ", warn: "warn", fail: "FAIL" };
  return checks.map((c) => `${label[c.status]}  ${c.message}`).join("\n");
}
