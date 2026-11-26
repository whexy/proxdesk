import type {
  AdapterStatus,
  ChatAdapter,
  ChatMember,
  ChatTarget,
  IncomingMessage,
} from "./adapter";
import { render, slackMarkup, type ChatMessage } from "./message";

type DemoMessage = {
  kind: "reply" | "notify" | "private";
  target: ChatTarget;
  text: string;
};
export const demoChannel = "C0DEMO";
export const demoMembers: ChatMember[] = [
  { ref: "U0DEMOALEX", name: "Alex Chen", handle: "alex" },
  { ref: "U0DEMOMAYA", name: "Maya Patel", handle: "maya" },
  { ref: "U0DEMOSAM", name: "Sam Rivera", handle: "sam" },
];

/**
 * Stands in for Slack in demo mode: it has a fixed directory and collects
 * replies instead of sending them, so the demo can drive the real bot.
 */
export class DemoSlackAdapter implements ChatAdapter {
  readonly id = "slack";
  readonly label = "Slack";
  /** The latest messages the bot sent, oldest first. */
  readonly sent: DemoMessage[] = [];
  private captures = new Set<DemoMessage[]>();
  private handler?: (message: IncomingMessage) => Promise<void>;
  status(): AdapterStatus {
    return { state: "connected", lastError: "" };
  }
  start() {}
  stop() {}
  onMessage(handler: (message: IncomingMessage) => Promise<void>) {
    this.handler = handler;
  }
  private record(kind: "reply" | "notify" | "private", target: ChatTarget, message: ChatMessage) {
    const entry = { kind, target, text: render(message, slackMarkup, target.user) };
    this.sent.push(entry);
    this.sent.splice(0, Math.max(0, this.sent.length - 100));
    for (const capture of this.captures) capture.push(entry);
  }
  async reply(target: ChatTarget, message: ChatMessage) {
    this.record("reply", target, message);
  }
  async notify(target: ChatTarget, message: ChatMessage) {
    this.record("notify", target, message);
  }
  async privateReply(target: ChatTarget, message: ChatMessage) {
    this.record("private", target, message);
  }
  async directory() {
    return demoMembers;
  }
  /** Simulates a member mentioning the bot; returns what the bot sent in reply. */
  async mention(userRef: string, text: string) {
    const member = demoMembers.find((m) => m.ref === userRef);
    if (!member) throw new Error("Not a demo directory member");
    const captured: DemoMessage[] = [];
    this.captures.add(captured);
    const target = { conversation: demoChannel, thread: `${Date.now() / 1000}`, user: userRef };
    try {
      await this.handler?.({
        platform: this.id,
        userRef,
        userName: member.name,
        userHandle: member.handle,
        conversation: demoChannel,
        thread: target.thread,
        text,
        target,
        botName: "Proxdesk",
      });
    } finally {
      this.captures.delete(captured);
    }
    return captured;
  }
}
