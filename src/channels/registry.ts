import type { ProfileConfig } from '../config.js';
import type { Channel, ChannelFactory, OnInboundMessage } from '../types.js';

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function createChannels(profile: ProfileConfig, onMessage: OnInboundMessage): Channel[] {
  const channels: Channel[] = [];
  for (const [, factory] of registry) {
    const channel = factory(profile, onMessage);
    if (channel) channels.push(channel);
  }
  return channels;
}
