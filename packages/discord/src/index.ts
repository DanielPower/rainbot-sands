import { registerCommands, startBot } from "./discord.ts";
import { recoverSessions } from "./recovery.ts";
import { startJobQueue } from "@rainbot/db";

await startJobQueue();
await registerCommands();
const { bot } = await startBot();
await recoverSessions(bot);
