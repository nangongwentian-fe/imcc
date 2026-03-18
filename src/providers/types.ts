import type { ProfileConfig, ProviderKind } from '../config.js';
import type { StreamCallbacks } from '../bridge.js';
import type { SessionInfo } from '../sessions.js';
import type { BridgeResult } from '../types.js';

export interface SessionState {
  model?: string;
  cwd?: string;
  resumeSessionId?: string;
  allowedTools?: string[];
}

export interface ProviderRunContext {
  profile: ProfileConfig;
  state: SessionState;
  permissionPromptJid?: string;
}

export interface ProviderCapabilities {
  permissionPrompts: boolean;
  trueStreaming: boolean;
  modelHelp: string;
}

export interface Provider {
  kind: ProviderKind;
  displayName: string;
  capabilities: ProviderCapabilities;
  resolveModel(input: string): string | null;
  getCurrentModel(state: SessionState, profile: ProfileConfig): string;
  runStream(
    prompt: string,
    context: ProviderRunContext,
    callbacks: StreamCallbacks,
  ): Promise<BridgeResult>;
  startFreshSession(context: Omit<ProviderRunContext, 'permissionPromptJid'>): Promise<string | null>;
  listSessions(opts: { cwd?: string; limit?: number }): SessionInfo[];
  findSessionByPrefix(prefix: string, opts: { cwd?: string; limit?: number }): SessionInfo[];
}
