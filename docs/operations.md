# Operations

How to run maintenance commands, change the configuration, read logs, and upgrade, for each way to [install](install.md) Proxdesk. Backups have [their own page](backups.md).

## Run proxdesk commands

[`proxdesk` commands](cli.md) must run with the server's configuration and as the user that owns the database.

**Container.** While the server runs, use `exec`; paths are inside the container, where the data volume is `/app/data`:

```sh
docker compose exec proxdesk node dist/proxdesk.js doctor
```

While it is stopped, as for `restore`, use `run`, which takes `proxdesk` arguments directly:

```sh
docker compose run --rm proxdesk restore /app/data/backups/pre-upgrade.sqlite
```

**NixOS.** The module installs a `proxdesk` command for root, which runs as the service user with the service's configuration and credentials. Relative paths resolve against `/var/lib/proxdesk`:

```sh
sudo proxdesk doctor
```

**Nix on another Linux.** The installed `proxdesk` command works as on NixOS: `sudo proxdesk doctor`.

**Release tarball.** Load the environment file and run as the `proxdesk` user:

```sh
sudo sh -c 'set -a; . /etc/proxdesk/proxdesk.env; cd /opt/proxdesk/app; exec runuser -u proxdesk -- /opt/proxdesk/runtime/bin/node dist/proxdesk.js doctor'
```

Replace `doctor` with any other command, such as `backup /var/lib/proxdesk/backups/pre-upgrade.sqlite`.

## Change the configuration

Change the [configuration](configuration.md), then apply it:

- Container: edit `proxdesk.env`, then run `docker compose up -d`, which recreates the container with the new values.
- NixOS: change `services.proxdesk`, then run `nixos-rebuild switch`.
- Release tarball: edit `/etc/proxdesk/proxdesk.env` as root, then run `systemctl restart proxdesk.service`.

Settings under **Settings** in the web UI take effect without a restart.

## Read logs

The server logs to standard output: startup, scheduled backups, chat bot connections, and errors.

```sh
docker compose logs proxdesk                 # container
journalctl -u proxdesk.service -n 50         # NixOS and release tarball
```

Requests made through the web UI and the chat bot are in the audit log under **Activity**.

## Upgrade

A new release migrates the database when it starts. An older release refuses to open a migrated database, so going back means restoring a backup taken before the upgrade. Each upgrade below takes that backup first.

**Container.** Images are tagged with each version, such as `0.2.0`, with each minor series, such as `0.2`, and `latest`. Set the tag you want in `compose.yaml`, then:

```sh
docker compose exec proxdesk node dist/proxdesk.js backup /app/data/backups/pre-upgrade.sqlite
docker compose pull
docker compose up -d
```

To go back, set the previous tag again, then:

```sh
docker compose stop
docker compose run --rm proxdesk restore /app/data/backups/pre-upgrade.sqlite
docker compose up -d
```

**NixOS.** Update the flake input, then switch:

```sh
sudo proxdesk backup backups/pre-upgrade.sqlite
nix flake update proxdesk
sudo nixos-rebuild switch
```

To go back, switch to the previous configuration, then restore with the service stopped:

```sh
sudo nixos-rebuild switch --rollback
sudo systemctl stop proxdesk.service
sudo proxdesk restore backups/pre-upgrade.sqlite
sudo systemctl start proxdesk.service
```

**Nix on another Linux.** Build the new release into the profile and restart, as root:

```sh
proxdesk backup backups/pre-0.2.0.sqlite
nix build --profile /nix/var/nix/profiles/proxdesk github:whexy/proxdesk/v0.2.0
systemctl restart proxdesk.service
```

If `/nix/var/nix/profiles/proxdesk/share/proxdesk/proxdesk.service` differs from `/etc/systemd/system/proxdesk.service`, merge the change into the installed unit, keeping your credential lines, and run `systemctl daemon-reload` before the restart.

To go back, stop the service, switch the profile to its previous generation, restore the backup, and start:

```sh
systemctl stop proxdesk.service
nix profile rollback --profile /nix/var/nix/profiles/proxdesk
proxdesk restore backups/pre-0.2.0.sqlite
systemctl start proxdesk.service
```

**Release tarball.** Each release unpacks to its own `/opt/proxdesk/proxdesk-<version>` directory, and `/opt/proxdesk/app` links to the one that runs. To upgrade, for example from 0.1.0 to 0.2.0, unpack the new release next to the current one, take a backup, switch the link, and restart, as root:

```sh
tar -xzf proxdesk-0.2.0-linux.tar.gz -C /opt/proxdesk
sh -c 'set -a; . /etc/proxdesk/proxdesk.env; cd /opt/proxdesk/app; exec runuser -u proxdesk -- /opt/proxdesk/runtime/bin/node dist/proxdesk.js backup /var/lib/proxdesk/backups/pre-0.2.0.sqlite'
ln -sfn proxdesk-0.2.0 /opt/proxdesk/app
systemctl restart proxdesk.service
```

If the new release's `deploy/proxdesk.service` differs from `/etc/systemd/system/proxdesk.service`, copy it over and run `systemctl daemon-reload` before the restart.

To go back, stop the service, point the link at the previous release, restore the backup with that release, and start:

```sh
systemctl stop proxdesk.service
ln -sfn proxdesk-0.1.0 /opt/proxdesk/app
sh -c 'set -a; . /etc/proxdesk/proxdesk.env; cd /opt/proxdesk/app; exec runuser -u proxdesk -- /opt/proxdesk/runtime/bin/node dist/proxdesk.js restore /var/lib/proxdesk/backups/pre-0.2.0.sqlite'
systemctl start proxdesk.service
```

Changes made after the backup are lost. Remove old release directories once you no longer need them.

After any upgrade, check the log and run [`doctor`](cli.md#doctor).

## Run one instance

Run exactly one Proxdesk server per database. Console tickets and rate limits live in its memory, so several replicas behind a load balancer do not work. The server holds a lock next to the database so that a second server or a `restore` cannot use it at the same time.
