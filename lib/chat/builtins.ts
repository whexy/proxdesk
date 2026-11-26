import type { Action, Operation, VM } from "../types";
import {
  optionalVM,
  registerCommand,
  type ChatCommand,
  type CommandContext,
} from "./commands";
import {
  bold,
  code,
  icon,
  link,
  list,
  message,
  paragraph,
  text,
  type ChatMessage,
  type Inline,
} from "./message";

const progress: Record<Action, string> = {
  start: "Starting",
  shutdown: "Shutting down",
  reboot: "Rebooting",
  reset: "Force-resetting",
};
const done: Record<Action, string> = {
  start: "is up",
  shutdown: "is shut down",
  reboot: "has rebooted",
  reset: "has been reset",
};

function uptime(seconds: number) {
  if (seconds >= 86400)
    return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
  if (seconds >= 3600)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 60)}m`;
}
const gib = (n: number) => (n / 1024 ** 3).toFixed(1);

export function describe(vm: VM): Inline[] {
  const parts: Inline[] = [bold(vm.name), ` (VM ${vm.id}) is `, bold(vm.status)];
  if (vm.status === "running")
    parts.push(
      ` · up ${uptime(vm.uptime)} · CPU ${(vm.cpu * 100).toFixed(1)}% of ${vm.cpus} vCPUs · memory ${gib(vm.memory)} / ${gib(vm.maxMemory)} GiB`,
    );
  if (vm.operation)
    parts.push(
      "\n",
      icon("wait"),
      ` ${progress[vm.operation.action].toLowerCase()} (requested by ${vm.operation.userName})`,
    );
  return parts;
}

export function outcome(op: Operation): ChatMessage {
  if (op.status === "succeeded")
    return text(icon("ok"), " ", bold(op.vmName), ` ${done[op.action]}.`);
  if (op.status === "failed")
    return text(icon("error"), ` ${op.action} of `, bold(op.vmName), ` failed: ${op.error}`);
  return text(
    icon("warning"),
    ` ${op.action} of `,
    bold(op.vmName),
    ` has an unknown outcome: ${op.error}`,
  );
}

export function help(ctx: Pick<CommandContext<unknown>, "message" | "commands" | "platform">) {
  const name = ctx.message.botName ? `@${ctx.message.botName} ` : "";
  return message(
    paragraph(icon("wave"), " I can manage your VMs. Mention me with one of these:"),
    list(
      ...ctx
        .commands()
        .map((c) => [
          code(`${name}${c.name}${c.usage ? ` ${c.usage}` : ""}`),
          `: ${c.summary}`,
        ]),
    ),
    paragraph(
      `I reply in a thread and again when an action finishes. To use your VMs, link your ${ctx.platform} account to Proxdesk with `,
      code(`${name}link`),
      ".",
    ),
  );
}

const power = (
  action: Action,
  name: string,
  aliases: string[],
  summary: string,
): ChatCommand<{ vm?: string }> => ({
  name,
  aliases,
  summary,
  usage: "[vm]",
  args: optionalVM,
  permission: action,
  async run(ctx) {
    const vm = await ctx.resolveVM(ctx.args.vm, action);
    const op = await ctx.act(vm, action);
    // A finished operation, such as one whose submission failed, was already
    // reported through its completion notification.
    if (op.status === "pending" || op.status === "running")
      await ctx.reply(text(icon("wait"), ` ${progress[action]} `, bold(vm.name), "…"));
  },
});

export const builtins: ChatCommand<any>[] = [
  {
    name: "help",
    summary: "this list",
    async run(ctx) {
      await ctx.reply(help(ctx));
    },
  } satisfies ChatCommand<string[]>,
  {
    name: "status",
    summary: "state, uptime, CPU, and memory",
    usage: "[vm]",
    args: optionalVM,
    permission: "view",
    async run(ctx) {
      const vm = await ctx.resolveVM(ctx.args.vm, "view");
      await ctx.reply(text(...describe(vm)));
    },
  } satisfies ChatCommand<{ vm?: string }>,
  {
    name: "vms",
    summary: "your VMs and their state",
    permission: "view",
    async run(ctx) {
      const vms = await ctx.services.inventory(ctx.requireAccount());
      await ctx.reply(
        vms.length
          ? message(
              paragraph("Your VMs:"),
              list(
                ...vms.map((vm): Inline[] => [
                  bold(vm.name),
                  ` (VM ${vm.id}): ${vm.status}${vm.operation ? `, ${progress[vm.operation.action].toLowerCase()}` : ""}`,
                ]),
              ),
            )
          : text("You have no VMs. Ask an administrator for access."),
      );
    },
  } satisfies ChatCommand<string[]>,
  power("start", "start", [], "boot a stopped VM"),
  power("shutdown", "stop", ["shutdown"], "shut down the guest OS cleanly"),
  power("reboot", "reboot", ["restart"], "restart the guest OS"),
  power("reset", "reset", [], "hard reset; unsaved work is lost"),
  {
    name: "link",
    summary: "link your account to Proxdesk",
    async run(ctx) {
      const { message: m, services } = ctx;
      const code = services.store.createLinkCode(
        m.platform,
        m.userRef,
        m.userName,
        m.userHandle,
      );
      const current = services.store.chatIdentity(m.platform, m.userRef);
      await ctx.privateReply(
        message(
          paragraph(
            icon("link"),
            " ",
            link(`${services.config.origin}/link/${code}`, "Open this link"),
            ` within 10 minutes while signed in to Proxdesk to link your ${ctx.platform} account to your Proxdesk account. It works once; don't share it.`,
          ),
          ...(current
            ? [paragraph("You are already linked; the link moves you to the account that opens it.")]
            : []),
        ),
      );
    },
  } satisfies ChatCommand<string[]>,
  {
    name: "whoami",
    summary: "the Proxdesk account you are linked to",
    async run(ctx) {
      const identity = ctx.services.store.chatIdentity(
        ctx.message.platform,
        ctx.message.userRef,
      );
      const user = identity && ctx.services.store.getUser(identity.userId);
      await ctx.privateReply(
        user
          ? text(
              "You are linked to ",
              bold(user.name),
              user.email ? ` (${user.email})` : " (chat only)",
              user.enabled ? "." : ", which is disabled.",
            )
          : text("You are not linked to a Proxdesk account. Mention me with ", code("link"), " to link one."),
      );
    },
  } satisfies ChatCommand<string[]>,
];

for (const command of builtins) registerCommand(command);
