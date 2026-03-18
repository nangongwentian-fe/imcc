import { Bot, Api } from 'grammy';
import type { ProfileConfig } from '../config.js';
import { registerChannel } from './registry.js';
import type { Channel, OnInboundMessage } from '../types.js';

async function sendTelegramMessage(
  api: Api,
  chatId: string,
  text: string,
): Promise<void> {
  // Telegram limit: 4096 chars per message
  const MAX = 4096;
  const chunks = [];
  for (let i = 0; i < text.length; i += MAX) {
    chunks.push(text.slice(i, i + MAX));
  }
  for (const chunk of chunks) {
    try {
      await api.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
    } catch {
      await api.sendMessage(chatId, chunk);
    }
  }
}

class TelegramChannel implements Channel {
  name = 'telegram';
  private bot: Bot | null = null;

  constructor(
    private readonly token: string,
    private readonly allowedChatIds: Set<string>,
    private readonly onMessage: OnInboundMessage,
  ) {}

  async connect(): Promise<void> {
    this.bot = new Bot(this.token);

    this.bot.command('ping', (ctx) => ctx.reply('imcc is running.'));
    this.bot.command('chatid', (ctx) =>
      ctx.reply(`Chat ID: \`tg:${ctx.chat.id}\``, { parse_mode: 'Markdown' }),
    );

    this.bot.on('message:text', (ctx) => {
      const jid = `tg:${ctx.chat.id}`;
      if (!this.allowedChatIds.has(jid)) return;

      const senderId = ctx.from?.id.toString() ?? '';
      this.onMessage(jid, ctx.message.text, senderId);
    });

    this.bot.catch((err) => {
      console.error('[telegram] error:', err.message);
    });

    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (info) => {
          console.log(`  Telegram: @${info.username} connected`);
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) return;
    const chatId = jid.replace(/^tg:/, '');
    await sendTelegramMessage(this.bot.api, chatId, text);
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    this.bot?.stop();
    this.bot = null;
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    const chatId = jid.replace(/^tg:/, '');
    await this.bot.api.sendChatAction(chatId, 'typing').catch(() => {});
  }
}

registerChannel('telegram', (profile: ProfileConfig, onMessage: OnInboundMessage) => {
  if (profile.channel.type !== 'telegram') return null;

  const allowed = new Set(profile.channel.allowedChatIds ?? []);
  return new TelegramChannel(profile.channel.botToken, allowed, onMessage);
});
