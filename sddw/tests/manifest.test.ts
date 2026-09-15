import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { renderManifestYaml, renderMarkdown } from '../src/domain/manifest';
import { computeCompletion, emptySections, overallCompletion, withSection } from '../src/domain/sections';
import type { Specification } from '../src/domain/types';

const user = { id: 'u1', displayName: 'Jane Doe', email: 'jane@pearson.com' };
const spec: Specification = { id: 'SPEC-LRN-0001', title: 'Offline Reader', productArea: 'Learning', status: 'Active', lifecycleStage: 'Draft', owner: user, contributors: [], tags: ['mobile'], currentVersion: '0.1', completion: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', updatedBy: user, dataClassification: 'internal', certificationStale: false };

describe('sections and completion', () => {
  it('starts empty and grades partial/complete', () => {
    const s = emptySections();
    expect(overallCompletion(s)).toBeGreaterThanOrEqual(0);
    expect(computeCompletion('productIntent', { problem: 'x', outcome: '', successMetrics: [], constraints: [] })).toBe('partial');
    expect(computeCompletion('productIntent', { problem: 'x', outcome: 'y', successMetrics: ['m'], constraints: [] })).toBe('complete');
    const next = withSection(s, 'productIntent', { problem: 'x', outcome: 'y', successMetrics: ['m'], constraints: [] });
    expect(next.productIntent.completion).toBe('complete');
    expect(overallCompletion(next)).toBeGreaterThan(overallCompletion(s));
  });
});

describe('manifest and markdown rendering', () => {
  it('renders a parseable YAML manifest with all sections', () => {
    const sections = emptySections();
    const yaml = renderManifestYaml({ spec, version: '0.1', sections });
    const parsed = parse(yaml);
    expect(parsed.sddw).toBe(1);
    expect(parsed.spec.id).toBe('SPEC-LRN-0001');
    expect(Object.keys(parsed.sections)).toHaveLength(18);
    expect(parsed.certification.privacy).toBe('pending');
  });
  it('renders Markdown with every group heading and is deterministic', () => {
    const sections = emptySections();
    const md = renderMarkdown({ spec, version: '0.1', sections });
    for (const g of ['Product', 'UX', 'Architecture', 'Data', 'Engineering', 'QA', 'Operations']) expect(md).toContain(`## ${g}`);
    expect(md).toBe(renderMarkdown({ spec, version: '0.1', sections }));
  });
});
