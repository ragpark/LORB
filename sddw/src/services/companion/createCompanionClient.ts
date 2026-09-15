import type { RuntimeConfig } from '@/app/runtimeConfig';
import type { TokenProvider } from '@/services/http';
import { HttpCompanionClient } from './HttpCompanionClient';
import { MockCompanionClient } from './MockCompanionClient';
import type { CompanionClient } from './types';

export function createCompanionClient(cfg: RuntimeConfig, getToken: TokenProvider): CompanionClient {
  return cfg.companionBaseUrl ? new HttpCompanionClient(getToken, cfg.companionBaseUrl, cfg.companionScope || `${cfg.companionBaseUrl}/.default`) : new MockCompanionClient();
}
