export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
}

/** Called when a message arrives from any channel */
export type OnInboundMessage = (jid: string, text: string, senderId: string) => void;

/** Factory receives the message callback and returns a Channel (or null if not configured) */
export type ChannelFactory = (onMessage: OnInboundMessage) => Channel | null;

export interface BridgeResult {
  status: 'success' | 'error';
  output: string;
}
