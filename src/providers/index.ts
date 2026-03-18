import type { ProfileConfig } from '../config.js';
import { ClaudeProvider } from './claude.js';
import { CodexProvider } from './codex.js';
import type { Provider } from './types.js';

const CLAUDE_PROVIDER = new ClaudeProvider();
const CODEX_PROVIDER = new CodexProvider();

export function createProvider(profile: ProfileConfig): Provider {
  switch (profile.provider) {
    case 'claude':
      return CLAUDE_PROVIDER;
    case 'codex':
      return CODEX_PROVIDER;
    default:
      throw new Error(`Unsupported provider: ${(profile as ProfileConfig).provider}`);
  }
}
