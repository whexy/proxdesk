import type { Services } from "../services";
import { ChatBot } from "./bot";
import { DemoSlackAdapter, demoChannel } from "./demo";
import { DiscordAdapter, discordRest, type DiscordRest } from "./discord";
import { discordDirect } from "./message";
import { SlackAdapter, slackCall, type SlackCall } from "./slack";

/**
 * The bot with every configured adapter. A new platform adds its adapter
 * here when its settings are present in the configuration.
 */
export function createChatBot(
  services: Services,
  deps: { slackCall?: SlackCall; discordRest?: DiscordRest } = {},
) {
  const bot = new ChatBot(services);
  const { slack, discord, demo } = services.config;
  if (slack)
    bot.add(new SlackAdapter(slack, deps.slackCall ?? slackCall), {
      conversations: slack.channels,
    });
  else if (demo) bot.add(new DemoSlackAdapter(), { conversations: [demoChannel] });
  if (discord)
    bot.add(
      new DiscordAdapter(discord, deps.discordRest ?? discordRest(discord.botToken)),
      { conversations: [...discord.channels, ...(discord.allowDMs ? [discordDirect] : [])] },
    );
  return bot;
}
