import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../lib/cli";
import { Store } from "../lib/store";

async function run(argv: string[], env: Record<string, string>) {
  const before = { ...process.env };
  const log = console.log,
    error = console.error;
  const output: string[] = [];
  console.log = console.error = (...args: unknown[]) => {
    output.push(args.join(" "));
  };
  Object.assign(process.env, env);
  try {
    return { code: await main(argv), output: output.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
    process.env = before;
  }
}

test("subcommands parse arguments and report usage errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proxdesk-cli-"));
  const env = {
    DATABASE_PATH: join(dir, "proxdesk.sqlite"),
    PROXDESK_ADMIN_PASSWORD: "cli-admin-password",
  };
  assert.equal((await run(["frobnicate"], env)).code, 2);
  assert.equal((await run(["backup"], env)).code, 2);
  assert.equal((await run(["create-admin"], env)).code, 2);
  assert.equal((await run(["migrate", "--force"], env)).code, 2);
  assert.match((await run(["--help"], env)).output, /create-admin/);
  assert.match((await run(["version"], env)).output, /^proxdesk \d+\.\d+\.\d+/);

  const created = await run(
    ["create-admin", "--email", "ops@example.com", "--name", "Ops"],
    env,
  );
  assert.equal(created.code, 0, created.output);
  const store = new Store(env.DATABASE_PATH);
  assert.equal(store.findEmail("ops@example.com")?.role, "admin");
  store.close();

  const backup = join(dir, "copy.sqlite");
  assert.equal((await run(["backup", backup], env)).code, 0);
  assert.ok(existsSync(backup));
  assert.equal((await run(["backup", backup], env)).code, 1);
  assert.equal((await run(["restore", backup], env)).code, 0);
});
