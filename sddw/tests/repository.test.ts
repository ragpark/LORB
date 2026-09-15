import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '../src/services/storage/mock/InMemoryRepository';
import { seedRepository } from '../src/mocks/seed';
import { ConcurrencyError, GuardError } from '../src/services/storage/SpecificationRepository';

const user = { id: 'u1', displayName: 'Jane Doe', email: 'jane@pearson.com' };

describe('InMemoryRepository', () => {
  it('creates, saves a section with etag, and audits', async () => {
    const repo = new InMemoryRepository();
    const spec = await repo.create({ title: 'T', productArea: 'Learning', owner: user }, user);
    expect(spec.id).toBe('SPEC-LRN-0001');
    const v = await repo.getVersion(spec.id);
    const saved = await repo.saveSection({ id: spec.id, version: v.version, key: 'productIntent', content: { problem: 'p', outcome: 'o', successMetrics: ['m'], constraints: [] }, etag: v.etag, actor: user });
    expect(saved.sections.productIntent.completion).toBe('complete');
    await expect(repo.saveSection({ id: spec.id, version: v.version, key: 'personas', content: { personas: [] }, etag: v.etag, actor: user })).rejects.toBeInstanceOf(ConcurrencyError);
    const audit = await repo.listAudit(spec.id);
    expect(audit.map((a) => a.action)).toEqual(['section.updated', 'created']);
  });
  it('enforces promotion guards', async () => {
    const repo = new InMemoryRepository();
    const spec = await repo.create({ title: 'T', productArea: 'Learning', owner: user }, user);
    await expect(repo.promote(spec.id, 'Review', user)).rejects.toBeInstanceOf(GuardError);
  });
  it('seeds a demo dataset with a dashboard', async () => {
    const repo = seedRepository(new InMemoryRepository());
    const d = await repo.dashboard();
    expect(d.byStage.Review).toBeGreaterThan(0);
    expect(d.openBlockers.length).toBeGreaterThan(0);
    expect(d.certificationQueue.length).toBeGreaterThan(0);
    const page = await repo.list({ lifecycleStage: ['Certified'] });
    expect(page.items.every((s) => s.lifecycleStage === 'Certified')).toBe(true);
  });
});
