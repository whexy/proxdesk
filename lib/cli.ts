import nextEnv from "@next/env";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { configFromEnv, databaseFromEnv } from "./config";
import { doctor, formatChecks } from "./doctor";
import { serve } from "./server";
import { Store } from "./store";
import {
  exportConfiguration,
  formatPlan,
  importConfiguration,
  parseExport,
} from "./transfer";
import {
  backupDatabase,
  createAdmin,
  migrateDatabase,
  restoreDatabase,
} from "./maintenance";

// Both lib/cli.ts and the bundled dist/proxdesk.js sit one level below the app.
const appRoot = fileURLToPath(new URL("..", import.meta.url));

type Parsed = {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
};
type Command = {
  usage: string;
  summary: string;
  options?: ParseArgsConfig["options"];
  positionals?: number;
  // Defaults to positionals; lower when trailing positionals are optional.
  minPositionals?: number;
  // Long-running commands keep the process alive after run() resolves.
  daemon?: boolean;
  run(args: Parsed): Promise<number | void>;
};

const commands: Record<string, Command> = {
  serve: {
    usage: "serve [--dev] [--demo]",
    summary: "Run the web server, console proxy, and chat bot (default)",
    options: { dev: { type: "boolean" }, demo: { type: "boolean" } },
    daemon: true,
    async run({ values }) {
      if (values.demo) process.env.DEMO_MODE = "true";
      await serve({ dev: !!values.dev, dir: appRoot });
    },
  },
  migrate: {
    usage: "migrate",
    summary: "Apply pending database migrations and exit",
    async run() {
      const database = databaseFromEnv();
      const { from, to } = migrateDatabase(database);
      console.log(
        from === to
          ? `${database} is already at schema version ${to}`
          : `Migrated ${database} from schema version ${from} to ${to}`,
      );
    },
  },
  backup: {
    usage: "backup <file>",
    summary: "Write a consistent snapshot of the database while it runs",
    positionals: 1,
    async run({ positionals: [file] }) {
      backupDatabase(databaseFromEnv(), file);
      console.log(`Backed up ${databaseFromEnv()} to ${file}`);
    },
  },
  restore: {
    usage: "restore <file>",
    summary: "Replace the database with a backup; the service must be stopped",
    positionals: 1,
    async run({ positionals: [file] }) {
      const database = databaseFromEnv();
      const { previous } = restoreDatabase(database, file);
      console.log(`Restored ${database} from ${file}`);
      if (previous) console.log(`The previous database is kept at ${previous}`);
    },
  },
  export: {
    usage: "export [file]",
    summary:
      "Write settings, users, VM grants, and chat links as JSON (no passwords)",
    positionals: 1,
    minPositionals: 0,
    async run({ positionals: [file] }) {
      if (!existsSync(databaseFromEnv()))
        throw new Error(`No database at ${databaseFromEnv()}`);
      const store = new Store(databaseFromEnv());
      let text: string;
      try {
        text = `${JSON.stringify(exportConfiguration(store), null, 2)}\n`;
      } finally {
        store.close();
      }
      if (!file) {
        process.stdout.write(text);
        return;
      }
      let fd: number;
      try {
        fd = openSync(file, "wx", 0o600);
      } catch (error) {
        if ((error as { code?: string }).code === "EEXIST")
          throw new Error(`${file} already exists; choose a new file`);
        throw error;
      }
      try {
        writeSync(fd, text);
      } finally {
        closeSync(fd);
      }
      console.error(`Exported configuration to ${file}`);
    },
  },
  import: {
    usage: "import <file> [--apply]",
    summary:
      "Show what importing an export would change; --apply makes the changes",
    options: { apply: { type: "boolean" } },
    positionals: 1,
    async run({ values, positionals: [file] }) {
      const data = parseExport(readFileSync(file, "utf8"));
      const store = new Store(databaseFromEnv());
      try {
        const plan = importConfiguration(store, data, {
          dryRun: !values.apply,
          source: basename(file),
        });
        console.log(formatPlan(plan));
        console.log(
          values.apply
            ? "\nImported configuration"
            : "\nDry run: nothing changed. Run again with --apply to import.",
        );
      } finally {
        store.close();
      }
    },
  },
  "create-admin": {
    usage: "create-admin --email <email> [--name <name>]",
    summary:
      "Create an administrator; the password comes from PROXDESK_ADMIN_PASSWORD or stdin",
    options: { email: { type: "string" }, name: { type: "string" } },
    async run({ values }) {
      if (typeof values.email !== "string")
        throw new UsageError("--email is required");
      const admin = createAdmin(databaseFromEnv(), {
        email: values.email,
        name: values.name as string | undefined,
        password: await readPassword(),
      });
      console.log(`Created administrator ${admin.name} <${admin.email}>`);
    },
  },
  doctor: {
    usage: "doctor",
    summary: "Check configuration, database, Proxmox access, and chat bots",
    async run() {
      const checks = await doctor({ config: configFromEnv });
      console.log(formatChecks(checks));
      const failed = checks.filter((c) => c.status === "fail").length;
      console.log(
        failed
          ? `\n${failed} check${failed === 1 ? "" : "s"} failed`
          : "\nAll checks passed",
      );
      return failed ? 1 : 0;
    },
  },
  version: {
    usage: "version",
    summary: "Print the version",
    async run() {
      console.log(`proxdesk ${pkg.version}`);
    },
  },
};

