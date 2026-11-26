# Chat bot

People can control their VMs by mentioning a bot in chat, for example `@Proxdesk reboot alex-dev`. The bot answers only in the channels you configure, and acts with the permissions of the Proxdesk account each person links. Set up Slack, Discord, or both, then link accounts.

To add a platform or a command, see [Extending Proxdesk](extending.md).

## Set up Slack

The bot connects to Slack through Socket Mode, an outbound WebSocket, so the server needs no public URL.

To use a Slack app your workspace already has, see [Reuse an existing app](#reuse-an-existing-app) instead of creating one.

### Create the app

1. Open <https://api.slack.com/apps>, choose **Create New App → From a manifest**, select your workspace, and paste [slack-app-manifest.json](../deploy/slack-app-manifest.json).
2. Under **Basic Information → App-Level Tokens**, generate a token with the `connections:write` scope. This `xapp-` token is `SLACK_APP_TOKEN`.
3. Under **Install App**, install the app to the workspace. The **Bot User OAuth Token** (`xoxb-`) is `SLACK_BOT_TOKEN`.

If you change scopes later, reinstall the app; Slack keeps the old token's scopes until you do.

### Reuse an existing app

First check how the app receives events today, on its **Socket Mode** and **Event Subscriptions** pages:

- If it receives no events, for example because it only posts notifications, it can be reused.
- If it uses a Request URL, enabling Socket Mode stops delivery to that URL.
- If another program already connects to it through Socket Mode, Slack sends each event to only one of the connected programs, so each program misses some mentions.

In the last two cases, create a new app instead, or retire the other program first.

To reuse the app, open it at <https://api.slack.com/apps> and change these settings:

1. Under **Socket Mode**, turn on **Enable Socket Mode**. Slack asks for an app-level token; give it the `connections:write` scope. This `xapp-` token is `SLACK_APP_TOKEN`.
2. Under **OAuth & Permissions → Bot Token Scopes**, add any of `app_mentions:read`, `chat:write`, `channels:read`, `groups:read`, and `users:read` that are missing.
3. Under **Event Subscriptions**, turn on events and add `app_mention` under **Subscribe to bot events**. Save the changes.
4. Reinstall the app from the banner at the top of the page. Copy the **Bot User OAuth Token** (`xoxb-`) from **OAuth & Permissions**. This is `SLACK_BOT_TOKEN`.

Users mention the bot by its existing name, for example `@yourbot reboot`.

### Add it to the channels

In each channel, run `/invite @Proxdesk`. For a private channel such as `#vm-requests` this is required: the bot sees no mentions and cannot list members of a private channel it has not joined.

Open the channel name, then **About**. The channel ID, such as `C0123ABCD45`, is at the bottom. The channel name does not work.

### Configure Proxdesk

Add the values to the configuration and [apply it](operations.md#change-the-configuration). `SLACK_CHANNEL_ID` takes one channel ID or several separated by commas:

```sh
SLACK_APP_TOKEN=xapp-…
SLACK_BOT_TOKEN=xoxb-…
SLACK_CHANNEL_ID=C0123ABCD45,G0456EFGH78
```

On NixOS, set `slack.appTokenFile`, `slack.botTokenFile`, and `slack.channelIds`.

In the web UI, **Chat** shows "Bot connected" once the connection is up, and `proxdesk doctor` checks the tokens and channels. Mentions in other channels get a private note naming the bot's channels, at most one per person every five minutes.

## Set up Discord

The bot connects to Discord's Gateway, an outbound WebSocket, so the server needs no public URL. It needs no privileged intents: Discord sends a bot the text of messages that mention it and of direct messages without the Message Content intent.

### Create the application

1. Open <https://discord.com/developers/applications> and choose **New Application**.
2. Under **Bot**, choose **Reset Token** and copy the token. This is `DISCORD_BOT_TOKEN`. Leave every **Privileged Gateway Intent** off.
3. Under **OAuth2 → URL Generator**, select the `bot` scope and these bot permissions: **View Channels**, **Send Messages**, **Send Messages in Threads**, and **Read Message History**. Open the generated URL and add the bot to your server.

### Find the channel IDs

In Discord, turn on **User Settings → Advanced → Developer Mode**. Right-click each channel the bot should answer in and choose **Copy Channel ID**. The ID is a number such as `1234567890123456789`. Threads under a listed channel are included.

If a channel is private, add the bot to it under the channel's **Permissions**.

### Configure Proxdesk

Add the values to the configuration and [apply it](operations.md#change-the-configuration):

```sh
DISCORD_BOT_TOKEN=MTIz…
DISCORD_CHANNEL_IDS=1234567890123456789,2234567890123456789
# Optional: also take requests in direct messages to the bot.
DISCORD_ALLOW_DMS=false
```

On NixOS, set `discord.botTokenFile`, `discord.channelIds`, and optionally `discord.allowDMs`.

`proxdesk doctor` checks the token and that the bot can see each channel.

People mention the bot, for example `@Proxdesk status`; a reply to the bot without a mention is ignored. In a direct message, no mention is needed. With `DISCORD_ALLOW_DMS=false`, direct messages get a note naming the bot's channels, at most one per person every five minutes.

`link` and `whoami` answer by direct message, because their replies are private. A person who has turned off direct messages from server members gets a notice in the channel instead, asking them to allow direct messages; the link itself is never posted in the channel.

## Accounts and chat identities

A chat identity is a person's account on a chat platform, such as a Slack or Discord user. Each identity is linked to one Proxdesk account, and the bot acts as that account: the same VM permissions, managed scope, and audit log as the web UI. A member without force-reset permission cannot reset through chat either, and a disabled account is refused. One account can have several identities.

A chat-only member is an account without an email or password. It cannot sign in to the web, so it cannot be an administrator or count as the last one, but it has VM permissions like any member. Use one for people who only use chat. Giving it an email, and a password or single sign-on, under **Members → Manage access** turns it into a web account and keeps its identities and permissions.

People link their own identity, or an administrator links it for them.

To link yourself, mention the bot with `link`. It replies with a link that only you can see. Open it within 10 minutes while signed in to Proxdesk and confirm; if you are signed out, Proxdesk asks you to sign in first. The page names the chat user by platform username and user ID, such as `@dang (ID 1234567890123456789)`, not by display name, which anyone can set to yours. Confirm only a link you just asked the bot for: whoever's link you confirm gets your access through chat. The link works once. If your identity was linked to another account, the page asks you to confirm moving it. Your linked identities are listed under **Chat accounts** in the account menu, where you can unlink them.

Administrators open **Chat**. For Slack, it lists the members of the bot's channels, refreshed every five minutes; choose an account for each person, or **Create chat-only member** and then grant VMs under **Members**. Discord does not let the bot list members, so Discord users link themselves. **Linked chat accounts** lists every link, including people who have left the channels, with **Unlink**.

To remove a member, such as a chat-only member who has left, open **Members → Manage access → Delete member**. This removes the account, its VM access, and its chat identities; the activity log keeps its past events.

## Commands

Mention the bot with one command. It replies in a thread (on Discord, as a reply to your message), and again when Proxmox finishes a power action.

| Command | Effect |
| --- | --- |
| `status [vm]` | State, uptime, CPU, and memory, plus any action in progress |
| `vms` | Your VMs and their state |
| `start [vm]` | Boot a stopped VM |
| `stop [vm]` | Ask the guest OS to shut down; also `shutdown` |
| `reboot [vm]` | Ask the guest OS to restart; also `restart` |
| `reset [vm]` | Hard-reset the virtual hardware; unsaved work is lost |
| `link` | Get a link that connects your chat identity to your Proxdesk account |
| `whoami` | The account you are linked to, visible only to you (on Discord, by direct message) |
| `help` | The list of commands |

Name a VM by its name or ID. Without one, the bot uses your only VM that allows the action, or asks which one you mean.

Any other text, including a sentence that contains a command word or mentions someone else, gets the list of commands and changes nothing. Each person can send 20 commands a minute.

Requests appear under **Activity** under the linked account's name, marked "via Slack" or "via Discord". The completion reply is stored with the request, so it is still sent if the service restarts while Proxmox works on the task. A task that finishes while the service is stopped gets no reply; `status` shows the result.

If the bot does not answer, see [Troubleshooting](troubleshooting.md#the-chat-bot-does-not-answer).

<details>
<summary>Upgrading a database from before chat identities</summary>

Databases from before chat identities linked each Slack user directly to one VM with every action. The upgrade turns each such link into a chat-only member named after the Slack user, with status, start, reboot, shutdown, and force reset on that VM, so nobody loses or gains access. To give a person their web account's permissions instead, have them link themselves, or choose their web account under **Chat**.

</details>
