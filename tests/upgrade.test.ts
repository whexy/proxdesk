import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dirname, "../deploy/nix/proxdesk-upgrade");

// Stubs for the host commands the script drives. Each appends its arguments
// to a log; the installed version lives in a file that `nix build` and
// `nix profile rollback` rewrite, and a doctor marker file makes doctor fail.
const stubs: Record<string, string> = {
  git: `printf '%s\\n' $TAGS | sed 's|^|0000\\trefs/tags/|'`,
  nix: `case $1 in
  build) echo "$PREVIOUS" > "$ROOT/previous"; v=\${@: -1}; echo "\${v##*/v}" > "$ROOT/version" ;;
  profile) cp "$ROOT/previous" "$ROOT/version" ;;
esac`,
  systemctl: `case $1 in
  show) case $2 in *InvocationID*) echo inv ;; *) echo active ;; esac ;;
  restart) [ -f "$ROOT/broken-$(cat "$ROOT/version")" ] && touch "$ROOT/doctor-fails" || true ;;
  stop) rm -f "$ROOT/doctor-fails" ;;
esac`,
  journalctl: `echo "Proxdesk listening on 0.0.0.0:3000"`,
  id: `echo 0`,
};

function setup(version: string, tags: string[]) {
  const root = mkdtempSync(join(tmpdir(), "proxdesk-upgrade-"));
  const bin = join(root, "bin");
  const profile = join(root, "profile");
  for (const dir of [bin, join(profile, "bin"), join(profile, "share/proxdesk"), join(root, "data/backups")])
    mkdirSync(dir, { recursive: true });
  const write = (path: string, body: string) => {
    writeFileSync(path, `#!/bin/bash\necho "${path.split("/").pop()} $*" >> "$ROOT/log"\n${body}\n`);
    chmodSync(path, 0o755);
  };
  for (const [name, body] of Object.entries(stubs)) write(join(bin, name), body);
  write(join(profile, "bin/proxdesk"), `echo "proxdesk $(cat "$ROOT/version")"`);
  write(
    join(profile, "share/proxdesk/proxdesk-admin"),
    `[ "$1" = doctor ] && [ -f "$ROOT/doctor-fails" ] && exit 1; exit 0`,
  );
  writeFileSync(join(profile, "share/proxdesk/proxdesk.service"), "");
  writeFileSync(join(root, "version"), `${version}\n`);
  const env = {
    ...process.env,
    ROOT: root,
    TAGS: tags.map((tag) => `v${tag}`).join(" "),
    PREVIOUS: version,
    PATH: `${bin}:${process.env.PATH}`,
    PROXDESK_PROFILE: profile,
    PROXDESK_DATA_DIR: join(root, "data"),
    PROXDESK_UNIT_DIR: join(root, "units"),
    STATE_DIRECTORY: join(root, "state"),
  };
  const run = (extra: Record<string, string> = {}, args: string[] = []) => {
    writeFileSync(join(root, "log"), "");
    const result = spawnSync("bash", [script, ...args], {
      env: { ...env, ...extra },
      encoding: "utf8",
    });
    return {
      code: result.status,
      output: result.stdout + result.stderr,
      log: readFileSync(join(root, "log"), "utf8"),
      version: readFileSync(join(root, "version"), "utf8").trim(),
    };
  };
  return { root, run };
}

test("upgrades within the major version and backs up first", () => {
  const { root, run } = setup("0.1.0", ["0.1.0", "0.1.1", "0.2.0", "0.2.1", "1.0.0"]);
  const result = run();
  assert.equal(result.code, 0, result.output);
  assert.equal(result.version, "0.2.1");
  assert.match(result.output, /Proxdesk 1\.0\.0 is available; policy minor/);
  const steps = result.log.split("\n").map((line) => line.split(" ").slice(0, 2).join(" "));
  assert.deepEqual(
    steps.filter((step) => /^(proxdesk-admin|nix|systemctl (restart|daemon-reload))/.test(step)),
    ["proxdesk-admin doctor", "proxdesk-admin backup", "nix build", "systemctl daemon-reload", "systemctl restart", "proxdesk-admin doctor"],
  );
  assert.match(result.log, /backup .*\/data\/backups\/pre-0\.2\.1-\d{8}T\d{6}Z\.sqlite/);
  assert.match(result.log, /nix build --no-link --profile .* github:whexy\/proxdesk\/v0\.2\.1/);
  assert.ok(existsSync(join(root, "units/proxdesk.service")));

  const again = run();
  assert.equal(again.code, 0);
  assert.match(again.output, /Proxdesk 0\.2\.1 is up to date/);
  assert.doesNotMatch(again.log, /nix build/);
});

test("the patch policy stays on the minor version, and --check changes nothing", () => {
  const { run } = setup("0.1.0", ["0.1.0", "0.1.1", "0.2.0"]);
  const check = run({ PROXDESK_UPGRADE_POLICY: "patch" }, ["--check"]);
  assert.equal(check.code, 0);
  assert.match(check.output, /0\.1\.0 would be upgraded to 0\.1\.1/);
  assert.equal(check.version, "0.1.0");
  assert.doesNotMatch(check.log, /nix|backup/);
  assert.equal(run({ PROXDESK_UPGRADE_POLICY: "patch" }).version, "0.1.1");
  assert.equal(run({ PROXDESK_UPGRADE_POLICY: "latest" }).code, 2);
});

test("a release that fails doctor is rolled back and then skipped", () => {
  const { root, run } = setup("0.1.0", ["0.1.0", "0.2.0"]);
  writeFileSync(join(root, "broken-0.2.0"), "");
  const failed = run();
  assert.equal(failed.code, 1, failed.output);
  assert.equal(failed.version, "0.1.0");
  const backup = /backup (\S+)/.exec(failed.log)![1];
  assert.match(failed.log, new RegExp(`systemctl stop proxdesk.service\nnix profile rollback .*\nproxdesk-admin restore ${backup}\n`));
  assert.match(failed.log, /systemctl start proxdesk.service/);
  assert.equal(readFileSync(join(root, "state/failed"), "utf8"), "0.2.0\n");

  const skipped = run();
  assert.equal(skipped.code, 1);
  assert.match(skipped.output, /0\.2\.0 was rolled back after a failed upgrade/);
  assert.doesNotMatch(skipped.log, /nix build/);
});

test("does not upgrade when doctor already fails", () => {
  const { root, run } = setup("0.1.0", ["0.1.0", "0.2.0"]);
  writeFileSync(join(root, "doctor-fails"), "");
  const result = run();
  assert.equal(result.code, 1);
  assert.match(result.output, /Not upgrading: proxdesk doctor fails/);
  assert.doesNotMatch(result.log, /backup|nix build/);
});

test("a named release is installed past the policy and past an earlier failure", () => {
  const { root, run } = setup("0.2.0", ["0.2.0", "1.0.0"]);
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state/failed"), "1.0.0\n");
  assert.equal(run({}, ["--check", "v1.0.0"]).version, "0.2.0");
  assert.equal(run({}, ["9.9.9"]).code, 2);
  assert.equal(run({}, ["0.1.0"]).code, 2);
  const result = run({}, ["1.0.0"]);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.version, "1.0.0");
});
