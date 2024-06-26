import { CronJob } from "cron";
import type { Client, TextChannel } from "discord.js";
import { cycleRecapper, getRecapper } from "./db";

export const startSchedule = (bot: Client) => {
  const rotateRecapperSchedule = new CronJob(Bun.env.SCHEDULE, async () => {
    const channel = await bot.channels.fetch(Bun.env.DISCORD_CHANNEL_ID);
    if (!channel?.isTextBased) {
      return;
    }
    const recappingUser = getRecapper();
    cycleRecapper();
    const nextRecappingUser = getRecapper();
    const textChannel = channel as TextChannel;
    if (!recappingUser || !nextRecappingUser) {
      textChannel.send("There are no recappers.");
      return;
    }
    textChannel.send(
      `Session starts in 1 hour (unless rescheduled). Recapper is <@${recappingUser.id}>. Next recapper is <@${nextRecappingUser.id}>.`,
    );
  });
  rotateRecapperSchedule.start();
};
