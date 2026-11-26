# Troubleshooting

Start with [`proxdesk doctor`](cli.md#doctor). It checks the configuration and database, Proxmox reachability and certificate trust, the token's privileges, and the Slack and Discord bots, and names the setting to fix. The [log](operations.md#read-logs) shows why the server stopped or what failed.

## The server does not start

`First startup requires BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD` means the database has no accounts. Create an administrator with [`proxdesk create-admin`](install.md#container), then start the server again.

`Another Proxdesk process is using <database>` means another server, or a `restore`, has the database open. Run one server per database.

Any other message names the setting that is wrong; the [configuration reference](configuration.md) describes each one.

## The VM list cannot load

Check the network path from Proxdesk to Proxmox, and `PROXMOX_URL`, `PROXMOX_TOKEN_ID`, and the token secret. A privilege-separated token needs the role on both the token and its user. Proxdesk lists only QEMU VMs that are not templates.

A certificate error means Proxdesk does not trust the Proxmox certificate; see [Trust the Proxmox certificate](proxmox.md#trust-the-proxmox-certificate). With `PROXMOX_CA_FILE`, the hostname in `PROXMOX_URL` must match the certificate. A fingerprint error after a certificate renewal means `PROXMOX_FINGERPRINT` needs the new fingerprint, which `doctor` prints.

If one VM is missing although the token can see it, check **Settings → Managed VMs**: VMs outside the pool or tag are hidden everywhere.

## A power action has an unknown outcome

The connection to Proxmox failed after the request was sent, or the task ran longer than 30 minutes. Proxdesk does not retry it. Check the VM's state and the Proxmox task history before trying again.

## The console does not connect

Check that the VM is running and has a graphical console, and that both the token and its user have `VM.Console`. Make sure the reverse proxy forwards WebSocket upgrades on `/console-socket`, with the cookies and the browser's `Origin` header, and that the address in the browser equals `APP_ORIGIN`.

## Sign-in fails or the session is lost

Open Proxdesk at exactly `APP_ORIGIN` or an address in `APP_ADDITIONAL_ORIGINS`, including the port; `localhost` and `127.0.0.1` are different addresses. A login over HTTPS sets a Secure cookie, which browsers do not send over plain HTTP.

## Single sign-on creates a disabled account

That is expected: an administrator enables new accounts under **Members** and grants VMs. If sign-in fails before that, check that the redirect URI registered with the provider is exactly `<APP_ORIGIN>/api/auth/callback`, and that the ID token includes a verified email. See [Single sign-on](sso.md).

## The chat bot does not answer

Open **Chat** in the web UI. If it says the bot is not connected, the log shows each failed connection attempt.

On Slack:

- Not connected: check `SLACK_APP_TOKEN` and that Socket Mode is enabled for the app.
- Connected but silent: invite the bot to the channel, and check that `SLACK_CHANNEL_ID` lists that channel's ID.
- `not_in_channel` on the **Chat** page: the bot has not joined one of the channels.
- `missing_scope`: the app was not reinstalled after its scopes changed.

On Discord:

- "rejected the bot token": set a new `DISCORD_BOT_TOKEN`.
- "refused the gateway intents": the application's settings block the bot.
- Connected but silent: the bot lacks **View Channels** or **Send Messages** in the channel, or the channel is missing from `DISCORD_CHANNEL_IDS`.

If the bot answers that the person is not linked, they mention it with `link`, or an administrator links them under **Chat**; see [Accounts and chat identities](chat.md#accounts-and-chat-identities).
