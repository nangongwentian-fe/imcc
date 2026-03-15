import { runClaude } from './bridge.js';
import { getConfig } from './config.js';
import type { Channel, OnInboundMessage } from './types.js';
import { handleCommand } from './commands.js';
import type { SessionState } from './commands.js';

function findChannel(channels: Channel[], jid: string): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

/**
 * Build the OnInboundMessage handler.
 * Accepts a `getChannels` getter so channels can be wired up after handler creation.
 */
export function createMessageHandler(getChannels: () => Channel[]): OnInboundMessage {
  const cfg = getConfig();
  const claudeCfg = cfg.claude ?? {};

  // One in-flight claude call per jid at a time
  const inFlight = new Set<string>();

  // Per-jid session state: current model, current cwd override
  const sessionStates = new Map<string, SessionState>();

  return async (jid, text, _senderId) => {
    if (inFlight.has(jid)) {
      console.log(`[router] ${jid} busy, dropping message`);
      return;
    }

    const channel = findChannel(getChannels(), jid);
    if (!channel) {
      console.warn(`[router] no channel owns jid: ${jid}`);
      return;
    }

    if (!sessionStates.has(jid)) {
      sessionStates.set(jid, {});
    }
    const state = sessionStates.get(jid)!;

    const baseCfg = {
      cwd: claudeCfg.cwd,
      extraArgs: claudeCfg.extraArgs,
      timeoutMs: claudeCfg.timeoutMs,
    };

    inFlight.add(jid);

    const isCommand = await handleCommand(text, jid, channel, state, baseCfg);
    if (isCommand) {
      inFlight.delete(jid);
      return;
    }

    await channel.setTyping?.(jid, true);

    console.log(`[router] → claude | ${jid} | ${text.slice(0, 80)}`);

    const result = await runClaude(text, {
      ...baseCfg,
      cwd: state.cwd ?? claudeCfg.cwd,
      model: state.model,
    });

    await channel.setTyping?.(jid, false);
    inFlight.delete(jid);

    if (result.status === 'success' && result.output) {
      await channel.sendMessage(jid, result.output);
    } else if (result.status === 'error') {
      await channel.sendMessage(jid, `⚠️ ${result.output || 'Unknown error'}`);
    }
  };
}
