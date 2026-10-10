/**
 * Send-only channels for job results under `runtime: "bus"`.
 *
 * The job loop (`job-loop.ts`) runs every job under the bus too, but start.ts
 * skips `initTelegram` / `initDiscord` there: the bus adapters own Telegram
 * polling and the Discord gateway. That left `forwardToTelegram` /
 * `forwardToDiscord` with nothing to send through. These senders only send:
 * no polling, no gateway, no second consumer of either channel.
 */

export interface JobRelay {
  telegramSend: ((chatId: number, text: string) => Promise<void>) | null;
  discordSendToUser: ((userId: string, text: string) => Promise<void>) | null;
}

export interface BusJobRelayOptions {
  telegramToken: string;
  discordToken: string;
  /** Defaults to the Telegram Bot API `sendMessage`. */
  telegramSend?: (token: string, chatId: number, text: string) => Promise<void>;
  /** Defaults to the Discord REST DM send. */
  discordSend?: (token: string, userId: string, text: string) => Promise<void>;
}

export async function busJobRelay(opts: BusJobRelayOptions): Promise<JobRelay> {
  let telegramSend: JobRelay["telegramSend"] = null;
  if (opts.telegramToken) {
    const token = opts.telegramToken;
    const send = opts.telegramSend ?? (await import("./commands/telegram")).sendMessage;
    telegramSend = (chatId, text) => send(token, chatId, text);
  }

  let discordSendToUser: JobRelay["discordSendToUser"] = null;
  if (opts.discordToken) {
    const token = opts.discordToken;
    const send = opts.discordSend ?? (await import("./commands/discord")).sendMessageToUser;
    discordSendToUser = (userId, text) => send(token, userId, text);
  }

  return { telegramSend, discordSendToUser };
}
