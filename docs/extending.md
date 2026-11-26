# Extending Proxdesk

An extension is a JavaScript module that adds chat commands or chat platforms. Proxdesk loads the modules listed in `PROXDESK_EXTENSIONS` when the server starts.

**Extensions run inside the Proxdesk process with all of its privileges**: they can read the database, the Proxmox token, and every other secret, and act as any account. Nothing sandboxes them. Install only code you have read or trust as much as Proxdesk itself.

## How the chat layer fits together

The code lives in [lib/chat/](../lib/chat/).

- An **adapter** connects one platform, such as Slack or Discord. It turns platform events into an `IncomingMessage` and sends the bot's replies.
- The **bot** ([bot.ts](../lib/chat/bot.ts)) checks that the message came from an allowed conversation, parses the command, rate-limits the sender, and looks up the Proxdesk account linked to the sender's chat identity.
- A **command** ([commands.ts](../lib/chat/commands.ts)) does the work. It builds replies from platform-neutral **messages** ([message.ts](../lib/chat/message.ts)), which each adapter renders in its own markup.

A command acts as the linked account through the same services and permission checks as the web UI. It never sees platform syntax, and an adapter never sees permissions.

## Load an extension

Set `PROXDESK_EXTENSIONS` to absolute paths or package names, separated by commas, and restart:

```sh
PROXDESK_EXTENSIONS=/etc/proxdesk/extensions/uptime.mjs
```

On NixOS, use `services.proxdesk.extensions = [ ./uptime.mjs ];`. A package name is resolved from Proxdesk's own `node_modules`, so for a module installed anywhere else, give its absolute path.

Each module's default export is called with the extension API, in the listed order. If a module cannot be imported or its function throws, the server does not start and the error names the module.

## The extension API

```ts
export default function (api) { … }
```

| Member | What it is |
| --- | --- |
| `api.version` | `1`. It changes only when the API changes incompatibly; check it and throw if it is not the version you wrote for. |
| `api.registerCommand(command)` | Adds a chat command. A name or alias that is already taken throws. |
| `api.addChatAdapter(adapter, { conversations })` | Adds a chat platform. `conversations` lists where the bot takes requests; an empty list allows every conversation. |
| `api.messages` | Message builders: `text`, `message`, `paragraph`, `list`, `bold`, `code`, `link`, `icon`, `requester`, `conversation`, `join`, and `plain`. |
| `api.ChatError` | `throw new api.ChatError(message)` refuses a request with that reply. |
| `api.args.optionalVM` | An argument parser that accepts nothing or one VM name or ID. |
| `api.log` | `info`, `warn`, and `error`, prefixed with the extension's name. |
| `api.services` | The same services object commands get as `ctx.services`. |

TypeScript types are in [lib/extensions.ts](../lib/extensions.ts) (`ExtensionApi`) and [lib/chat/commands.ts](../lib/chat/commands.ts) (`ChatCommand`, `CommandContext`).

## Write a command

[examples/extensions/uptime.mjs](../examples/extensions/uptime.mjs) adds `uptime [vm]`:

```js
export default function uptime(api) {
  if (api.version !== 1)
    throw new Error(`written for extension API 1, got ${api.version}`);
  const { bold, icon, text } = api.messages;
  api.registerCommand({
    name: "uptime",
    summary: "how long a VM has been running",
    usage: "[vm]",
    args: api.args.optionalVM,
    permission: "view",
    async run(ctx) {
      const vm = await ctx.resolveVM(ctx.args.vm, "view");
      if (vm.status !== "running")
        throw new api.ChatError(
          text(icon("warning"), " ", bold(vm.name), ` is ${vm.status}.`),
        );
      const days = Math.floor(vm.uptime / 86400),
        hours = Math.floor((vm.uptime % 86400) / 3600),
        minutes = Math.floor((vm.uptime % 3600) / 60);
      await ctx.reply(
        text(bold(vm.name), ` has been up for ${days}d ${hours}h ${minutes}m.`),
      );
    },
  });
}
```

What each part guarantees:

