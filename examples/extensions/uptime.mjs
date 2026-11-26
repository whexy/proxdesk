// A Proxdesk extension that adds an "uptime" chat command.
// Load it with PROXDESK_EXTENSIONS=/absolute/path/to/uptime.mjs.

/** @param {import("../../lib/extensions").ExtensionApi} api */
export default function uptime(api) {
  if (api.version !== 1)
    throw new Error(`written for extension API 1, got ${api.version}`);
  const { bold, icon, text } = api.messages;
  api.registerCommand({
    name: "uptime",
    summary: "how long a VM has been running",
    usage: "[vm]",
    args: api.args.optionalVM,
    // Refuses unlinked and disabled senders before run() is called.
    permission: "view",
    async run(ctx) {
      // Only VMs this account may view, in the managed scope; a name or ID
      // it has no grant for is refused.
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
  api.log.info("registered the uptime command");
}
