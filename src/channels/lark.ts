import * as lark from '@larksuiteoapi/node-sdk';
import type { ProfileConfig } from '../config.js';
import { getPermissionBroker, type PermissionDecision } from '../permission-broker.js';
import { registerChannel } from './registry.js';
import type { Channel, OnInboundMessage, StreamEndMeta, StreamStatus } from '../types.js';

const STREAM_ELEMENT_ID = 'content';
const STREAM_THROTTLE_MS = 200;

interface CardState {
  cardId: string;
  messageId: string;
  sequence: number;
  startTime: number;
  throttleTimer: ReturnType<typeof setTimeout> | null;
  lastUpdateAt: number;
  pendingText: string | null;
  lastSentText: string;
  queue: Promise<void>;
}

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
    let result = text.replace(/```[\s\S]*?```/g, (match) => `${MARK}${codeBlocks.push(match) - 1}___`);

    const hasH1toH3 = /^#{1,3} /m.test(text);
    if (hasH1toH3) {
      result = result.replace(/^#{2,6} (.+)$/gm, '##### $1');
      result = result.replace(/^# (.+)$/gm, '#### $1');
    }

    codeBlocks.forEach((block, index) => {
      result = result.replace(`${MARK}${index}___`, block);
    });

    return result.replace(/\n{3,}/g, '\n\n');
  } catch {
    return text;
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function createToast(content: string, type: 'info' | 'warning' = 'info') {
  return { toast: { type, content } };
}

class LarkChannel implements Channel {
  name = 'lark';
  private wsClient: lark.WSClient | null = null;
  private httpClient: lark.Client | null = null;
  private connected = false;

  // Track latest message_id and reaction_id per jid for typing indicator
  private lastMsgId = new Map<string, string>();
  private reactionId = new Map<string, string>();
  private activeCards = new Map<string, CardState>();

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly allowedUserIds: Set<string>,
    private readonly onMessage: OnInboundMessage,
  ) {}

  async connect(): Promise<void> {
    this.httpClient = new lark.Client({ appId: this.appId, appSecret: this.appSecret });

    const dispatcher = new lark.EventDispatcher({}) as unknown as {
      register(handlers: Record<string, (data: any) => Promise<any> | any>): unknown;
    };

    dispatcher.register({
      'im.message.receive_v1': async (data: any) => {
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

        this.lastMsgId.set(jid, msg.message_id);
        this.onMessage(jid, text, senderId);
      },
    });

    dispatcher.register({
      'card.action.trigger': async (data: any) => {
        const callbackData = data.action?.value?.callback_data;
        const chatId = data.context?.open_chat_id;

        if (typeof callbackData !== 'string') {
          return createToast('无效的审批操作', 'warning');
        }

        const match = /^perm:(allow|allow_session|deny):([a-f0-9-]+)$/i.exec(callbackData);
        if (!match) {
          return createToast('无法识别的审批操作', 'warning');
        }

        const decision = match[1].toLowerCase() as PermissionDecision;
        const permId = match[2];
        const result = getPermissionBroker().resolvePending(permId, decision, { chatId });
        return createToast(result.message, result.ok ? 'info' : 'warning');
      },
    });

    this.wsClient = new lark.WSClient({ appId: this.appId, appSecret: this.appSecret });
    this.patchCardCallbackSupport(this.wsClient);
    this.wsClient.start({ eventDispatcher: dispatcher as never });
    this.connected = true;
    console.log('  Lark: WebSocket long connection started');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.httpClient) return;

    const chatId = jid.replace(/^lark:/, '');
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
        const reactionId = res.data?.reaction_id;
        if (reactionId) this.reactionId.set(jid, reactionId);
      } catch {
        // Typing indicator is best-effort.
      }
      return;
    }

    const reactionId = this.reactionId.get(jid);
    if (!reactionId) return;

    try {
      await this.httpClient.im.messageReaction.delete({
        path: { message_id: msgId, reaction_id: reactionId },
      });
    } catch {
      // Best-effort cleanup.
    } finally {
      this.reactionId.delete(jid);
    }
  }

  async onStreamStart(jid: string): Promise<void> {
    if (!this.httpClient) return;

    const messageId = this.lastMsgId.get(jid);
    if (!messageId) return;

    this.clearActiveCard(jid);

    try {
      const card = await this.httpClient.cardkit.v1.card.create({
        data: {
          type: 'card_json',
          data: JSON.stringify(this.buildStreamingCard('Thinking...')),
        },
      });

      const cardId = card.data?.card_id;
      if (!cardId) {
        throw new Error('card_id missing from CardKit create response');
      }

      const reply = await this.httpClient.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
        },
      });

      this.activeCards.set(jid, {
        cardId,
        messageId: reply.data?.message_id ?? messageId,
        sequence: 0,
        startTime: Date.now(),
        throttleTimer: null,
        lastUpdateAt: Date.now(),
        pendingText: null,
        lastSentText: 'Thinking...',
        queue: Promise.resolve(),
      });
    } catch (err) {
      console.warn('[lark] failed to create streaming card, falling back to post:', err);
      this.clearActiveCard(jid);
    }
  }

  onStreamText(jid: string, fullText: string): void {
    const state = this.activeCards.get(jid);
    if (!state) return;

    const processed = optimizeMarkdownStyle(fullText).trim() || 'Thinking...';
    state.pendingText = processed;

    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
    }

    state.throttleTimer = setTimeout(() => {
      void this.flushCardText(jid);
    }, STREAM_THROTTLE_MS);
  }

  async onStreamEnd(
    jid: string,
    status: StreamStatus,
    text: string,
    meta?: StreamEndMeta,
  ): Promise<void> {
    const state = this.activeCards.get(jid);
    if (!state || !this.httpClient) {
      const fallback = status === 'error' ? `⚠️ ${text}` : text;
      await this.sendMessage(jid, fallback);
      await this.setTyping(jid, false);
      return;
    }

    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }

    state.pendingText = optimizeMarkdownStyle(status === 'error' ? `⚠️ ${text}` : text);
    await this.flushCardText(jid, true);

    const elapsedMs = meta?.durationMs ?? Date.now() - state.startTime;
    const finalCard = this.buildFinalCard(status, text, elapsedMs, meta?.cost);

    try {
      await this.enqueueCardTask(jid, async (current) => {
        if (!this.httpClient) return;

        await this.httpClient.cardkit.v1.card.settings({
          path: { card_id: current.cardId },
          data: {
            settings: JSON.stringify({
              config: { streaming_mode: false, wide_screen_mode: true },
            }),
            sequence: this.nextSequence(current),
          },
        });

        await this.httpClient.cardkit.v1.card.update({
          path: { card_id: current.cardId },
          data: {
            card: {
              type: 'card_json',
              data: JSON.stringify(finalCard),
            },
            sequence: this.nextSequence(current),
          },
        });
      });
    } catch (err) {
      console.warn('[lark] failed to finalize streaming card, falling back to post:', err);
      await this.sendMessage(jid, status === 'error' ? `⚠️ ${text}` : text);
    } finally {
      this.clearActiveCard(jid);
      await this.setTyping(jid, false);
    }
  }

  async sendPermissionCard(
    jid: string,
    toolName: string,
    toolInput: string,
    permId: string,
  ): Promise<void> {
    if (!this.httpClient) return;

    const messageId = this.lastMsgId.get(jid);
    const content = JSON.stringify(
      this.buildPermissionCard(toolName, toolInput, permId),
    );

    try {
      if (messageId) {
        await this.httpClient.im.message.reply({
          path: { message_id: messageId },
          data: {
            msg_type: 'interactive',
            content,
          },
        });
        return;
      }

      const chatId = jid.replace(/^lark:/, '');
      await this.httpClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content,
        },
      });
    } catch (err) {
      console.warn('[lark] failed to send permission card, falling back to text:', err);
      await this.sendMessage(
        jid,
        [
          `Claude 请求工具权限：${toolName}`,
          `输入：${toolInput}`,
          '回复以下命令审批：',
          `/perm allow ${permId}`,
          `/perm allow-session ${permId}`,
          `/perm deny ${permId}`,
        ].join('\n'),
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('lark:');
  }

  async disconnect(): Promise<void> {
    for (const jid of this.activeCards.keys()) {
      this.clearActiveCard(jid);
    }
    this.wsClient?.close();
    this.wsClient = null;
    this.connected = false;
  }

  private patchCardCallbackSupport(client: lark.WSClient): void {
    const target = client as unknown as {
      handleEventData: (data: any) => Promise<void>;
    };
    const original = target.handleEventData.bind(client);

    target.handleEventData = async (data: any) => {
      const headers = Array.isArray(data?.headers) ? data.headers : [];
      const messageType = headers.find((header: any) => header.key === 'type')?.value;
      if (messageType === 'card') {
        data = {
          ...data,
          headers: headers.map((header: any) =>
            header.key === 'type' ? { ...header, value: 'event' } : header,
          ),
        };
      }
      await original(data);
    };
  }

  private nextSequence(state: CardState): number {
    state.sequence += 1;
    return state.sequence;
  }

  private enqueueCardTask(
    jid: string,
    task: (state: CardState) => Promise<void>,
  ): Promise<void> {
    const state = this.activeCards.get(jid);
    if (!state) return Promise.resolve();

    state.queue = state.queue
      .then(async () => {
        const current = this.activeCards.get(jid);
        if (!current) return;
        await task(current);
      })
      .catch((err) => {
        console.warn('[lark] card update failed:', err);
      });

    return state.queue;
  }

  private async flushCardText(jid: string, force = false): Promise<void> {
    const state = this.activeCards.get(jid);
    if (!state || !this.httpClient) return;

    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }

    const content = state.pendingText;
    if (!content) return;

    if (!force && content === state.lastSentText) {
      state.pendingText = null;
      return;
    }

    state.pendingText = null;
    await this.enqueueCardTask(jid, async (current) => {
      if (!this.httpClient) return;
      if (content === current.lastSentText) return;

      await this.httpClient.cardkit.v1.cardElement.content({
        path: {
          card_id: current.cardId,
          element_id: STREAM_ELEMENT_ID,
        },
        data: {
          content,
          sequence: this.nextSequence(current),
        },
      });

      current.lastSentText = content;
      current.lastUpdateAt = Date.now();
    });
  }

  private clearActiveCard(jid: string): void {
    const state = this.activeCards.get(jid);
    if (!state) return;

    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
    }

    this.activeCards.delete(jid);
  }

  private buildStreamingCard(content: string) {
    return {
      schema: '2.0',
      config: {
        streaming_mode: true,
        wide_screen_mode: true,
        streaming_config: {
          print_frequency_ms: { default: 70 },
          print_step: { default: 1 },
          print_strategy: 'fast',
        },
      },
      body: {
        elements: [
          {
            tag: 'markdown',
            content,
            element_id: STREAM_ELEMENT_ID,
          },
        ],
      },
    };
  }

  private buildFinalCard(
    status: StreamStatus,
    text: string,
    durationMs: number,
    cost?: number,
  ) {
    const footerParts = [
      status === 'completed' ? 'Completed' : 'Error',
      formatDuration(durationMs),
    ];
    if (typeof cost === 'number' && Number.isFinite(cost)) {
      footerParts.push(`$${cost.toFixed(4)}`);
    }

    return {
      schema: '2.0',
      config: {
        wide_screen_mode: true,
      },
      body: {
        elements: [
          {
            tag: 'markdown',
            content: optimizeMarkdownStyle(status === 'error' ? `⚠️ ${text}` : text),
            element_id: STREAM_ELEMENT_ID,
          },
          {
            tag: 'markdown',
            content: `_${footerParts.join(' · ')}_`,
          },
        ],
      },
    };
  }

  private buildPermissionCard(toolName: string, toolInput: string, permId: string) {
    const createPermissionButton = (
      text: string,
      callbackData: string,
      type?: 'primary' | 'danger',
    ) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: text },
      width: 'fill',
      size: 'small',
      ...(type ? { type } : {}),
      behaviors: [
        {
          type: 'callback',
          value: { callback_data: callbackData },
        },
      ],
    });

    return {
      schema: '2.0',
      config: {
        wide_screen_mode: true,
      },
      body: {
        elements: [
          {
            tag: 'markdown',
            content: [
              `**Claude 请求工具权限**`,
              '',
              `工具：\`${toolName}\``,
              `输入：\`${truncate(toolInput, 300)}\``,
            ].join('\n'),
          },
          createPermissionButton('Allow', `perm:allow:${permId}`, 'primary'),
          createPermissionButton('Allow Session', `perm:allow_session:${permId}`),
          createPermissionButton('Deny', `perm:deny:${permId}`, 'danger'),
        ],
      },
    };
  }
}

registerChannel('lark', (profile: ProfileConfig, onMessage: OnInboundMessage) => {
  if (profile.channel.type !== 'lark') return null;

  const allowed = new Set(profile.channel.allowedUserIds ?? []);
  return new LarkChannel(
    profile.channel.appId,
    profile.channel.appSecret,
    allowed,
    onMessage,
  );
});
