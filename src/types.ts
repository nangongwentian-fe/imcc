import type { ProfileConfig } from './config.js';

export interface StreamEndMeta {
  durationMs?: number;
  cost?: number;
}

export type StreamStatus = 'completed' | 'error';

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  /** Called before streaming starts (e.g. create streaming card) */
  onStreamStart?(jid: string): Promise<void>;
  /** Called with accumulated full text on each text delta (throttle internally) */
  onStreamText?(jid: string, fullText: string): void;
  /** Called when streaming completes or errors */
  onStreamEnd?(jid: string, status: StreamStatus, text: string, meta?: StreamEndMeta): Promise<void>;
  /** Send a permission approval card (Phase 2) */
  sendPermissionCard?(jid: string, toolName: string, toolInput: string, permId: string): Promise<void>;
}

/** Called when a message arrives from any channel */
export type OnInboundMessage = (jid: string, text: string, senderId: string) => void;

/** Factory receives the message callback and returns a Channel (or null if not configured) */
export type ChannelFactory = (profile: ProfileConfig, onMessage: OnInboundMessage) => Channel | null;

export interface BridgeResult {
  status: 'success' | 'error';
  output: string;
}
