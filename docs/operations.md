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

**Nix on another Linux.** [Unattended upgrades](#unattended-upgrades) install new releases with the same major version. For a new major version, or to upgrade now, run as root:

```sh
proxdesk-upgrade 1.0.0
```

It takes the same steps, backup and rollback as an unattended upgrade. Without a version, it installs the newest release its policy allows.

To go back after an upgrade that succeeded, stop the service, switch the profile to its previous generation, restore the backup the upgrade took, and start. Turn off unattended upgrades first, or the next run installs the release again:

```sh
systemctl disable --now proxdesk-upgrade.timer
systemctl stop proxdesk.service
nix profile rollback --profile /nix/var/nix/profiles/proxdesk
proxdesk restore backups/pre-0.2.0-20261127T041500Z.sqlite
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

### Unattended upgrades

On [Nix on another Linux](install.md#nix-on-another-linux), `proxdesk-upgrade.timer` checks daily, between 04:00 and 05:00, for a release with the same major version, such as 0.2.1 or 0.3.0 on 0.2.0, but not 1.0.0. When one is out, it:

1. Checks that `proxdesk doctor` passes; if not, it does not upgrade.
2. Backs up the database to `/var/lib/proxdesk/backups/pre-<version>-<time>.sqlite`.
3. Builds the release into the profile, installs its units, and restarts the service.
4. Rolls back to the previous release and the backup if the new one does not start within two minutes or `doctor` fails. It then skips that release until a newer one is out or you name it with `proxdesk-upgrade <version>`.

A run that did not upgrade because of a failure leaves `proxdesk-upgrade.service` failed, so it shows in `systemctl --failed`. Its log says why:

```sh
journalctl -u proxdesk-upgrade.service -n 50
```

`proxdesk-upgrade --check` shows what the next run would do, without changing anything:

```text
$ proxdesk-upgrade --check
Proxdesk 0.1.0 would be upgraded to 0.2.0
```

To install only patch releases, such as 0.2.1 but not 0.3.0, run `systemctl edit proxdesk-upgrade.service` and add:

```ini
[Service]
Environment=PROXDESK_UPGRADE_POLICY=patch
```

To turn unattended upgrades off, run `systemctl disable --now proxdesk-upgrade.timer`.

<details>
<summary>Turn on unattended upgrades for an install with its unit in /etc/systemd/system</summary>

Earlier installs copied `proxdesk.service` to `/etc/systemd/system`, which hides the units that upgrades install. As root, move your own lines into a drop-in and install the shipped units:

1. Back up the database with `proxdesk backup backups/pre-unattended.sqlite`, then build the first release that ships `proxdesk-upgrade` (see the [changelog](https://github.com/whexy/proxdesk/blob/main/CHANGELOG.md)) with `nix build --profile /nix/var/nix/profiles/proxdesk github:whexy/proxdesk/v<version>`.
2. Compare `/etc/systemd/system/proxdesk.service` with `/nix/var/nix/profiles/proxdesk/share/proxdesk/proxdesk.service`, and put the lines only yours has, such as further credentials, in `/etc/systemd/system/proxdesk.service.d/credentials.conf` under `[Service]`.
3. Remove `/etc/systemd/system/proxdesk.service`, then install the units and commands as in [Nix on another Linux](install.md#nix-on-another-linux).
4. Point the service's boot link at the new unit and turn on the timer. The link still names the removed file, so without `reenable` Proxdesk does not start at boot:

   ```sh
   systemctl daemon-reload
   systemctl reenable proxdesk.service
   systemctl enable --now proxdesk-upgrade.timer
   systemctl restart proxdesk.service
   proxdesk doctor
   ```

</details>

Containers and NixOS do not have this. An image auto-updater pointed at a minor-series tag, such as `0.2`, upgrades a container but cannot roll back its database. NixOS upgrades Proxdesk when the flake input updates and the system is rebuilt, so `system.autoUpgrade` upgrades it only if it updates that input.

## Run one instance

Run exactly one Proxdesk server per database. Console tickets and rate limits live in its memory, so several replicas behind a load balancer do not work. The server holds a lock next to the database so that a second server or a `restore` cannot use it at the same time.
