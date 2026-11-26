import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configFromEnv, allowsOrigin } from "../lib/config";

test("production permits private LAN HTTP and requires HTTPS for public origins", () => {
  const before = { ...process.env };
  try {
    Object.assign(process.env, {
      NODE_ENV: "production",
      DEMO_MODE: "false",
      PROXMOX_URL: "https://127.0.0.1:8006",
      PROXMOX_TOKEN_ID: "test@pve!test",
      PROXMOX_TOKEN_SECRET: "synthetic-test-secret",
      APP_ADDITIONAL_ORIGINS: "",
    });
    for (const origin of [
      "http://192.168.1.10:3000",
      "http://127.0.0.1:3000",
      "https://portal.example",
    ]) {
      process.env.APP_ORIGIN = origin;
      assert.equal(configFromEnv().origin, origin);
      assert.equal(configFromEnv().secureCookies, origin.startsWith("https:"));
    }
    for (const origin of [
      "http://public.example",
      "http://10.attacker.example",
      "https://portal.example/path",
      "https://portal.example/",
    ]) {
      process.env.APP_ORIGIN = origin;
      assert.throws(() => configFromEnv());
    }
    process.env.APP_ORIGIN = "https://portal.example";
    process.env.APP_ADDITIONAL_ORIGINS =
      "http://192.168.1.10:3000, https://second.example";
    const config = configFromEnv();
    assert.equal(allowsOrigin(config, "http://192.168.1.10:3000"), true);
    assert.equal(allowsOrigin(config, "https://second.example"), true);
    assert.equal(allowsOrigin(config, "https://portal.example"), true);
    assert.equal(allowsOrigin(config, "https://attacker.example"), false);
    assert.equal(allowsOrigin(config, "https://second.example/"), false);
    process.env.APP_ADDITIONAL_ORIGINS = "http://public.example";
    assert.throws(() => configFromEnv());
  } finally {
    process.env = before;
  }
});

test("Slack settings are all-or-nothing and reject swapped tokens or channel names", () => {
  const before = { ...process.env };
  try {
    Object.assign(process.env, {
      DEMO_MODE: "true",
      APP_ORIGIN: "http://localhost:3000",
      SLACK_APP_TOKEN: "xapp-1-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_CHANNEL_ID: "C0123ABCD",
    });
    assert.deepEqual(configFromEnv().slack, {
      appToken: "xapp-1-test",
      botToken: "xoxb-test",
      channels: ["C0123ABCD"],
    });
    process.env.SLACK_CHANNEL_ID = "C0123ABCD, G0PRIVATE";
    assert.deepEqual(configFromEnv().slack?.channels, ["C0123ABCD", "G0PRIVATE"]);
    process.env.SLACK_CHANNEL_ID = "C0123ABCD";
    for (const [key, value] of [
      ["SLACK_CHANNEL_ID", ""],
      ["SLACK_CHANNEL_ID", "#vm-requests"],
      ["SLACK_CHANNEL_ID", "C0123ABCD,#vm-requests"],
      ["SLACK_CHANNEL_ID", ","],
      ["SLACK_APP_TOKEN", "xoxb-test"],
      ["SLACK_BOT_TOKEN", "xapp-1-test"],
    ]) {
      const previous = process.env[key];
      process.env[key] = value;
      assert.throws(() => configFromEnv());
      process.env[key] = previous;
    }
    for (const key of [
      "SLACK_APP_TOKEN",
      "SLACK_BOT_TOKEN",
      "SLACK_CHANNEL_ID",
    ])
      delete process.env[key];
    assert.equal(configFromEnv().slack, undefined);
  } finally {
    process.env = before;
  }
});

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
function withEnv(env: Record<string, string | undefined>, run: () => void) {
  const before = { ...process.env };
  try {
    for (const [key, value] of Object.entries(env))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    run();
  } finally {
    process.env = before;
  }
}
const live = {
  NODE_ENV: undefined,
  DEMO_MODE: "false",
  APP_ORIGIN: "http://localhost:3000",
  APP_ADDITIONAL_ORIGINS: "",
  DATABASE_PATH: "/srv/proxdesk/db.sqlite",
  PROXMOX_URL: "https://pve.example:8006",
  PROXMOX_TOKEN_ID: "proxdesk@pve!portal",
  PROXMOX_TOKEN_SECRET: undefined,
  PROXMOX_TOKEN_SECRET_FILE: undefined,
  PROXMOX_CA_FILE: undefined,
  PROXMOX_FINGERPRINT: undefined,
  BACKUP_DIR: undefined,
  SLACK_APP_TOKEN: undefined,
  SLACK_BOT_TOKEN: undefined,
  SLACK_CHANNEL_ID: undefined,
  DISCORD_BOT_TOKEN: undefined,
  DISCORD_BOT_TOKEN_FILE: undefined,
  DISCORD_CHANNEL_IDS: undefined,
  DISCORD_ALLOW_DMS: undefined,
  PROXDESK_EXTENSIONS: undefined,
  OIDC_ISSUER: undefined,
  OIDC_CLIENT_ID: undefined,
  OIDC_CLIENT_SECRET: undefined,
  BOOTSTRAP_ADMIN_PASSWORD: undefined,
};

