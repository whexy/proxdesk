# Command-line reference

`proxdesk` runs the server and its maintenance tasks. It reads the same [configuration](configuration.md) as the server, so run it with the server's environment: [Operations](operations.md#run-proxdesk-commands) shows how for each installation. From a source checkout, run `npm run proxdesk -- <command>`, or `node dist/proxdesk.js <command>` after `npm run build`.

```text
$ proxdesk --help
Proxdesk 0.1.0: self-service portal for Proxmox VMs

Usage: proxdesk <command> [options]

  serve [--dev] [--demo]                        Run the web server, console proxy, and chat bot (default)
  migrate                                       Apply pending database migrations and exit
  backup <file>                                 Write a consistent snapshot of the database while it runs
  restore <file>                                Replace the database with a backup; the service must be stopped
  export [file]                                 Write settings, users, VM grants, and chat links as JSON (no passwords)
  import <file> [--apply]                       Show what importing an export would change; --apply makes the changes
  create-admin --email <email> [--name <name>]  Create an administrator; the password comes from PROXDESK_ADMIN_PASSWORD or stdin
  doctor                                        Check configuration, database, Proxmox access, and chat bots
  version                                       Print the version

Configuration is read from the environment and .env files in the
application directory. DATABASE_PATH selects the database.
```

The examples below ran with the default `DATABASE_PATH`, `data/proxdesk.sqlite`. `proxdesk <command> --help` prints one command's usage. A command exits with 0 on success, 1 on failure, and 2 on a usage error.

## serve

Runs the server; it is the default when no command is given. It applies pending database migrations on start, and refuses a database from a newer release.

- `--dev` runs Next.js in development mode, for working on Proxdesk.
- `--demo` simulates VMs and consoles with a separate database, `data/demo.sqlite`. Production refuses it.

## migrate

Applies pending database migrations without starting the server.

```text
$ proxdesk migrate
Migrated data/proxdesk.sqlite from schema version 0 to 4
```

## backup

Writes a consistent copy of the database to a new file, readable only by its owner, while the server runs. It refuses to overwrite a file. See [Back up and restore](backups.md).

```text
$ proxdesk backup data/backups/manual.sqlite
Backed up data/proxdesk.sqlite to data/backups/manual.sqlite
```

## restore

Replaces the database with a backup. Stop the server first; `restore` refuses while it runs. It checks that the file is a Proxdesk database this release can read, and keeps the replaced database next to it.

```text
$ proxdesk restore data/backups/manual.sqlite
Restored data/proxdesk.sqlite from data/backups/manual.sqlite
The previous database is kept at data/proxdesk.sqlite.pre-restore-2026-11-26T14-05-15-611Z
```

## export

Writes settings, users, VM grants, and chat identities as JSON, to the file if one is given and to standard output otherwise. It includes no passwords. See [Export and import](backups.md#export-and-import).

## import

Shows what importing an export would change, and changes nothing:

```text
$ proxdesk import proxdesk-config.json
Settings: no changes
Users: no changes
VM grants: no changes
Chat identities: no changes

Dry run: nothing changed. Run again with --apply to import.
```

`--apply` makes the changes, and can run while the server runs.

## create-admin

Creates an enabled administrator. The password, at least 12 characters, comes from `PROXDESK_ADMIN_PASSWORD`, a prompt on a terminal, or standard input. `--name` defaults to `Administrator`.

```text
$ proxdesk create-admin --email admin@example.com
Password:
Repeat password:
Created administrator Administrator <admin@example.com>
```

## doctor

Checks the configuration and database, that Proxmox is reachable and its certificate trusted, the token's privileges, and the Slack and Discord bots. Each line is `ok`, `warn`, or `FAIL`, and failures name the setting to fix. It exits with 1 if any check fails.

```text
$ proxdesk doctor
ok    Configuration valid for https://proxdesk.example.com
ok    Database data/proxdesk.sqlite is at schema 4
ok    Proxmox TLS trust: pinned certificate fingerprint 63:80:79:4C:A0:AC:FF:57:CD:19:33:8D:B9:F7:31:3F:47:6E:E4:5F:90:26:86:A1:FF:A0:7A:C7:41:9D:B1:18
FAIL  Proxmox at https://127.0.0.1:8006: Proxmox returned HTTP 401. Check service-account privileges and VM state.

1 check failed
```

## version

```text
$ proxdesk version
proxdesk 0.1.0
```
