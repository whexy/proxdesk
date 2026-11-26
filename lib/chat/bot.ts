import { AppError, type Services } from "../services";
import type { Operation, Permission, User, VM } from "../types";
import type { ChatAdapter, ChatTarget, IncomingMessage } from "./adapter";
import { help, outcome } from "./builtins";
import {
  ChatError,
  registry as defaultRegistry,
  type CommandContext,
  type CommandRegistry,
} from "./commands";
import {
  bold,
  code,
  conversation,
  icon,
  join,
  text,
  type ChatMessage,
  type Inline,
} from "./message";

export type AdapterOptions = {
  /** Conversations the bot takes requests in; others get a private pointer to them. Empty allows all. */
  conversations: string[];
};
/** Stored with an operation so its outcome reaches the requester later. */
export type NotifyRecord = { platform: string; target: ChatTarget };

/** Addresses the reply to the requester, as a mention before the first paragraph. */
function addressed(message: ChatMessage): ChatMessage {
  const [first, ...rest] = message.blocks;
  if (!first || !("paragraph" in first))
    return { blocks: [{ paragraph: [{ requester: true }] }, ...message.blocks] };
  return {
    blocks: [{ paragraph: [{ requester: true }, " ", ...first.paragraph] }, ...rest],
  };
}

const vmList = (vms: VM[]): Inline[] =>
  join(vms.map((vm) => [bold(vm.name), ` (${vm.id})`]));

/**
 * Connects chat adapters to the command registry and to Services. Requests
 * act as the linked account through the same checks as the web UI.
 */
export class ChatBot {
  private adapters = new Map<string, { adapter: ChatAdapter; options: AdapterOptions }>();
  private stopped = false;
  constructor(
    private services: Services,
    private registry: CommandRegistry = defaultRegistry,
  ) {
    services.finished.add((op) => this.onFinished(op));
  }
  add(adapter: ChatAdapter, options: AdapterOptions = { conversations: [] }) {
    if (this.adapters.has(adapter.id))
      throw new Error(`A chat adapter with id "${adapter.id}" is already added`);
    this.adapters.set(adapter.id, { adapter, options });
    adapter.onMessage((message) => this.handle(adapter, message));
  }
  list() {
    return [...this.adapters.values()];
  }
  adapter(id: string) {
    return this.adapters.get(id)?.adapter;
  }
  start() {
    this.stopped = false;
    for (const { adapter } of this.adapters.values()) adapter.start();
  }
  stop() {
    this.stopped = true;
    for (const { adapter } of this.adapters.values()) adapter.stop();
  }
  /** The account behind a chat identity, read fresh for every request. */
  private account(message: IncomingMessage): User | undefined {
    const identity = this.services.store.chatIdentity(message.platform, message.userRef);
    return identity && this.services.store.getUser(identity.userId);
  }
  async handle(adapter: ChatAdapter, message: IncomingMessage) {
    const reply = (m: ChatMessage) => adapter.reply(message.target, addressed(m));
    // Private content, such as a link code, is never posted where others can
    // read it; without private replies the requester gets a refusal instead.
    const privateReply = async (m: ChatMessage) => {
      if (!adapter.privateReply)
        throw new ChatError(
          text(
            icon("error"),
            ` I can't send private messages on ${adapter.label}, so I can't answer this here. Ask an administrator to link your account.`,
          ),
        );
      await adapter.privateReply(message.target, m);
    };
    try {
      const allowed = this.adapters.get(adapter.id)?.options.conversations ?? [];
      if (allowed.length && !allowed.includes(message.conversation)) {
        // One pointer per person every few minutes; anything more is dropped,
        // so mentions outside the bot's conversations cannot make it spam.
        try {
          this.services.rateLimit(
            `chat-pointer:${message.platform}:${message.userRef}`,
            1,
            5 * 60_000,
          );
        } catch {
          return;
        }
        const pointer = text(
          "I only take VM requests in ",
          ...join(allowed.map((c) => [conversation(c)])),
          ".",
        );
        await (adapter.privateReply
          ? adapter.privateReply(message.target, pointer)
          : reply(pointer));
        return;
      }
      const ctxBase = {
        message,
        platform: adapter.label,
        services: this.services,
        reply,
        privateReply,
        commands: () => this.registry.all(),
      };
      const parsed = this.registry.parse(message.text);
      if (!parsed) {
        await reply(help(ctxBase));
        return;
      }
      try {
        if (parsed.command.name !== "help")
          this.services.rateLimit(`chat:${message.platform}:${message.userRef}`, 20, 60_000);
        const linked = this.account(message);
        const account = linked?.enabled ? linked : undefined;
        const requireAccount = () => {
          if (account) return account;
          if (linked)
            throw new ChatError(text(icon("error"), " Your Proxdesk account is disabled."));
          throw new ChatError(
            text(
              icon("error"),
              ` Your ${adapter.label} account is not linked to a Proxdesk account. Mention me with `,
              code("link"),
              " to link it, or ask an administrator.",
            ),
          );
        };
        if (parsed.command.permission) requireAccount();
        const ctx: CommandContext<unknown> = {
          ...ctxBase,
          args: parsed.args,
          account,
          requireAccount,
          resolveVM: (arg, permission) => this.resolveVM(requireAccount(), arg, permission),
          act: (vm, action) =>
            this.services.act(requireAccount(), vm.id, action, {
              via: adapter.label,
              notify: { platform: adapter.id, target: message.target } satisfies NotifyRecord,
            }),
        };
        await parsed.command.run(ctx);
      } catch (error) {
        if (error instanceof ChatError) await reply(error.reply);
        else if (error instanceof AppError && error.status < 500)
          await reply(text(icon("error"), ` ${error.message}`));
        else {
          console.error(`${adapter.label} request failed:`, error);
          await reply(
            text(icon("error"), " I couldn't reach the hypervisor. Ask an administrator to check the server."),
          );
        }
      }
    } catch (error) {
      console.error(`${adapter.label} reply failed:`, error);
    }
  }
  private async resolveVM(account: User, arg: string | undefined, permission: Permission) {
    const vms = await this.services.inventory(account);
    const usable = vms.filter((vm) => vm.permissions.includes(permission));
    if (arg !== undefined) {
      const key = arg.toLowerCase();
      const vm = vms.find((vm) => String(vm.id) === key || vm.name.toLowerCase() === key);
      if (!vm)
        throw new ChatError(
          text(
            icon("error"),
            ` You have no VM called ${arg}.`,
            ...(usable.length ? [" Yours: ", ...vmList(usable), "."] : []),
          ),
        );
      if (!usable.includes(vm))
        throw new AppError(403, "You do not have permission for this VM action");
      return vm;
    }
    if (usable.length === 1) return usable[0];
    if (!usable.length)
      throw new ChatError(
        text(icon("error"), " You have no VM you can use this way. Ask an administrator for access."),
      );
    throw new ChatError(text("Which VM? Add its name or ID: ", ...vmList(usable), "."));
  }
  private onFinished(op: Operation) {
    if (this.stopped) return;
    const record = this.services.store.operationNotify(op.id) as NotifyRecord | undefined;
    const adapter = record && this.adapters.get(record.platform)?.adapter;
    if (!record || !adapter) return;
    adapter
      .notify(record.target, addressed(outcome(op)))
      .then(undefined, (error) => console.error(`${adapter.label} notification failed:`, error));
  }
}
