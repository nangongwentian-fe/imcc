import * as lark from '@larksuiteoapi/node-sdk';
import { getConfig } from '../config.js';
import { registerChannel } from './registry.js';
import type { Channel, OnInboundMessage } from '../types.js';

/**
 * Optimize markdown for Feishu post rendering (ported from larksuite/openclaw-lark).
 * - Demotes H1→H4, H2-H6→H5 when H1-H3 headings are present
 * - Collapses 3+ blank lines to 2
 * - Protects code blocks from mangling
 */
function optimizeMarkdownStyle(text: string): string {
  try {
    const MARK = '___CB_';
    const codeBlocks: string[] = [];
    let r = text.replace(/```[\s\S]*?```/g, (m) => `${MARK}${codeBlocks.push(m) - 1}___`);

    const hasH1toH3 = /^#{1,3} /m.test(text);
    if (hasH1toH3) {
      r = r.replace(/^#{2,6} (.+)$/gm, '##### $1');
      r = r.replace(/^# (.+)$/gm, '#### $1');
    }

    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, block);
    });

    r = r.replace(/\n{3,}/g, '\n\n');
    return r;
  } catch {
    return text;
  }
}

class LarkChannel implements Channel {
  name = 'lark';
  private wsClient: lark.WSClient | null = null;
  private httpClient: lark.Client | null = null;
  private connected = false;

  // Track latest message_id and reaction_id per jid for typing indicator
  private lastMsgId = new Map<string, string>();
  private reactionId = new Map<string, string>();

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly allowedUserIds: Set<string>,
    private readonly onMessage: OnInboundMessage,
  ) {}

  async connect(): Promise<void> {
    this.httpClient = new lark.Client({ appId: this.appId, appSecret: this.appSecret });

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        const msg = data.message;
        if (msg.message_type !== 'text') return;

        const senderId = data.sender.sender_id?.open_id ?? '';
        if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(senderId)) return;

        const jid = `lark:${msg.chat_id}`;
        let text = '';
        try {
          text = (JSON.parse(msg.content) as { text: string }).text ?? '';
        } catch {
          return;
        }

        // Store message_id so setTyping can react to it
        this.lastMsgId.set(jid, msg.message_id);

        this.onMessage(jid, text, senderId);
      },
    });

    this.wsClient = new lark.WSClient({ appId: this.appId, appSecret: this.appSecret });
    this.wsClient.start({ eventDispatcher: dispatcher });
    this.connected = true;
    console.log(`  Lark: WebSocket long connection started`);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.httpClient) return;
    const chatId = jid.replace(/^lark:/, '');
    // Use msg_type 'post' with 'md' tag — same approach as larksuite/openclaw-lark.
    // This renders markdown (bold, code, lists, headings) correctly in Feishu.
    const processed = optimizeMarkdownStyle(text);
    const content = JSON.stringify({
      zh_cn: { content: [[{ tag: 'md', text: processed }]] },
    });
    await this.httpClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'post', content },
    });
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.httpClient) return;
    const msgId = this.lastMsgId.get(jid);
    if (!msgId) return;

    if (isTyping) {
      try {
        const res = await this.httpClient.im.messageReaction.create({
          path: { message_id: msgId },
          data: { reaction_type: { emoji_type: 'Typing' } },
        });
        const rid = res.data?.reaction_id;
        if (rid) this.reactionId.set(jid, rid);
      } catch {
        // typing indicator is best-effort
      }
    } else {
      const rid = this.reactionId.get(jid);
      if (!rid) return;
      try {
        await this.httpClient.im.messageReaction.delete({
          path: { message_id: msgId, reaction_id: rid },
        });
        this.reactionId.delete(jid);
      } catch {
        // best-effort
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('lark:');
  }

  async disconnect(): Promise<void> {
    this.wsClient?.close();
    this.wsClient = null;
    this.connected = false;
  }
}

registerChannel('lark', (onMessage: OnInboundMessage) => {
  const cfg = getConfig().channels?.lark;
  if (!cfg?.appId || !cfg?.appSecret) return null;

  const allowed = new Set(cfg.allowedUserIds ?? []);
  return new LarkChannel(cfg.appId, cfg.appSecret, allowed, onMessage);
});
