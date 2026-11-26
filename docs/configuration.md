# Configuration reference

Proxdesk reads its configuration from environment variables when it starts, and from `.env` and `.env.local` files in the application directory; the environment takes precedence. Change a value, then restart. [.env.example](https://github.com/whexy/proxdesk/blob/main/.env.example) lists the common ones; on NixOS, set the [module options](#nixos-module) instead.

Settings an administrator changes in the web UI, under **Settings**, are stored in the database: the workspace name, the managed VMs, and the backup schedule.

## Environment variables

Empty means unset. Variables marked "file" can instead be read from a file: see [Secret files](#secret-files).

### Server

| Variable | Default | Meaning |
| --- | --- | --- |
| `APP_ORIGIN` | `http://localhost:3000` | The address people open, as an origin: scheme, host, and port, without a path or trailing slash. |
| `APP_ADDITIONAL_ORIGINS` | | More addresses people may open, separated by commas, such as a LAN address next to a public one. |
| `HOST` | `0.0.0.0` | Address the HTTP server listens on. |
| `PORT` | `3000` | HTTP port. |
| `DATABASE_PATH` | `data/proxdesk.sqlite` | SQLite database. A relative path resolves against the working directory. |
| `BACKUP_DIR` | `backups` next to the database | Where scheduled backups go. |
| `NODE_ENV` | | `production` in the container image, the NixOS module, the systemd unit, and `npm start`. |

In production, an origin must use HTTPS unless its host is `localhost`, `[::1]`, or an IPv4 address in `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, or `192.168.0.0/16`. A login from an HTTPS origin sets a Secure cookie, so browsers will not send it over plain HTTP.

### Proxmox

See [Connect Proxmox](proxmox.md).

| Variable | Default | Meaning |
| --- | --- | --- |
| `PROXMOX_URL` | | API address, such as `https://pve.example.com:8006`. Must use HTTPS. Required. |
| `PROXMOX_TOKEN_ID` | | API token ID, such as `proxdesk@pve!portal`. Required. |
| `PROXMOX_TOKEN_SECRET` (file) | | API token secret. Required. |
| `PROXMOX_CA_FILE` | | PEM file of the CA that issued the Proxmox certificate. Replaces the system trust store for Proxmox. |
| `PROXMOX_FINGERPRINT` | | SHA-256 fingerprint of the Proxmox certificate to accept, with or without colons. Set this or `PROXMOX_CA_FILE`, not both. |
| `NODE_EXTRA_CA_CERTS` | | Node.js's own setting: extra CAs added to the system trust store, for every connection. |

### First administrator

See [Install](install.md#container).

| Variable | Default | Meaning |
| --- | --- | --- |
| `BOOTSTRAP_ADMIN_EMAIL` | | Administrator created when the server starts with an empty database. |
| `BOOTSTRAP_ADMIN_PASSWORD` (file) | | That administrator's password, at least 12 characters. |
| `PROXDESK_ADMIN_PASSWORD` | | Password for [`proxdesk create-admin`](cli.md#create-admin), instead of a prompt. |

### Single sign-on

Set all three or none. See [Single sign-on](sso.md).

| Variable | Meaning |
| --- | --- |
| `OIDC_ISSUER` | OpenID Connect issuer URL. |
| `OIDC_CLIENT_ID` | Client ID. |
| `OIDC_CLIENT_SECRET` (file) | Client secret. |

### Slack

Set all three or none. See [Chat bot](chat.md#set-up-slack).

| Variable | Meaning |
| --- | --- |
| `SLACK_APP_TOKEN` (file) | App-level token, starting `xapp-`. |
| `SLACK_BOT_TOKEN` (file) | Bot token, starting `xoxb-`. |
| `SLACK_CHANNEL_ID` | Channel IDs the bot answers in, such as `C0123ABCD45`, separated by commas. |

### Discord

Set the token and channels together. See [Chat bot](chat.md#set-up-discord).

| Variable | Default | Meaning |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` (file) | | Bot token from the application's **Bot** page, without a `Bot ` prefix. |
| `DISCORD_CHANNEL_IDS` | | Channel IDs the bot answers in, such as `1234567890123456789`, separated by commas. Threads under them are included. |
| `DISCORD_ALLOW_DMS` | `false` | `true` also takes requests in direct messages to the bot. |

### Extensions

| Variable | Meaning |
| --- | --- |
| `PROXDESK_EXTENSIONS` | Extension modules to load at start: absolute paths or package names, separated by commas. See [Extending Proxdesk](extending.md). |

### Demo

| Variable | Meaning |
| --- | --- |
| `DEMO_MODE` | `true` simulates VMs and consoles instead of using Proxmox, with its own database, `data/demo.sqlite`. Set by `proxdesk serve --demo` and `npm run dev`. Refused when `NODE_ENV` is `production`. |

## Secret files

Each variable marked "file" above can instead be read from the file that `<NAME>_FILE` names, such as `PROXMOX_TOKEN_SECRET_FILE=/run/secrets/proxmox-token-secret`, as Docker secrets and systemd credentials provide. A trailing newline is ignored. Setting both `<NAME>` and `<NAME>_FILE` is an error.

## NixOS module

The module is `nixosModules.default` in the flake; its options are under `services.proxdesk`. Options ending in `File` name files that systemd passes to the service as credentials, so the files may stay readable only by root. `environmentFile` and the secret options, every `File` option except `proxmox.caFile`, take an absolute path as a string, such as `"/run/secrets/proxmox-token"`, and refuse a Nix path such as `./secret` or a path in the Nix store, which would copy the secret into the world-readable store. `proxmox.caFile` is not secret and takes either. Source: [nix/module.nix](https://github.com/whexy/proxdesk/blob/main/nix/module.nix).

| Option | Default | Sets |
| --- | --- | --- |
| `enable` | `false` | |
| `package` | the flake's package | |
| `origin` | required | `APP_ORIGIN` |
| `additionalOrigins` | `[ ]` | `APP_ADDITIONAL_ORIGINS` |
| `host` | `"127.0.0.1"` | `HOST` |
| `port` | `3000` | `PORT` |
| `openFirewall` | `false` | Opens `port` in the firewall. |
| `user`, `group` | `"proxdesk"` | Service account; created when left at the default. |
| `dataDir` | `"/var/lib/proxdesk"` | Holds the database. Relative paths given to the `proxdesk` command resolve against it. |
| `environmentFile` | `null` | A file of `KEY=value` lines, read by systemd as root, for variables without an option. |
| `proxmox.url`, `proxmox.tokenId` | `null` | `PROXMOX_URL`, `PROXMOX_TOKEN_ID` |
| `proxmox.tokenSecretFile` | `null` | `PROXMOX_TOKEN_SECRET` |
| `proxmox.caFile`, `proxmox.fingerprint` | `null` | `PROXMOX_CA_FILE`, `PROXMOX_FINGERPRINT`; set at most one. |
| `slack.appTokenFile`, `slack.botTokenFile` | `null` | `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN` |
| `slack.channelIds` | `[ ]` | `SLACK_CHANNEL_ID`. `slack.channelId` takes a single ID; set one of the two. |
| `discord.botTokenFile` | `null` | `DISCORD_BOT_TOKEN` |
| `discord.channelIds` | `[ ]` | `DISCORD_CHANNEL_IDS`; required with `discord.botTokenFile`. |
| `discord.allowDMs` | `false` | `DISCORD_ALLOW_DMS` |
| `extensions` | `[ ]` | `PROXDESK_EXTENSIONS`. Accepts Nix paths, which are copied to the store. |
| `oidc.issuer`, `oidc.clientId`, `oidc.clientSecretFile` | `null` | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` |
| `bootstrapAdmin.email`, `bootstrapAdmin.passwordFile` | `null` | `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` |
| `settings` | `{ }` | Any other environment variables, such as `BACKUP_DIR`. They end up in the Nix store, so keep secrets out. |

The module also installs a `proxdesk` command for root that runs as the service user with the service's configuration; see [Operations](operations.md#run-proxdesk-commands).

## Files

Where a [release tarball installation](install.md#release-tarball-with-systemd) keeps things. The NixOS module uses the same `/var/lib/proxdesk`; the container keeps the database and backups in `/app/data`.

| Path | Contents |
| --- | --- |
| `/opt/proxdesk/proxdesk-<version>` | One unpacked release |
| `/opt/proxdesk/app` | Link to the release the service runs |
| `/opt/proxdesk/runtime` | Link to the Node.js prefix the service runs, such as `/usr` |
| `/etc/proxdesk/proxdesk.env` | Configuration and secrets, readable only by root |
| `/var/lib/proxdesk/proxdesk.sqlite` | The database: accounts, grants, chat links, settings, operations, and audit history |
| `/var/lib/proxdesk/proxdesk.sqlite.lock` | Held by the running server, so that a restore cannot replace the database under it |
| `/var/lib/proxdesk/backups` | Scheduled backups |
| `/var/cache/proxdesk` | Next.js cache |