- `args` turns the words after the command name into arguments. Returning `undefined` rejects them, and the sender gets the help instead, so a sentence that happens to start with a command word never acts. Without `args`, the command takes no arguments.
- `permission` requires a linked, enabled account before `run` is called. Leave it out only for commands that need no account, such as `help`.
- `ctx.resolveVM(name, permission)` finds the VM by name or ID among the account's VMs in the managed scope, and refuses a VM the account lacks that permission for. Without a name, it picks the account's only such VM or asks which one.
- `ctx.act(vm, action)` submits a power action as the account, audited as coming through chat; the outcome is posted when Proxmox finishes.
- `ctx.reply` answers in the conversation, addressed to the sender. `ctx.privateReply` answers so only the sender sees it; use it for anything secret, such as a link. On a platform without private replies it posts a refusal instead and ends the command, so nothing passed to it is ever shown to others.
- `ctx.services` gives everything else, for example `ctx.services.inventory(ctx.requireAccount())`. Check permissions yourself with `ctx.services.store.allowed(account, vmId, permission)` before acting on anything `resolveVM` did not return.

Build replies only with `api.messages`; plain strings in them are escaped for each platform, so VM names and user input cannot inject markup or mentions.

## Write an adapter

An adapter implements `ChatAdapter` from [lib/chat/adapter.ts](../lib/chat/adapter.ts). [slack.ts](../lib/chat/slack.ts) and [discord.ts](../lib/chat/discord.ts) are complete examples; [demo.ts](../lib/chat/demo.ts) is the smallest one.

| Member | Must |
| --- | --- |
| `id` | Be stable and unique, such as `"matrix"`. It is stored with every chat identity, so never change it after people have linked accounts. |
| `label` | Name the platform for people, such as `"Matrix"`. |
| `start()`, `stop()` | Connect and disconnect without throwing; reconnect on its own after failures, with backoff. |
| `status()` | Report `connecting`, `connected`, or `disconnected`, and the last error, for the Chat page. |
| `onMessage(handler)` | Store the handler. It is called once, before `start()`. |
| `reply(target, message)` | Answer where the request was made. |
| `notify(target, message)` | Send a later follow-up, such as a completion, to a stored target. It may run after a restart. |
| `privateReply?(target, message)` | Reach only the requester, or fail without showing the content to anyone else. Without it, `link`, `whoami`, and any command that answers privately get a public refusal asking the person to have an administrator link them. |
| `directory?()` | List people an administrator can link. Leave it out if the platform cannot list members; people then link themselves. |

When a message arrives, the adapter must:

- **Pass only messages addressed to the bot**, and ignore its own messages and other bots', so the bot cannot answer itself.
- **Strip only the bot's own mention** from `text`, so the command parser sees the command; leave other mentions in, so a request that names someone else is rejected.
- **Set `userHandle`** to the sender's unique platform username, which the link page shows with `userRef`. Never use the display name for it, since anyone can set that to another person's name; leave it empty if the platform has no such username.
- **Pass each message once.** Platforms redeliver events after reconnects; remember recent event or message IDs and drop repeats, or a redelivered `reboot` reboots twice.
- **Keep `target` JSON-serializable**: string fields only. It is stored with an operation and used for the completion notice, possibly by a restarted server.
- **Set `conversation`** to the ID that `conversations` in `addChatAdapter` lists, so the bot can refuse requests elsewhere.

When sending, it must render with `render(message, markup, target.user)` and a `Markup` that escapes plain text for the platform, renders `requester` as a mention of `target.user`, and never lets text from a message trigger mentions of anyone else.

## Test it

The tests in [tests/chat/](../tests/chat/) show the pattern:

- [helpers.ts](../tests/chat/helpers.ts) starts Proxdesk's services in demo mode on an in-memory database, with demo VMs and accounts, and provides a `FakeAdapter` that records replies as plain text.
- [extensions.test.ts](../tests/chat/extensions.test.ts) loads the example extension into a bot with its own command registry and sends it commands as linked and unlinked chat users.
- [discord.test.ts](../tests/chat/discord.test.ts) runs an adapter against a fake gateway, a local WebSocket server, and a fake REST function, and checks deduplication, mention handling, and that private replies do not leak.

Run them with `npm test`.

## The hypervisor

Proxdesk talks to Proxmox through the `Hypervisor` interface in [lib/proxmox.ts](../lib/proxmox.ts): inventory, power actions, task status, and console connections. `DemoHypervisor` implements it for demo mode. It is internal for now: extensions cannot replace it, and it may change between releases.
