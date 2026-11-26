import type { Services } from "../services";
import type { Action, Operation, Permission, User, VM } from "../types";
import type { IncomingMessage } from "./adapter";
import type { ChatMessage } from "./message";

/** A refusal or explanation for the requester; the bot replies with it and stops. */
export class ChatError extends Error {
  constructor(public reply: ChatMessage) {
    super("chat request refused");
  }
}

export type CommandContext<A> = {
  message: IncomingMessage;
  /** The adapter's label, such as "Slack". */
  platform: string;
  args: A;
  /** The linked, enabled account, or undefined when the sender has none. */
  account: User | undefined;
  services: Services;
  /** Replies in the conversation, addressed to the requester. */
  reply(message: ChatMessage): Promise<void>;
  /** Replies so only the requester sees it, where the platform allows; otherwise as reply(). */
  privateReply(message: ChatMessage): Promise<void>;
  /** The account, or a ChatError telling the requester how to link one. */
  requireAccount(): User;
  /**
   * Finds a VM the account may use with this permission, by name or ID among
   * its VMs in the managed scope. Without an argument, the only such VM.
   */
  resolveVM(arg: string | undefined, permission: Permission): Promise<VM>;
  /** Submits a power action as the account; its outcome is posted when Proxmox finishes. */
  act(vm: VM, action: Action): Promise<Operation>;
  commands(): readonly ChatCommand<unknown>[];
};

export type ChatCommand<A = string[]> = {
  name: string;
  aliases?: string[];
  summary: string;
  /** Arguments as shown in help, such as "[vm]". */
  usage?: string;
  /**
   * Turns the words after the command into arguments, or returns undefined
   * when they are not acceptable; the requester then gets the help instead,
   * so a sentence that merely starts with a command word never acts.
   * Without a parser, the command takes no arguments.
   */
  args?(words: string[]): A | undefined;
  /** Requires a linked account; the bot refuses unlinked or disabled senders first. */
  permission?: Permission;
  run(ctx: CommandContext<A>): Promise<void>;
};

const noArgs = (words: string[]) => (words.length ? undefined : ([] as string[]));
const word = /^[A-Za-z][A-Za-z0-9-]*$/;

export class CommandRegistry {
  private list: ChatCommand<any>[] = [];
  register<A>(command: ChatCommand<A>) {
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      if (!word.test(name))
        throw new Error(`Chat command name "${name}" must be a single word`);
      if (this.find(name))
        throw new Error(`Chat command "${name}" is already registered`);
    }
    this.list.push(command);
  }
  all(): readonly ChatCommand<unknown>[] {
    return this.list;
  }
  find(name: string): ChatCommand<unknown> | undefined {
    const key = name.toLowerCase();
    return this.list.find(
      (c) =>
        c.name.toLowerCase() === key ||
        !!c.aliases?.some((alias) => alias.toLowerCase() === key),
    );
  }
  /** The command and its arguments, or undefined when the text is not exactly a command. */
  parse(text: string) {
    const [first, ...rest] = text.trim().split(/\s+/).filter(Boolean);
    const command = first ? this.find(first) : undefined;
    if (!command) return undefined;
    const args = (command.args ?? noArgs)(rest);
    return args === undefined ? undefined : { command, args };
  }
}

/** The registry every ChatBot uses unless it is given its own. */
export const registry = new CommandRegistry();
/** Adds a command to the bot; call it at startup, before the server starts. */
export function registerCommand<A>(command: ChatCommand<A>) {
  registry.register(command);
}

/** Accepts nothing, or one word naming a VM by name or numeric ID. */
export function optionalVM(words: string[]) {
  if (!words.length) return { vm: undefined };
  if (words.length === 1 && /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(words[0]))
    return { vm: words[0] };
  return undefined;
}
