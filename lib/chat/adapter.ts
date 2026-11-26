import type { ChatMessage } from "./message";

/**
 * Where a reply goes. Adapters may add their own string fields; the whole
 * target must stay JSON-serializable, because completion notifications are
 * stored with the operation and sent after the request has been answered,
 * possibly by a restarted server.
 */
export type ChatTarget = {
  conversation: string;
  /** The thread to answer in, when the platform has threads. */
  thread?: string;
  /** The requester's platform user ID. */
  user: string;
  [key: string]: string | undefined;
};

export type IncomingMessage = {
  /** The adapter id, such as "slack". */
  platform: string;
  userRef: string;
  /** The display name, which anyone can set to imitate someone else. */
  userName: string;
  /**
   * The sender's unique platform username, such as a Slack or Discord
   * username; no one else can hold it at the same time. Empty when the
   * platform has none or the adapter cannot look it up.
   */
  userHandle: string;
  conversation: string;
  thread?: string;
  /** The text with the bot mention removed. */
  text: string;
  target: ChatTarget;
  /** How users address the bot, such as "Proxdesk", for help texts; empty when unknown. */
  botName: string;
};

/** A person in the adapter's directory, such as a member of the bot's channels. */
export type ChatMember = { ref: string; name: string; handle: string };

export type AdapterStatus = {
  state: "connecting" | "connected" | "disconnected";
  lastError: string;
};

export interface ChatAdapter {
  /** Stable identifier stored with chat identities; never change it once released. */
  readonly id: string;
  /** Human-readable platform name, such as "Slack". */
  readonly label: string;
  start(): void;
  stop(): void;
  status(): AdapterStatus;
  /** Called once, before start(); the adapter passes every message addressed to the bot. */
  onMessage(handler: (message: IncomingMessage) => Promise<void>): void;
  /** Answers the requester where they asked. */
  reply(target: ChatTarget, message: ChatMessage): Promise<void>;
  /** Sends a later follow-up, such as a completion, to a stored target. */
  notify(target: ChatTarget, message: ChatMessage): Promise<void>;
  /** A reply only the requester can see; without it the bot replies in the thread. */
  privateReply?(target: ChatTarget, message: ChatMessage): Promise<void>;
  /** People an administrator can link to accounts. */
  directory?(): Promise<ChatMember[]>;
}