test("every secret can come from a file named by <NAME>_FILE", () => {
  const dir = mkdtempSync(join(tmpdir(), "proxdesk-secrets-"));
  const file = (name: string, content: string) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };
  withEnv(
    {
      ...live,
      PROXMOX_TOKEN_SECRET_FILE: file("pve", "token-from-file\n"),
      SLACK_APP_TOKEN_FILE: file("app", "xapp-file\r\n"),
      SLACK_BOT_TOKEN_FILE: file("bot", "xoxb-file"),
      SLACK_CHANNEL_ID: "C0123ABCD",
      OIDC_ISSUER: "https://issuer.example",
      OIDC_CLIENT_ID: "proxdesk",
      OIDC_CLIENT_SECRET_FILE: file("oidc", "oidc-secret\n\n"),
      BOOTSTRAP_ADMIN_PASSWORD_FILE: file("bootstrap", "bootstrap password 1\n"),
    },
    () => {
      const config = configFromEnv();
      assert.equal(config.tokenSecret, "token-from-file");
      assert.equal(config.slack?.appToken, "xapp-file");
      assert.equal(config.slack?.botToken, "xoxb-file");
      assert.equal(config.oidcClientSecret, "oidc-secret");
      assert.equal(config.bootstrapPassword, "bootstrap password 1");
    },
  );
  withEnv(
    {
      ...live,
      PROXMOX_TOKEN_SECRET: "inline",
      PROXMOX_TOKEN_SECRET_FILE: file("both", "file"),
    },
    () => assert.throws(() => configFromEnv(), /PROXMOX_TOKEN_SECRET or PROXMOX_TOKEN_SECRET_FILE, not both/),
  );
  withEnv({ ...live, PROXMOX_TOKEN_SECRET_FILE: join(dir, "missing") }, () =>
    assert.throws(() => configFromEnv(), /Cannot read PROXMOX_TOKEN_SECRET_FILE/),
  );
  withEnv({ ...live, PROXMOX_TOKEN_SECRET_FILE: file("empty", "\n") }, () =>
    assert.throws(() => configFromEnv(), /is empty/),
  );
  withEnv({ ...live, PROXMOX_TOKEN_SECRET: "inline" }, () =>
    assert.equal(configFromEnv().tokenSecret, "inline"),
  );
});

test("Proxmox trust uses a CA file or a pinned fingerprint, never both", () => {
  const fingerprint =
    "b7:56:4b:b6:ce:55:32:67:b8:16:02:8c:df:43:04:c4:34:39:4d:80:17:24:4a:51:d3:e2:21:ef:0c:a0:e9:aa";
  withEnv({ ...live, PROXMOX_TOKEN_SECRET: "s" }, () => {
    const config = configFromEnv();
    assert.equal(config.proxmoxCa, undefined);
    assert.equal(config.proxmoxFingerprint, undefined);
    assert.equal(config.backupDir, "/srv/proxdesk/backups");
  });
  withEnv(
    {
      ...live,
      PROXMOX_TOKEN_SECRET: "s",
      PROXMOX_CA_FILE: join(fixtures, "proxmox-cert.pem"),
      BACKUP_DIR: "/mnt/backups",
    },
    () => {
      const config = configFromEnv();
      assert.match(config.proxmoxCa!, /BEGIN CERTIFICATE/);
      assert.equal(config.backupDir, "/mnt/backups");
    },
  );
  withEnv(
    { ...live, PROXMOX_TOKEN_SECRET: "s", PROXMOX_FINGERPRINT: fingerprint },
    () =>
      assert.equal(
        configFromEnv().proxmoxFingerprint,
        fingerprint.toUpperCase(),
      ),
  );
  withEnv(
    {
      ...live,
      PROXMOX_TOKEN_SECRET: "s",
      PROXMOX_FINGERPRINT: fingerprint.replace(/:/g, ""),
    },
    () =>
      assert.equal(
        configFromEnv().proxmoxFingerprint,
        fingerprint.toUpperCase(),
      ),
  );
  for (const bad of ["AB:CD", fingerprint.slice(3), `${fingerprint}:00`, "zz".repeat(32)])
    withEnv(
      { ...live, PROXMOX_TOKEN_SECRET: "s", PROXMOX_FINGERPRINT: bad },
      () => assert.throws(() => configFromEnv(), /SHA-256 fingerprint/),
    );
  withEnv(
    {
      ...live,
      PROXMOX_TOKEN_SECRET: "s",
      PROXMOX_FINGERPRINT: fingerprint,
      PROXMOX_CA_FILE: join(fixtures, "proxmox-cert.pem"),
    },
    () => assert.throws(() => configFromEnv(), /not both/),
  );
  withEnv(
    {
      ...live,
      PROXMOX_TOKEN_SECRET: "s",
      PROXMOX_CA_FILE: join(fixtures, "proxmox-key.pem"),
    },
    () => assert.throws(() => configFromEnv(), /no PEM certificate/),
  );
});

