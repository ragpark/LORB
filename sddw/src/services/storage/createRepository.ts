import type { RuntimeConfig } from '@/app/runtimeConfig';
import type { TokenProvider } from '@/services/http';
import { createGraphClient } from '@/services/graph/graphClient';
import { seedRepository } from '@/mocks/seed';
import type { SpecificationRepository } from './SpecificationRepository';
import { InMemoryRepository } from './mock/InMemoryRepository';
import { SharePointRepository } from './sharepoint/SharePointRepository';
import { DataverseRepository } from './dataverse/DataverseRepository';

/** Selects the storage adapter from runtime configuration (ADR-0002). */
export function createRepository(cfg: RuntimeConfig, getToken: TokenProvider): SpecificationRepository {
  switch (cfg.storageProvider) {
    case 'sharepoint':
      return new SharePointRepository(createGraphClient(getToken), { siteId: cfg.sharePointSiteId, driveId: cfg.sharePointDriveId });
    case 'dataverse':
      return new DataverseRepository(getToken, { orgUrl: cfg.dataverseOrgUrl });
    default:
      return seedRepository(new InMemoryRepository());
  }
}