class UsageError extends Error {}

function help() {
  const width = Math.max(...Object.values(commands).map((c) => c.usage.length));
  return [
    `Proxdesk ${pkg.version}: self-service portal for Proxmox VMs`,
    "",
    "Usage: proxdesk <command> [options]",
    "",
    ...Object.values(commands).map(
      (c) => `  ${c.usage.padEnd(width)}  ${c.summary}`,
    ),
    "",
    "Configuration is read from the environment and .env files in the",
    "application directory. DATABASE_PATH selects the database.",
  ].join("\n");
}

async function readPassword() {
  if (process.env.PROXDESK_ADMIN_PASSWORD)
    return process.env.PROXDESK_ADMIN_PASSWORD;
  if (process.stdin.isTTY) {
    const password = await prompt("Password: ");
    if ((await prompt("Repeat password: ")) !== password)
      throw new Error("The passwords do not match");
    return password;
  }
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input.replace(/\r?\n$/, "");
}

function prompt(question: string) {
  const stdin = process.stdin;
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          finish();
          return resolve(value);
        }
        if (char === "\u0003" || char === "\u0004") {
          finish();
          return reject(new Error("Cancelled"));
        }
        value = char === "\u007f" || char === "\b" ? value.slice(0, -1) : value + char;
      }
    };
    process.stderr.write(question);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
  });
}

// Resolves to an exit code, or undefined while a daemon keeps running.
export async function main(argv: string[]): Promise<number | undefined> {
  let [name, ...rest] = argv;
  if (name === "--help" || name === "-h" || name === "help") {
    console.log(help());
    return 0;
  }
  if (name === "--version" || name === "-v") name = "version";
  if (name === undefined || name.startsWith("-")) {
    rest = argv;
    name = "serve";
  }
  const command = commands[name];
  if (!command) {
    console.error(`proxdesk: unknown command "${name}"\n\n${help()}`);
    return 2;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(`Usage: proxdesk ${command.usage}\n\n${command.summary}`);
    return 0;
  }
  nextEnv.loadEnvConfig(appRoot, undefined, { info() {}, error: console.error });
  try {
    const parsed = parseArgs({
      args: rest,
      options: command.options ?? {},
      allowPositionals: !!command.positionals,
      strict: true,
    }) as Parsed;
    const count = parsed.positionals.length;
    if (
      count > (command.positionals ?? 0) ||
      count < (command.minPositionals ?? command.positionals ?? 0)
    )
      throw new UsageError(`expected: proxdesk ${command.usage}`);
    const code = await command.run(parsed);
    return command.daemon ? undefined : (code ?? 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`proxdesk ${name}: ${message}`);
    return error instanceof UsageError ||
      (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
      ? 2
      : 1;
  }
}
