# Back up and restore

The database holds accounts, password hashes, VM grants, chat links, settings, and audit history. Proxdesk backs it up on a schedule; copying the backups off the server, and keeping the configuration, is up to you.

Run the commands on this page as [Operations](operations.md#run-proxdesk-commands) shows for your installation.

## Scheduled backups

By default, the server writes a backup every 24 hours and keeps the newest 14. Change both, or turn scheduling off, under **Settings → Backups**; **Back up now** takes one immediately.

Backups go to `BACKUP_DIR`, by default a `backups` directory next to the database, such as `/var/lib/proxdesk/backups`. Each is named `proxdesk-<UTC time>.sqlite` and readable only by the service user. Pruning removes only files with that name, oldest first, including those from **Back up now**.

The next backup is due one interval after the newest one, so a server that was down takes one when it starts. A failed backup is retried hourly and shown under **Settings → Backups** and in the log.

Backups contain password hashes, so the web UI does not offer them for download. Copy them off the server with your usual file backup.

## Back up from the command line

`proxdesk backup` writes a consistent backup while the server runs. It refuses to overwrite a file:

```sh
proxdesk backup /var/lib/proxdesk/backups/manual.sqlite
```

## Restore

Stop the server, restore, and start it again:

```sh
proxdesk restore /var/lib/proxdesk/backups/proxdesk-2026-11-26T03-00-00-000Z.sqlite
```

`restore` refuses while the server runs, and refuses a file that is not a Proxdesk database this release can read. The replaced database is kept as `proxdesk.sqlite.pre-restore-<time>` next to it.

## Export and import

An export is a JSON file with the settings, users, VM grants, and chat identities. It contains no passwords, sessions, operations, or audit history. Use it to review the configuration, keep it in version control, or move it to a new installation:

```sh
proxdesk export proxdesk-config.json
proxdesk import proxdesk-config.json
proxdesk import proxdesk-config.json --apply
```

`import` alone prints what it would change and changes nothing. With `--apply`, it makes those changes in one transaction and records them in the audit log; the server may keep running.

Import matches users by email, and a chat-only member, which has no email, by one of its chat identities, such as `slack:U0123ABCD`. Then:

- Existing users get the file's name, role, and status, unless that would leave no enabled administrator who can sign in.
- New users get no password. Chat-only members and users with a single sign-on identity in the file are created as the file says; the others stay disabled until an administrator sets a password under **Members**.
- Only an account that can sign in to the web, with an email and a password or single sign-on identity, can be an administrator. Other accounts the file names as administrators are imported as members, with a warning.
- Each user in the file gets exactly the file's VM grants. Users missing from the file are left unchanged.
- Chat identities and settings in the file are added or updated, and an identity linked to another account moves to the file's account.

<details>
<summary>Importing an export from before chat identities (format version 1)</summary>

Version 1 files still import. Their Slack links, which tied a Slack user to one VM, become chat-only members with every action on that VM except the console, as the database upgrade does.

</details>

## Keep the configuration too

The database does not hold the server's configuration. Keep these as well:

- The environment file, such as `/etc/proxdesk/proxdesk.env` or `proxdesk.env`, or your NixOS configuration.
- Every secret file it names, and `PROXMOX_CA_FILE` if you use one.

Lost tokens can be recreated in Proxmox, Slack, or Discord, but then every one must be updated in the configuration.
