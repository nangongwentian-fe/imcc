import type { ProfileConfig } from './config.js';
import { allowToolForSession, handleCommand } from './commands.js';
import { getPermissionBroker } from './permission-broker.js';
import type { Provider, SessionState } from './providers/types.js';
import type { Channel } from './types.js';

interface MessageHandlerOptions {
  getChannels: () => Channel[];
  profile: ProfileConfig;
  provider: Provider;
}

function findChannel(channels: Channel[], jid: string): Channel | undefined {
  return channels.find((channel) => channel.ownsJid(jid));
}

function isPermissionCommand(text: string): boolean {
  return text.trim().toLowerCase().startsWith('/perm');
}

export function createMessageHandler(options: MessageHandlerOptions) {
  const { getChannels, profile, provider } = options;
  const inFlight = new Set<string>();
  const sessionStates = new Map<string, SessionState>();

  return async (jid: string, text: string, _senderId: string) => {
    const channel = findChannel(getChannels(), jid);
    if (!channel) {
      console.warn(`[router] no channel owns jid: ${jid}`);
      return;
    }

    if (!sessionStates.has(jid)) {
      sessionStates.set(jid, {});
    }
    const state = sessionStates.get(jid)!;

    if (inFlight.has(jid)) {
      if (isPermissionCommand(text)) {
        await handleCommand(text, jid, channel, provider, profile, state);
        return;
      }

      console.log(`[router] ${jid} busy, dropping message`);
      return;
    }

    inFlight.add(jid);
    let permissionContextRegistered = false;

    try {
      const isCommand = await handleCommand(text, jid, channel, provider, profile, state);
      if (isCommand) {
        return;
      }

      await channel.setTyping?.(jid, true);
      console.log(`[router] → ${provider.kind} | ${jid} | ${text.slice(0, 80)}`);

      if (provider.capabilities.permissionPrompts) {
        getPermissionBroker().registerContext(jid, {
          channel,
          allowTool: (toolName) => allowToolForSession(state, toolName),
          permissionTimeoutMs: profile.runtime?.permissionTimeoutMs,
        });
        permissionContextRegistered = true;
      }

      const result = await provider.runStream(
        text,
        {
          profile,
          state,
          permissionPromptJid: provider.capabilities.permissionPrompts ? jid : undefined,
        },
        {
          onInit: async (sessionId) => {
            if (sessionId) {
              state.resumeSessionId = sessionId;
            }
            await channel.onStreamStart?.(jid);
          },
          onText: (delta, fullText) => {
            if (!delta) return;
            channel.onStreamText?.(jid, fullText);
          },
          onComplete: async (streamResult) => {
            await channel.onStreamEnd?.(jid, 'completed', streamResult.text, {
              durationMs: streamResult.durationMs,
              cost: streamResult.cost,
            });
          },
          onError: async (error) => {
            await channel.onStreamEnd?.(jid, 'error', error);
          },
        },
      );

      if (!channel.onStreamEnd) {
        if (result.status === 'success' && result.output) {
          await channel.sendMessage(jid, result.output);
        } else if (result.status === 'error') {
          await channel.sendMessage(jid, `⚠️ ${result.output || 'Unknown error'}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[router] provider ${provider.kind} failed:`, err);

      if (channel.onStreamEnd) {
        await channel.onStreamEnd(jid, 'error', message);
      } else {
        await channel.sendMessage(jid, `⚠️ ${message}`);
      }
    } finally {
      if (permissionContextRegistered) {
        getPermissionBroker().unregisterContext(jid);
      }
      await channel.setTyping?.(jid, false);
      inFlight.delete(jid);
    }
  };
}
