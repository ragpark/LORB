import { z } from 'zod';

/** Non-secret runtime configuration served by server/index.mjs at /app-config.json. */
export const RuntimeConfigSchema = z.object({
  storageProvider: z.enum(['mock', 'sharepoint', 'dataverse']).default('mock'),
  entraTenantId: z.string().default(''),
  entraClientId: z.string().default(''),
  sharePointSiteId: z.string().default(''),
  sharePointDriveId: z.string().default(''),
  dataverseOrgUrl: z.string().default(''),
  companionBaseUrl: z.string().default(''),
  companionScope: z.string().default(''),
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

let cached: RuntimeConfig | null = null;

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (cached) return cached;
  try {
    const res = await fetch('/app-config.json', { cache: 'no-store' });
    cached = RuntimeConfigSchema.parse(res.ok ? await res.json() : {});
  } catch {
    cached = RuntimeConfigSchema.parse({});
  }
  return cached;
}

export const requiresMsal = (c: RuntimeConfig) => c.storageProvider !== 'mock' || !!c.companionBaseUrl;
