# Install

Proxdesk is one server process with one SQLite database. This page installs it from the container image. To install it another way, see [NixOS](#nixos), [Nix on another Linux](#nix-on-another-linux), or [Release tarball with systemd](#release-tarball-with-systemd) further down; [Sign in](#sign-in) and the steps after it apply to every way.

Before you start, you need:

- A Proxmox API token for Proxdesk, so it can see and operate VMs: [Connect Proxmox](proxmox.md).
- A reverse proxy that terminates HTTPS and forwards WebSockets, such as Caddy or nginx, because Proxdesk serves plain HTTP: [Reverse proxy](#reverse-proxy).

## Container

Images for `linux/amd64` and `linux/arm64` are published as `ghcr.io/whexy/proxdesk`, tagged with each release version and `latest`; [Upgrade](operations.md#upgrade) lists the tags.

1. In a new directory, save the [compose file](https://github.com/whexy/proxdesk/blob/main/deploy/compose.yaml) as `compose.yaml` and [.env.example](https://github.com/whexy/proxdesk/blob/main/.env.example) as `proxdesk.env`.

2. In `proxdesk.env`, set `APP_ORIGIN` to the address people will open, such as `https://proxdesk.example.com`, and the `PROXMOX_*` values from [Connect Proxmox](proxmox.md). To trust a private CA, mount its PEM file into the container, readable by the `node` user, and point `PROXMOX_CA_FILE` at it.

3. Create the first administrator. Proxdesk asks for a password of at least 12 characters:

   ```sh
   docker compose run --rm proxdesk create-admin --email admin@example.com
   ```

4. Start Proxdesk and check its configuration:

   ```sh
   docker compose up -d
   docker compose exec proxdesk node dist/proxdesk.js doctor
   ```

   `doctor` marks each check `ok`, `warn`, or `FAIL`, and a failed check names the setting to fix.

The compose file publishes port 3000 on `127.0.0.1` for a reverse proxy on the same host, and keeps the database in the `proxdesk-data` volume. Without Compose, pass `docker run` the same settings: `--init --env-file proxdesk.env -v proxdesk-data:/app/data -p 127.0.0.1:3000:3000`. Arguments after the image name are [`proxdesk` commands](cli.md).

<details>
<summary>Create the administrator from configuration instead</summary>

Set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` (or `BOOTSTRAP_ADMIN_PASSWORD_FILE`). When Proxdesk starts with an empty database, it creates that administrator; later starts ignore the settings, so remove the password once you have signed in. On NixOS, the options are `bootstrapAdmin.email` and `bootstrapAdmin.passwordFile`. Without either an administrator or these settings, the server refuses to start.

</details>

## Reverse proxy

Point the reverse proxy at Proxdesk's port, and make it forward WebSocket upgrades on `/console-socket` with a timeout long enough for a console session; consoles close after two hours. The address people open must equal `APP_ORIGIN`, including the port.

A public address must use HTTPS. An address on a private network, such as `http://192.168.1.10:3000`, may use plain HTTP without a proxy; to accept more than one address, list the others in `APP_ADDITIONAL_ORIGINS`. See [Configuration](configuration.md#server) for the exact rules.

## Sign in

Open `APP_ORIGIN` and sign in as the administrator. Then:

1. Under **Settings**, name the workspace and, if the token sees VMs Proxdesk should not manage, set **Managed VMs** to a pool or tag.
2. Under **Members**, create accounts. Proxdesk sends no email; share each initial password privately. Members change it from the account menu.
3. Under **Members → Manage access**, grant each member actions on VMs. A new member has no VM access.

Before inviting people, run the [check in Connect Proxmox](proxmox.md#check-it) with a test member.

Next, optionally:

- [Single sign-on](sso.md) with an OpenID Connect provider.
- [The chat bot](chat.md) in Slack or Discord.
- Copy [backups](backups.md) off the server; Proxdesk takes one daily.

## NixOS

The flake provides a NixOS module. Add it as an input and enable the service:

```nix
{
  inputs.proxdesk.url = "github:whexy/proxdesk";

  outputs = { nixpkgs, proxdesk, ... }: {
    nixosConfigurations.host = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        proxdesk.nixosModules.default
        {
          services.proxdesk = {
            enable = true;
            origin = "https://proxdesk.example.com";
            proxmox = {
              url = "https://pve.example.com:8006";
              tokenId = "proxdesk@pve!portal";
              tokenSecretFile = "/etc/proxdesk/proxmox-token-secret";
              caFile = "/etc/proxdesk/proxmox-ca.pem";
            };
          };
        }
      ];
    };
  };
}
```

Options ending in `File` take paths that systemd hands to the service as credentials, so the files may stay readable only by root. The service listens on `127.0.0.1:3000` and keeps its database in `/var/lib/proxdesk`. [Configuration](configuration.md#nixos-module) lists every option.

After `nixos-rebuild switch`, the module's `proxdesk` command runs as the service user with the service's configuration. Create the administrator and check the configuration:

```sh
sudo proxdesk create-admin --email admin@example.com
sudo proxdesk doctor
```

The service restarts on failure, so it starts once the administrator exists. Then [sign in](#sign-in).

## Nix on another Linux

On a distribution with Nix but without NixOS, such as a Proxmox host, install the package into a system profile and run it with the unit it ships. As root, build the release you want into the profile:

```sh
nix build --profile /nix/var/nix/profiles/proxdesk github:whexy/proxdesk/v0.1.0
```

Create the service user, the configuration, and one root-only file per secret:

```sh
useradd --system --home-dir /var/lib/proxdesk --no-create-home --shell /usr/sbin/nologin proxdesk
install -d -m 0700 /etc/proxdesk/credentials
printf '%s' 'your-token-secret' > /etc/proxdesk/credentials/proxmox-token-secret
chmod 0600 /etc/proxdesk/credentials/proxmox-token-secret
```

In `/etc/proxdesk/proxdesk.env`, set `DATABASE_PATH=/var/lib/proxdesk/proxdesk.sqlite`, `HOST=127.0.0.1` if the reverse proxy runs on the same host, and the values from step 2 of [Container](#container) except `PROXMOX_TOKEN_SECRET`, which the unit passes from its file.

Install the unit and the root `proxdesk` command from the profile:

```sh
cp /nix/var/nix/profiles/proxdesk/share/proxdesk/proxdesk.service /etc/systemd/system/
install -m 0755 /nix/var/nix/profiles/proxdesk/share/proxdesk/proxdesk-admin /usr/local/sbin/proxdesk
```

The unit loads each secret file as a credential. For Slack, Discord, or SSO, put each token in its own file under `/etc/proxdesk/credentials` and uncomment its two lines in `/etc/systemd/system/proxdesk.service`. The `proxdesk` command reads the installed unit, so it always runs with the same configuration and credentials as the service.

Create the administrator, start the service, and check it:

```sh
proxdesk create-admin --email admin@example.com
systemctl daemon-reload
systemctl enable --now proxdesk.service
proxdesk doctor
```

Then [sign in](#sign-in).

## Release tarball with systemd

Each [release](https://github.com/whexy/proxdesk/releases) attaches `proxdesk-<version>-linux.tar.gz` with the built application and its production dependencies. It contains no native code, so it runs on any Linux architecture with Node.js 24 or newer.

As root, create the service user, unpack the release, and install the configuration and unit:

```sh
useradd --system --home-dir /var/lib/proxdesk --shell /usr/sbin/nologin proxdesk
install -d -m 0700 -o proxdesk -g proxdesk /var/lib/proxdesk
mkdir -p /opt/proxdesk /etc/proxdesk
tar -xzf proxdesk-0.1.0-linux.tar.gz -C /opt/proxdesk
ln -sfn proxdesk-0.1.0 /opt/proxdesk/app
ln -sfn /usr /opt/proxdesk/runtime
install -m 0600 /opt/proxdesk/app/.env.example /etc/proxdesk/proxdesk.env
cp /opt/proxdesk/app/deploy/proxdesk.service /etc/systemd/system/
```

The unit runs the release that `/opt/proxdesk/app` links to, so an [upgrade](operations.md#upgrade) can switch releases and switch back. It runs `/opt/proxdesk/runtime/bin/node`; the `/usr` link suits a distribution's Node.js 24, so point it at another prefix if yours lives elsewhere.

In `/etc/proxdesk/proxdesk.env`, set `DATABASE_PATH=/var/lib/proxdesk/proxdesk.sqlite`, `HOST=127.0.0.1` if the reverse proxy runs on the same host, and the values from step 2 of [Container](#container).

Create the administrator as the service user, start the service, and check it:

```sh
sh -c 'set -a; . /etc/proxdesk/proxdesk.env; cd /opt/proxdesk/app; exec runuser -u proxdesk -- /opt/proxdesk/runtime/bin/node dist/proxdesk.js create-admin --email admin@example.com'
systemctl daemon-reload
systemctl enable --now proxdesk.service
sh -c 'set -a; . /etc/proxdesk/proxdesk.env; cd /opt/proxdesk/app; exec runuser -u proxdesk -- /opt/proxdesk/runtime/bin/node dist/proxdesk.js doctor'
```

[Operations](operations.md#run-proxdesk-commands) explains the long command. Then [sign in](#sign-in).
