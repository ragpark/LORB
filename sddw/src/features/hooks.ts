import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePrincipal, useRepository } from '@/app/providers';
import type { CatalogueQuery, LifecycleStage, SectionContentMap, SectionKey } from '@/domain/types';

export interface SaveSectionArgs { version: string; key: SectionKey; content: SectionContentMap[SectionKey]; etag: string; source?: 'human' | 'ai' }

export const keys = {
  dashboard: (area?: string) => ['dashboard', area] as const,
  list: (q: CatalogueQuery) => ['specs', q] as const,
  spec: (id: string) => ['spec', id] as const,
  version: (id: string, v?: string) => ['version', id, v] as const,
  reviews: (id: string) => ['reviews', id] as const,
  approvals: (id: string, v: string) => ['approvals', id, v] as const,
  pack: (id: string, v: string) => ['pack', id, v] as const,
  audit: (id: string) => ['audit', id] as const,
  areas: ['areas'] as const,
  tags: ['tags'] as const,
};

export function useDashboard(area?: string) { const repo = useRepository(); return useQuery({ queryKey: keys.dashboard(area), queryFn: () => repo.dashboard(area ? { productArea: area } : undefined) }); }
export function useCatalogue(q: CatalogueQuery) { const repo = useRepository(); return useQuery({ queryKey: keys.list(q), queryFn: () => repo.list(q) }); }
export function useSpecification(id: string) { const repo = useRepository(); return useQuery({ queryKey: keys.spec(id), queryFn: () => repo.get(id) }); }
export function useVersion(id: string, v?: string) { const repo = useRepository(); return useQuery({ queryKey: keys.version(id, v), queryFn: () => repo.getVersion(id, v) }); }
export function useReviews(id: string) { const repo = useRepository(); return useQuery({ queryKey: keys.reviews(id), queryFn: () => repo.listReviews(id) }); }
export function useApprovals(id: string, v: string) { const repo = useRepository(); return useQuery({ queryKey: keys.approvals(id, v), queryFn: () => repo.listApprovals(id, v), enabled: !!v }); }
export function usePack(id: string, v: string) { const repo = useRepository(); return useQuery({ queryKey: keys.pack(id, v), queryFn: () => repo.getPack(id, v), enabled: !!v }); }
export function useAudit(id: string) { const repo = useRepository(); return useQuery({ queryKey: keys.audit(id), queryFn: () => repo.listAudit(id) }); }
export function useProductAreas() { const repo = useRepository(); return useQuery({ queryKey: keys.areas, queryFn: () => repo.productAreas() }); }
export function useTags() { const repo = useRepository(); return useQuery({ queryKey: keys.tags, queryFn: () => repo.tags() }); }

export function useInvalidateSpec() {
  const qc = useQueryClient();
  return (id: string) => Promise.all([
    qc.invalidateQueries({ queryKey: ['spec', id] }), qc.invalidateQueries({ queryKey: ['version', id] }), qc.invalidateQueries({ queryKey: ['reviews', id] }),
    qc.invalidateQueries({ queryKey: ['approvals', id] }), qc.invalidateQueries({ queryKey: ['pack', id] }), qc.invalidateQueries({ queryKey: ['audit', id] }),
    qc.invalidateQueries({ queryKey: ['dashboard'] }), qc.invalidateQueries({ queryKey: ['specs'] }),
  ]);
}

export function useSaveSection(id: string) {
  const repo = useRepository(); const { user } = usePrincipal(); const invalidate = useInvalidateSpec();
  return useMutation({
    mutationFn: (args: SaveSectionArgs) => repo.saveSection({ id, actor: user, ...args } as Parameters<typeof repo.saveSection>[0]),
    onSuccess: () => invalidate(id),
  });
}

export function usePromote(id: string) {
  const repo = useRepository(); const { user } = usePrincipal(); const invalidate = useInvalidateSpec();
  return useMutation({ mutationFn: (args: { to: LifecycleStage; reason?: string }) => repo.promote(id, args.to, user, args.reason), onSuccess: () => invalidate(id) });
}

export function useCreateSpecification() {
  const repo = useRepository(); const { user } = usePrincipal(); const qc = useQueryClient();
  return useMutation({ mutationFn: (args: { title: string; productArea: string; tags?: string[] }) => repo.create({ ...args, owner: user }, user), onSuccess: () => { qc.invalidateQueries({ queryKey: ['specs'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); qc.invalidateQueries({ queryKey: keys.areas }); } });
}
