import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Services } from "./services";
import type { ChatAdapter } from "./chat/adapter";
import type { AdapterOptions, ChatBot } from "./chat/bot";
import {
  ChatError,
  optionalVM,
  registry as defaultRegistry,
  type ChatCommand,
  type CommandRegistry,
} from "./chat/commands";
import * as builders from "./chat/message";

const messages = Object.freeze({
  bold: builders.bold,
  code: builders.code,
  icon: builders.icon,
  requester: builders.requester,
  conversation: builders.conversation,
  link: builders.link,
  paragraph: builders.paragraph,
  list: builders.list,
  message: builders.message,
  text: builders.text,
  join: builders.join,
  plain: builders.plain,
});

export type ExtensionLogger = Readonly<{
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}>;

/**
 * What an extension module's default export receives. Bump version on any
 * incompatible change, so an extension can refuse an API it does not know.
 */
export type ExtensionApi = Readonly<{
  version: 1;
  registerCommand<A>(command: ChatCommand<A>): void;
  addChatAdapter(adapter: ChatAdapter, options?: AdapterOptions): void;
  messages: typeof messages;
  /** Throw new ChatError(message) in a command to refuse with that reply. */
  ChatError: typeof ChatError;
  args: Readonly<{ optionalVM: typeof optionalVM }>;
  log: ExtensionLogger;
  /** The same services commands receive as ctx.services. */
  services: Services;
}>;
export type Extension = (api: ExtensionApi) => void | Promise<void>;

function logger(name: string): ExtensionLogger {
  const prefix = `[extension ${name}]`;
  return Object.freeze({
    info: (...args: unknown[]) => console.log(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
  });
}

/**
 * Imports each module and calls its default export, in order. Extensions run
 * in this process with all of its privileges; nothing here sandboxes them.
 * Any failure throws, so the server never runs with half its extensions.
 */
export async function loadExtensions(
  modules: string[],
  context: { services: Services; bot: ChatBot; registry?: CommandRegistry },
) {
  const registry = context.registry ?? defaultRegistry;
  for (const name of modules) {
    try {
      const specifier = isAbsolute(name) ? pathToFileURL(name).href : name;
      const loaded = (await import(specifier)) as { default?: unknown };
      if (typeof loaded.default !== "function")
        throw new Error("its default export must be a function (api) => void");
      const api: ExtensionApi = Object.freeze({
        version: 1,
        registerCommand: (command) => registry.register(command),
        addChatAdapter: (adapter, options) =>
          context.bot.add(adapter, options ?? { conversations: [] }),
        messages,
        ChatError,
        args: Object.freeze({ optionalVM }),
        log: logger(name),
        services: context.services,
      });
      await (loaded.default as Extension)(api);
    } catch (error) {
      throw new Error(
        `Cannot load extension ${name}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return modules.length;
}