test("Discord needs a bot token with channel IDs, and DMs are off by default", () => {
  const token = "MTIzNDU2Nzg5.GaBcDe.abc_DEF-123";
  withEnv({ ...live, PROXMOX_TOKEN_SECRET: "s", DISCORD_BOT_TOKEN: token, DISCORD_CHANNEL_IDS: "123456789012345678, 223456789012345678" }, () =>
    assert.deepEqual(configFromEnv().discord, {
      botToken: token,
      channels: ["123456789012345678", "223456789012345678"],
      allowDMs: false,
    }),
  );
  withEnv({ ...live, PROXMOX_TOKEN_SECRET: "s", DISCORD_BOT_TOKEN: token, DISCORD_CHANNEL_IDS: "123456789012345678", DISCORD_ALLOW_DMS: "true" }, () =>
    assert.equal(configFromEnv().discord?.allowDMs, true),
  );
  withEnv({ ...live, PROXMOX_TOKEN_SECRET: "s" }, () =>
    assert.equal(configFromEnv().discord, undefined),
  );
  for (const [env, error] of [
    [{ DISCORD_BOT_TOKEN: token }, /DISCORD_CHANNEL_IDS must be channel IDs/],
    [{ DISCORD_BOT_TOKEN: token, DISCORD_CHANNEL_IDS: "#servers" }, /DISCORD_CHANNEL_IDS must be channel IDs/],
    [{ DISCORD_BOT_TOKEN: token, DISCORD_CHANNEL_IDS: "123" }, /DISCORD_CHANNEL_IDS must be channel IDs/],
    [{ DISCORD_BOT_TOKEN: `Bot ${token}`, DISCORD_CHANNEL_IDS: "123456789012345678" }, /without the "Bot " prefix/],
    [{ DISCORD_BOT_TOKEN: "a1b2c3d4e5f6", DISCORD_CHANNEL_IDS: "123456789012345678" }, /bot token from the Developer Portal/],
    [{ DISCORD_BOT_TOKEN: token, DISCORD_CHANNEL_IDS: "123456789012345678", DISCORD_ALLOW_DMS: "yes" }, /true or false/],
    [{ DISCORD_CHANNEL_IDS: "123456789012345678" }, /need DISCORD_BOT_TOKEN/],
    [{ DISCORD_ALLOW_DMS: "true" }, /need DISCORD_BOT_TOKEN/],
  ] as const)
    withEnv({ ...live, PROXMOX_TOKEN_SECRET: "s", ...env }, () =>
      assert.throws(() => configFromEnv(), error),
    );
});

test("extensions are absolute paths or package names", () => {
  withEnv({ ...live, PROXMOX_TOKEN_SECRET: "s", PROXDESK_EXTENSIONS: "/opt/ext/a.mjs, @acme/proxdesk-ext,plain" }, () =>
    assert.deepEqual(configFromEnv().extensions, ["/opt/ext/a.mjs", "@acme/proxdesk-ext", "plain"]),
  );
  withEnv({ ...live, PROXMOX_TOKEN_SECRET: "s", PROXDESK_EXTENSIONS: "./a.mjs" }, () =>
    assert.throws(() => configFromEnv(), /absolute path or a package name/),
  );
});
