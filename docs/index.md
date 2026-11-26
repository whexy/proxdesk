# Proxdesk

Proxdesk lets people use shared Proxmox VMs without a Proxmox account. Members sign in to a web portal to see their VMs, open a browser console, and start, stop, or reboot them; they can do the same by mentioning a bot in Slack or Discord. Administrators grant each member each action on each VM separately, and every request is audited.

It is for teams that share a Proxmox host and want to hand out VM access without handing out the Proxmox web UI.

## Try it

With Node.js 24 or newer, run a demo with simulated VMs from a checkout of the [repository](https://github.com/whexy/proxdesk); it needs no Proxmox:

```sh
npm ci
npm run dev
```

Open <http://localhost:3000> and pick a demo role.

To run it for real, [install Proxdesk](install.md).
