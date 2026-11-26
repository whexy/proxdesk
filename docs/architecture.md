# Architecture and security

Proxdesk is one Node.js process. It hosts the Next.js web application, proxies console WebSockets to Proxmox, tracks Proxmox tasks, and runs the chat bot. SQLite stores accounts, hashed passwords and session tokens, VM grants, chat identities, settings, operations, and the audit log. Proxmox stays the source of truth for VM state, and the Proxmox token never leaves the server.

## Permissions

Every VM request, from the web UI or the chat bot, is checked on the server against the current account and its grant for that VM. A member's grant lists actions separately: status, start, graceful reboot, graceful shutdown, force reset, and console. Granting any action also grants status; removing status removes the grant. Administrators can use every VM in the managed VMs.

Proxmox's `VM.PowerMgmt` privilege covers all power actions; Proxdesk separates graceful reboot from force reset, which can lose unsaved work. Console access includes the boot and recovery screens as well as the guest's login.

Grants name Proxmox VM IDs. Revoke grants before deleting or reusing a VM ID, or the grant applies to the new VM with that ID.

**Settings → Managed VMs** limits Proxdesk to one Proxmox pool or tag. A VM outside it is treated as nonexistent by the VM list, power actions, grants, consoles, and the chat bot. An open console to it closes within two seconds of a settings change, and within about seven seconds of the VM leaving the scope inside Proxmox, such as by a pool or tag change. Grants for such a VM are kept and apply again if it returns.

## Sessions

Local passwords are hashed with salted scrypt. Sessions last 12 hours, and their random tokens are stored hashed and carried in HTTP-only, SameSite=Lax cookies, Secure over HTTPS. Requests that change anything must carry an `Origin` header equal to `APP_ORIGIN` or an address in `APP_ADDITIONAL_ORIGINS`. Login and power requests are rate limited. Disabling an account or changing its password ends its other sessions.

## Power actions

Each VM has at most one action in progress. Proxdesk records the request before calling Proxmox, stores the returned task ID, and polls the task every two seconds; Proxmox's exit status decides success. Task IDs survive a restart, so tracking resumes. A request interrupted before Proxmox returned a task ID, or still running after 30 minutes, ends as unknown and is never retried automatically.

## Consoles

To open a console, Proxdesk checks the permission, asks Proxmox for a VNC proxy ticket, and gives the browser a single-use connection ticket, valid for 30 seconds and bound to the session and VM. The WebSocket upgrade checks the origin, session, ticket, and permission again, and Proxdesk then authenticates to Proxmox with its token and relays the VNC traffic to noVNC in the browser. The session and permission are checked again every two seconds, against the VM's pool and tags as Proxmox reported them at most five seconds earlier; one shared request serves every open console. A console closes when its VM is gone, when Proxmox cannot be asked, and after two hours. Closing a console does not power off the VM.

## Chat

The bot has no permissions of its own. Each chat identity, such as a Slack user, is linked to one account, and a request runs as that account through the same checks as the web UI. Chat-only accounts have no email or password and cannot sign in to the web, so they cannot be administrators. Proxdesk always keeps one enabled administrator who can sign in.

A person links an identity with a code from the bot: 32 random bytes, stored hashed, bound to that identity, and valid once for 10 minutes. Redeeming it needs a signed-in session and a confirmation that names the identity by its platform username and user ID, never by its display name, which anyone can set to imitate someone else; moving an identity from another account needs a second confirmation.

Each platform is an adapter behind the bot. Replies are built from platform-neutral messages that each adapter renders, escaping VM and display names so they cannot inject formatting or mentions. Adapters drop events they saw in the last 10 minutes, so a redelivered `reboot` does not reboot twice. Where to send a completion reply is stored with the operation, so it survives a restart.

## Audit log

Console openings, power outcomes, account, grant, and settings changes, chat links, and manual backups are recorded. Members see their own events; administrators see the latest 100 events of the workspace. The log lives in the application database; it is not a tamper-proof external record.

## Extensions

[Extensions](extending.md) run inside the server with all of its privileges, including the database and the Proxmox token. Treat them as part of Proxdesk's own code.

## What the tests cover

Automated tests cover permissions, sessions, operation tracking, Proxmox requests, console tickets and forwarding, the chat adapters, and browser workflows with a mocked console. A real Proxmox console and identity provider need checking in your deployment; see [Check it](proxmox.md#check-it).
