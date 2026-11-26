import path from "node:path";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
export type Config = {
  demo: boolean;
  origin: string;
  additionalOrigins?: string[];
  database: string;
  secureCookies: boolean;
  proxmoxUrl?: string;
  tokenId?: string;
  tokenSecret?: string;
  /** PEM bundle; when set, it replaces the system trust store for Proxmox. */
  proxmoxCa?: string;
  proxmoxCaFile?: string;
  /** Upper-case, colon-separated SHA-256 fingerprint of the Proxmox leaf certificate. */
  proxmoxFingerprint?: string;
  backupDir?: string;
  bootstrapEmail?: string;
  bootstrapPassword?: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  slack?: { appToken: string; botToken: string; channels: string[] };
  discord?: { botToken: string; channels: string[]; allowDMs: boolean };
  /** Extension modules loaded at serve start: absolute paths or package names. */
  extensions?: string[];
};
function validateOrigin(origin: string) {
  const url = new URL(origin);
  if (url.origin !== origin || !["http:", "https:"].includes(url.protocol))
    throw new Error(
      "APP_ORIGIN must be an origin without a path or trailing slash",
    );
  const host = url.hostname;
  const privateHost =
    host === "localhost" ||
    host === "[::1]" ||
    (isIP(host) === 4 &&
      (/^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host)));
  if (
    process.env.NODE_ENV === "production" &&
    url.protocol !== "https:" &&
    !privateHost
  )
    throw new Error(
      "Production APP_ORIGIN must use HTTPS or a private/loopback HTTP address",
    );
  return url;
}
export function allowsOrigin(
  config: Config,
  origin: string | null | undefined,
) {
  return (
    !!origin &&
    (origin === config.origin || !!config.additionalOrigins?.includes(origin))
  );
}
// Secrets may come from a file named by <NAME>_FILE, as container and
// systemd credential mounts provide them.
export function secretFromEnv(name: string) {
  const value = process.env[name];
  const file = process.env[`${name}_FILE`];
  if (value && file) throw new Error(`Set ${name} or ${name}_FILE, not both`);
  if (!file) return value || undefined;
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot read ${name}_FILE ${file}: ${(error as Error).message}`,
    );
  }
  content = content.replace(/[\r\n]+$/, "");
  if (!content) throw new Error(`${name}_FILE ${file} is empty`);
  return content;
}
export function normalizeFingerprint(value: string) {
  const hex = value.trim().replace(/:/g, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex))
    throw new Error(
      "PROXMOX_FINGERPRINT must be a SHA-256 fingerprint: 32 colon-separated hex bytes",
    );
  return hex.match(/../g)!.join(":");
}
function proxmoxTrust() {
  const caFile = process.env.PROXMOX_CA_FILE || undefined;
  const fingerprint = process.env.PROXMOX_FINGERPRINT || undefined;
  if (caFile && fingerprint)
    throw new Error(
      "Set PROXMOX_CA_FILE or PROXMOX_FINGERPRINT, not both: a pinned fingerprint skips CA validation",
    );
  if (fingerprint)
    return { proxmoxFingerprint: normalizeFingerprint(fingerprint) };
  if (!caFile) return {};
  let ca: string;
  try {
    ca = readFileSync(caFile, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot read PROXMOX_CA_FILE ${caFile}: ${(error as Error).message}`,
    );
  }
  if (!ca.includes("-----BEGIN CERTIFICATE-----"))
    throw new Error(`PROXMOX_CA_FILE ${caFile} contains no PEM certificate`);
  return { proxmoxCa: ca, proxmoxCaFile: caFile };
}
export function backupDirFromEnv(database = databaseFromEnv()) {
  return process.env.BACKUP_DIR || path.join(path.dirname(database), "backups");
}
export function databaseFromEnv() {
  return (
    process.env.DATABASE_PATH ||
    path.join(
      "data",
      process.env.DEMO_MODE === "true" ? "demo.sqlite" : "proxdesk.sqlite",
    )
  );
}
export function configFromEnv(): Config {
  const demo = process.env.DEMO_MODE === "true";
  const origin = process.env.APP_ORIGIN || "http://localhost:3000";
  const url = validateOrigin(origin);
  const additionalOrigins = (process.env.APP_ADDITIONAL_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const value of additionalOrigins) validateOrigin(value);
  if (demo && process.env.NODE_ENV === "production")
    throw new Error("Demo mode cannot run in production");
  const tokenSecret = secretFromEnv("PROXMOX_TOKEN_SECRET");
  if (
    !demo &&
    (!process.env.PROXMOX_URL || !process.env.PROXMOX_TOKEN_ID || !tokenSecret)
  )
    throw new Error(
      "Configure PROXMOX_URL, PROXMOX_TOKEN_ID, and PROXMOX_TOKEN_SECRET, or run npm run dev for demo mode",
    );
  if (!demo && new URL(process.env.PROXMOX_URL!).protocol !== "https:")
    throw new Error("PROXMOX_URL must use HTTPS");
  const oidc = [
    process.env.OIDC_ISSUER,
    process.env.OIDC_CLIENT_ID,
    secretFromEnv("OIDC_CLIENT_SECRET"),
  ];
  if (oidc.some(Boolean) && !oidc.every(Boolean))
    throw new Error("All three OIDC settings are required");
  const slack = [
    secretFromEnv("SLACK_APP_TOKEN"),
    secretFromEnv("SLACK_BOT_TOKEN"),
    process.env.SLACK_CHANNEL_ID,
  ];
  if (slack.some(Boolean) && !slack.every(Boolean))
    throw new Error(
      "Set all of SLACK_APP_TOKEN, SLACK_BOT_TOKEN, and SLACK_CHANNEL_ID",
    );
  if (slack[0] && !slack[0].startsWith("xapp-"))
    throw new Error("SLACK_APP_TOKEN must be an app-level token (xapp-…)");
  if (slack[1] && !slack[1].startsWith("xoxb-"))
    throw new Error("SLACK_BOT_TOKEN must be a bot token (xoxb-…)");
  const channels = (slack[2] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (slack[2] && (!channels.length || channels.some((c) => !/^[CG][A-Z0-9]+$/.test(c))))
    throw new Error(
      "SLACK_CHANNEL_ID must be channel IDs such as C0123456789, separated by commas, not names",
    );
  const trust = proxmoxTrust();
  const discord = discordFromEnv();
  const extensions = extensionsFromEnv();
  const bootstrapPassword = secretFromEnv("BOOTSTRAP_ADMIN_PASSWORD");
  const database = databaseFromEnv();
  return {
    demo,
    origin,
    additionalOrigins,
    database,
    backupDir: backupDirFromEnv(database),
    secureCookies: url.protocol === "https:",
    proxmoxUrl: process.env.PROXMOX_URL?.replace(/\/$/, ""),
    tokenId: process.env.PROXMOX_TOKEN_ID,
    tokenSecret,
    ...trust,
    bootstrapEmail: process.env.BOOTSTRAP_ADMIN_EMAIL,
    bootstrapPassword,
    oidcIssuer: oidc[0],
    oidcClientId: oidc[1],
    oidcClientSecret: oidc[2],
    slack: slack[0]
      ? { appToken: slack[0], botToken: slack[1]!, channels }
      : undefined,
    discord,
    extensions,
  };
}
const list = (value: string | undefined) =>
  (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
function discordFromEnv() {
  const token = secretFromEnv("DISCORD_BOT_TOKEN");
  const channelIds = process.env.DISCORD_CHANNEL_IDS;
  const allowDMs = process.env.DISCORD_ALLOW_DMS || "";
  if (!token) {
    if (channelIds || allowDMs)
      throw new Error("DISCORD_CHANNEL_IDS and DISCORD_ALLOW_DMS need DISCORD_BOT_TOKEN");
    return undefined;
  }
  if (/^Bot\s/i.test(token))
    throw new Error("DISCORD_BOT_TOKEN must be the token alone, without the \"Bot \" prefix");
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
    throw new Error(
      "DISCORD_BOT_TOKEN must be a bot token from the Developer Portal's Bot page, not the client secret or public key",
    );
  const channels = list(channelIds);
  if (!channels.length || channels.some((c) => !/^\d{17,20}$/.test(c)))
    throw new Error(
      "DISCORD_CHANNEL_IDS must be channel IDs such as 1234567890123456789, separated by commas, not names",
    );
  if (!["", "true", "false"].includes(allowDMs))
    throw new Error("DISCORD_ALLOW_DMS must be true or false");
  return { botToken: token, channels, allowDMs: allowDMs === "true" };
}
function extensionsFromEnv() {
  const modules = list(process.env.PROXDESK_EXTENSIONS);
  for (const module of modules)
    if (module.startsWith(".") || (!path.isAbsolute(module) && module.includes("\\")))
      throw new Error(
        `PROXDESK_EXTENSIONS entry "${module}" must be an absolute path or a package name`,
      );
  return modules;
}
