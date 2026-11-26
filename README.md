# Proxdesk

Proxdesk lets people use shared Proxmox VMs without a Proxmox account. Members sign in to a web portal to see their VMs, open a browser console, and start, stop, or reboot them; they can do the same by mentioning a bot in Slack or Discord. Administrators grant each member each action on each VM separately, and every request is audited.

It is for teams that share a Proxmox host and want to hand out VM access without handing out the Proxmox web UI.

## Try it

With Node.js 24 or newer, run a demo with simulated VMs; it needs no Proxmox:

```sh
npm ci
npm run dev
```

Open <http://localhost:3000> and pick a demo role.

## Install

[Install Proxdesk](docs/install.md) from the container image, the NixOS module, or the release tarball.

## Documentation

Read the documentation at <https://proxdesk.b3yond.ai>, or here:

- [Install](docs/install.md)
- [Connect Proxmox](docs/proxmox.md)
- [Single sign-on](docs/sso.md)
- [Chat bot](docs/chat.md)
- [Operations](docs/operations.md): commands, upgrades, logs
- [Back up and restore](docs/backups.md)
- [Configuration reference](docs/configuration.md)
- [Command-line reference](docs/cli.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture and security](docs/architecture.md)
- [Extending Proxdesk](docs/extending.md)
- [Contributing](CONTRIBUTING.md) and [security reports](SECURITY.md)

## License

[Apache-2.0](LICENSE)
