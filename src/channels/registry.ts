import type { Channel, ChannelFactory, OnInboundMessage } from '../types.js';

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function createChannels(onMessage: OnInboundMessage): Channel[] {
  const channels: Channel[] = [];
  for (const [, factory] of registry) {
    const channel = factory(onMessage);
    if (channel) channels.push(channel);
  }
  return channels;
}
