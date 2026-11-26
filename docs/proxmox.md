# Connect Proxmox

Proxdesk reaches Proxmox with one API token. Every member's request runs through that token, so it should allow only what Proxdesk needs on only the VMs it manages.

Proxdesk manages QEMU VMs with graphical VNC consoles. Containers, templates, serial-only terminals, and SPICE consoles are not supported.

## Create the token

1. Create a dedicated user, such as `proxdesk@pve`.
2. Create a role with `VM.Audit`, `VM.PowerMgmt`, and `VM.Console`.
3. Assign the role to the user on each managed `/vms/<vmid>` path, or on a pool that holds them.
4. Create an API token for the user, such as `proxdesk@pve!portal`, with privilege separation enabled, and assign it the same role on the same paths. A privilege-separated token gets only the privileges that both it and its user have.

Do not grant host administration, storage, or VM creation and deletion privileges. `proxdesk doctor` warns about each one it finds.

The token ID and secret go in `PROXMOX_TOKEN_ID` and `PROXMOX_TOKEN_SECRET`, with the API address, such as `https://pve.example.com:8006`, in `PROXMOX_URL`.

## Trust the Proxmox certificate

Proxdesk sends the token only to a Proxmox server whose certificate it trusts. What to configure depends on who issued the certificate:

- A public CA, such as Let's Encrypt: nothing.
- Your own CA: set `PROXMOX_CA_FILE` to that CA's PEM file. Proxdesk trusts only that CA for Proxmox, and the hostname in `PROXMOX_URL` must match the certificate.
- Proxmox's default self-signed certificate: set `PROXMOX_FINGERPRINT` to its SHA-256 fingerprint, shown under the node's **System → Certificates** in the Proxmox web UI. Proxdesk then accepts exactly that certificate, whatever its issuer or hostname, so `PROXMOX_URL` may use an IP address. Update the fingerprint when the certificate is renewed.

Set at most one of the two. When the certificate is not trusted, `proxdesk doctor` prints the fingerprint the server presents, so you can compare it with the web UI:

```text
ok    Proxmox TLS trust: system trust store
FAIL  Proxmox at https://127.0.0.1:8006: Cannot reach Proxmox. Check the connection and trusted TLS certificate. (UNABLE_TO_VERIFY_LEAF_SIGNATURE: unable to verify the first certificate; if the root CA is installed locally, try running Node.js with --use-system-ca) The server presents certificate SHA-256 63:80:79:4C:A0:AC:FF:57:CD:19:33:8D:B9:F7:31:3F:47:6E:E4:5F:90:26:86:A1:FF:A0:7A:C7:41:9D:B1:18. If it matches the fingerprint under the node's System → Certificates in Proxmox, set PROXMOX_FINGERPRINT=63:80:79:4C:A0:AC:FF:57:CD:19:33:8D:B9:F7:31:3F:47:6E:E4:5F:90:26:86:A1:FF:A0:7A:C7:41:9D:B1:18, or set PROXMOX_CA_FILE to the CA that issued it.
```

## Limit Proxdesk to some VMs

By default, Proxdesk manages every VM the token can see. To manage fewer, an administrator sets **Settings → Managed VMs** to a Proxmox pool or tag. VMs outside it are hidden from the portal, the chat bot, and grants. This narrows what the token can see but never widens it; the token's privileges remain the real boundary.

Members get no VM by default. An administrator grants each action on each VM under **Members → Manage access**.

## Check it

Run [`proxdesk doctor`](cli.md#doctor). It checks that Proxdesk reaches Proxmox, trusts its certificate, and that the token has the three privileges and no more.

Then test with a disposable VM and a member account: the member sees only the granted VM, can open its console and reboot it, and cannot force-reset it unless that was granted. Revoke console access while the member is connected; the console closes within about two seconds.
