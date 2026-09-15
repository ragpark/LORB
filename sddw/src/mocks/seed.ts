import { emptySections, withSection } from '@/domain/sections';
import { renderManifestYaml, renderMarkdown } from '@/domain/manifest';
import { overallCompletion } from '@/domain/sections';
import { uid } from '@/domain/ids';
import type { Finding, Review, Sections, UserRef } from '@/domain/types';
import type { InMemoryRepository } from '@/services/storage/mock/InMemoryRepository';

export const USERS: Record<string, UserRef> = {
  jane: { id: 'u-jane', displayName: 'Jane Doe', email: 'jane.doe@pearson.com' },
  amir: { id: 'u-amir', displayName: 'Amir Khan', email: 'amir.khan@pearson.com' },
  meera: { id: 'u-meera', displayName: 'Meera Singh', email: 'meera.singh@pearson.com' },
  rosa: { id: 'u-rosa', displayName: 'Rosa Osei', email: 'rosa.osei@pearson.com' },
  pat: { id: 'u-pat', displayName: 'Pat Lee', email: 'pat.lee@pearson.com' },
};

const daysAgo = (d: number, h = 0) => new Date(Date.now() - d * 86400000 - h * 3600000).toISOString();

/** Populates the in-memory repository with realistic demonstration data. Synchronous; bypasses the async API on purpose. */
export function seedRepository(repo: InMemoryRepository): InMemoryRepository {
  const st = repo.state;
  const mk = (opts: { area: string; title: string; owner: UserRef; contributors: UserRef[]; stage: import('@/domain/types').LifecycleStage; version: string; tags: string[]; updated: string; fill: (s: Sections) => Sections }) => {
    const seq = (st.seq.get(opts.area) ?? 0) + 1; st.seq.set(opts.area, seq);
    const code = { Learning: 'LRN', Assessment: 'ASM', Platform: 'PLT', 'Higher Education': 'HED' }[opts.area] ?? 'GEN';
    const id = `SPEC-${code}-${String(seq).padStart(4, '0')}`;
    const sections = opts.fill(emptySections());
    const spec: import('@/domain/types').Specification = { id, title: opts.title, productArea: opts.area, status: 'Active', lifecycleStage: opts.stage, owner: opts.owner, contributors: opts.contributors, tags: opts.tags, currentVersion: opts.version, completion: overallCompletion(sections), createdAt: daysAgo(40), updatedAt: opts.updated, updatedBy: opts.contributors[0] ?? opts.owner, dataClassification: 'internal', certificationStale: false };
    const approvals: import('@/domain/types').Approval[] = (['architecture', 'privacy', 'security', 'product'] as const).map((type) => ({ id: uid('apr'), specId: id, version: opts.version, type, status: 'pending', evidence: [] }));
    const v: import('@/domain/types').SpecificationVersion = { specId: id, version: opts.version, sections, markdown: '', manifestYaml: '', etag: uid('etag'), createdAt: daysAgo(10), createdBy: opts.owner, certifiedAt: opts.stage === 'Certified' || opts.stage === 'In Delivery' || opts.stage === 'Released' ? daysAgo(5) : undefined };
    v.markdown = renderMarkdown({ spec, version: opts.version, sections }); v.manifestYaml = renderManifestYaml({ spec, version: opts.version, sections, approvals });
    st.specs.set(id, spec); st.versions.set(id, [v]); st.approvals.set(`${id}@${opts.version}`, approvals);
    st.audit.set(id, [{ id: uid('aud'), specId: id, version: '0.1', action: 'created', actor: opts.owner, at: daysAgo(40), summary: `Created ${id} “${opts.title}”` }, { id: uid('aud'), specId: id, version: opts.version, action: 'section.updated', actor: opts.contributors[0] ?? opts.owner, at: opts.updated, summary: 'Updated userJourneys (partial → complete)' }]);
    return { spec, approvals, version: v };
  };

  const req = (id: string, text: string, priority: 'Must' | 'Should' | 'Could' = 'Must') => ({ id, text, priority });
  const ctl = (id: string, text: string, status: 'planned' | 'in-place' | 'n/a' = 'planned', owner?: string) => ({ id, text, status, owner });

  // 1. Offline Reader — in Review with a blocker
  const offline = mk({ area: 'Learning', title: 'Offline Reader', owner: USERS.jane, contributors: [USERS.amir, USERS.meera], stage: 'Review', version: '1.4', tags: ['mobile', 'offline'], updated: daysAgo(0, 1), fill: (s) => {
    s = withSection(s, 'productIntent', { problem: 'Learners on commutes and in low-connectivity regions cannot access course content reliably.', outcome: 'Any purchased chapter can be read and progress recorded with no connectivity.', successMetrics: ['30% of weekly reading sessions occur offline within 6 months', 'Offline session abandonment < 5%'], constraints: ['Must reuse Content Sync SDK if fit', 'No PII stored unencrypted on device'] });
    s = withSection(s, 'personas', { personas: [{ id: 'P1', name: 'Commuter Chloe', role: 'Undergraduate', goals: ['Read on the train'], frustrations: ['Spinner on tunnels'] }, { id: 'P2', name: 'Rural Raj', role: 'Vocational learner', goals: ['Study at home with poor broadband'], frustrations: ['Downloads fail silently'] }, { id: 'P3', name: 'Tutor Tomas', role: 'Tutor', goals: ['See progress even if learners were offline'], frustrations: ['Gaps in progress reports'] }] });
    s = withSection(s, 'userJourneys', { journeys: [{ id: 'J1', name: 'Download for later', persona: 'P1', steps: ['Open chapter', 'Tap download', 'See progress', 'Confirmation'], outcome: 'Chapter available offline' }, { id: 'J3', name: 'Read on the commute', persona: 'P1', steps: ['Open app offline', 'Open downloaded chapter', 'Read and annotate', 'Progress queued'], outcome: 'Progress syncs when online' }] });
    s = withSection(s, 'uxRequirements', { requirements: [req('UXR-1', 'Download state visible on every chapter card'), req('UXR-2', 'Offline banner is persistent and dismissible', 'Should')], notes: 'Follow Nebula offline pattern.' });
    s = withSection(s, 'accessibilityRequirements', { standard: 'WCAG 2.2 AA', assistiveTech: ['Screen reader', 'Switch access'], requirements: [req('A11Y-1', 'All controls keyboard operable with visible focus order')], notes: '' });
    s = withSection(s, 'architecture', { overview: 'Mobile client with local encrypted store; sync service; xAPI outbox to LRS.', components: ['Reader client', 'Content Sync SDK', 'Progress outbox', 'LRS'], diagramMermaid: 'flowchart LR\n Client-->Sync\n Client-->Outbox-->LRS', patterns: ['Outbox', 'Offline-first'] });
    s = withSection(s, 'adrs', { adrs: [{ id: 'ADR-001', title: 'Use Content Sync SDK', status: 'Accepted', context: 'SDK exists.', decision: 'Adopt.', consequences: 'Dependency on platform team.' }] });
    s = withSection(s, 'nfrs', { nfrs: [{ id: 'NFR-1', category: 'Performance', text: 'Open downloaded chapter', target: '< 1 s p95' }, { id: 'NFR-2', category: 'Availability', text: 'Sync service', target: '99.9%' }] });
    s = withSection(s, 'integrationDesign', { integrations: [{ id: 'INT-1', system: 'LRS', direction: 'outbound', protocol: 'xAPI over HTTPS' }, { id: 'INT-2', system: 'Content Sync SDK', direction: 'bidirectional', protocol: 'SDK' }], notes: '' });
    s = withSection(s, 'dataDesign', { entities: [{ name: 'DownloadedChapter', description: 'Encrypted content blob', fields: ['chapterId', 'version', 'bytes'], classification: 'internal' }, { name: 'ProgressEvent', description: 'Queued xAPI statement', fields: ['actor', 'verb', 'object', 'timestamp'], classification: 'confidential' }], retention: '7 years for progress; content until licence expiry', notes: '' });
    s = withSection(s, 'security', { threatModelRef: '', controls: [ctl('SEC-1', 'AES-256 at rest via OS keystore', 'planned', 'Mobile team')] });
    s = withSection(s, 'privacy', { dpiaRef: '', lawfulBasis: 'Contract', personalDataCategories: ['Learning progress'], controls: [ctl('PRV-1', 'Pseudonymous actor in statements', 'in-place')] });
    s = withSection(s, 'responsibleAi', { usesAi: false, riskTier: 'none', humanOversight: '', controls: [] });
    s = withSection(s, 'safeguarding', { applies: true, considerations: ['Under-18 learners may use shared devices'], controls: [ctl('SG-1', 'Local content lock with PIN', 'planned')] });
    s = withSection(s, 'engineeringPlan', { approach: 'Two squads, three increments; SDK integration first.', milestones: [{ id: 'M1', name: 'Download & read', due: '2026-11-15', deliverables: ['J1', 'J3'] }], teams: ['Mobile', 'Learning Platforms'], dependencies: ['Content Sync SDK v3'] });
    s = withSection(s, 'qaStrategy', { approach: 'Risk-based; device lab for offline.', testLevels: ['Unit', 'Integration', 'E2E'], environments: ['Test', 'Pre-prod throttled'], exitCriteria: ['No open Must defects'] });
    s = withSection(s, 'devOpsStrategy', { pipeline: 'Trunk-based, mobile CI with device farm.', environments: ['Dev', 'Test', 'Prod'], checklist: [{ id: 'C1', text: 'Feature flag offline_reader', done: true }] });
    s = withSection(s, 'operationalReadiness', { runbookRef: 'RUN-OFFLINE-01', sloTargets: ['Sync success 99%'], alerting: 'Outbox depth alert', checklist: [] });
    return s;
  } });
  const offlineReview: Review = { id: uid('rev'), specId: offline.spec.id, version: '1.4', kind: 'ai-review', status: 'complete', requestedBy: USERS.jane, requestedAt: daysAgo(1), completedAt: daysAgo(1), agentVersion: 'sdd-companion/2.3', correlationId: uid('corr'), reviewers: [{ user: USERS.meera, verdict: 'pending' }, { user: USERS.amir, verdict: 'approve', comment: 'Architecture is sound.' }], findings: [] };
  const f = (category: Finding['category'], severity: Finding['severity'], sectionKey: Finding['sectionKey'], title: string, rationale: string, status: Finding['status'] = 'open', suggestion?: string): Finding => ({ id: uid('f'), reviewId: offlineReview.id, category, severity, sectionKey, title, rationale, suggestion, status });
  offlineReview.findings = [
    f('warning', 'blocker', 'privacy', 'No DPIA reference for offline cache of learner progress', 'Personal data cached on personal devices requires a DPIA before certification.', 'open', 'Link the DPIA or record the screening decision.'),
    f('risk', 'high', 'dataDesign', 'Sync conflict strategy undefined', 'Two devices editing offline will diverge.', 'accepted', 'Specify last-writer-wins with server reconciliation.'),
    f('open-question', 'medium', 'userJourneys', 'Persona P2 has no journey', 'Every persona should map to at least one journey.', 'resolved'),
    f('warning', 'medium', 'nfrs', 'Offline journey vs. NFR availability', 'NFR-2 assumes always-online; J3 is offline.'),
    f('suggested-change', 'medium', 'qaStrategy', 'Add offline test environment', 'QA environments lack a network-degraded profile.', 'open', 'Add a throttled/offline device lab profile.'),
    f('risk', 'low', 'security', 'Threat model not yet linked', 'Security section references controls but no threat model.'),
  ];
  st.reviews.set(offline.spec.id, [offlineReview]);
  offline.approvals[0] = { ...offline.approvals[0], status: 'approved', approver: USERS.meera, decidedAt: daysAgo(3), comment: 'Outbox pattern accepted.', evidence: [{ id: uid('ev'), kind: 'link', label: 'ADR-001', uri: 'https://example.pearson.com/adr/001', addedBy: USERS.meera, addedAt: daysAgo(3) }] };
  offline.approvals[2] = { ...offline.approvals[2], status: 'approved', approver: USERS.rosa, decidedAt: daysAgo(2), evidence: [{ id: uid('ev'), kind: 'link', label: 'Threat model TM-118', uri: 'https://example.pearson.com/tm/118', addedBy: USERS.rosa, addedAt: daysAgo(2) }] };
  offline.approvals[3] = { ...offline.approvals[3], status: 'approved', approver: USERS.pat, decidedAt: daysAgo(4), evidence: [] };

  // 2. Adaptive Marking Engine — Draft, AI heavy
  mk({ area: 'Assessment', title: 'Adaptive Marking Engine', owner: USERS.amir, contributors: [USERS.jane], stage: 'Draft', version: '3.2', tags: ['ai', 'marking'], updated: daysAgo(0, 0.2), fill: (s) => {
    s = withSection(s, 'productIntent', { problem: 'Manual marking of extended responses is slow and inconsistent.', outcome: 'AI-assisted first-pass marks with examiner confirmation, halving turnaround.', successMetrics: ['Turnaround −50%', 'Examiner agreement ≥ 0.85 kappa'], constraints: ['Examiner always confirms', 'No autonomous grade release'] });
    s = withSection(s, 'personas', { personas: [{ id: 'P1', name: 'Examiner Eve', role: 'Senior examiner', goals: ['Mark faster without losing judgement'], frustrations: ['Repetitive scripts'] }] });
    s = withSection(s, 'responsibleAi', { usesAi: true, riskTier: 'high', humanOversight: 'Every AI mark is confirmed or overridden by a qualified examiner before release.', controls: [ctl('RAI-1', 'Bias evaluation per cohort each series', 'planned', 'Assessment Research')] });
    s = withSection(s, 'architecture', { overview: 'Marking service calls LLM Hub; examiner UI; audit store.', components: ['Marking API', 'LLM Hub', 'Examiner UI'], diagramMermaid: '', patterns: [] });
    s = withSection(s, 'nfrs', { nfrs: [{ id: 'NFR-1', category: 'Throughput', text: 'Scripts per hour', target: '10,000' }] });
    return s;
  } });
  const asm = [...st.specs.values()].find((x) => x.productArea === 'Assessment')!;
  const asmRev: Review = { id: uid('rev'), specId: asm.id, version: '3.2', kind: 'architecture', status: 'complete', requestedBy: USERS.amir, requestedAt: daysAgo(2), completedAt: daysAgo(2), agentVersion: 'sdd-companion/2.3', correlationId: uid('corr'), findings: [] };
  asmRev.findings = [{ id: uid('f'), reviewId: asmRev.id, category: 'risk', severity: 'blocker', sectionKey: 'architecture', title: 'Unbounded queue between Marking API and LLM Hub', rationale: 'No back-pressure; a series peak would exhaust memory.', suggestion: 'Bounded queue with shed-load and DLQ.', status: 'open' }];
  st.reviews.set(asm.id, [asmRev]);

  // 3. Identity Broker — Certified
  const idb = mk({ area: 'Platform', title: 'Identity Broker', owner: USERS.meera, contributors: [USERS.rosa], stage: 'Certified', version: '2.0', tags: ['platform', 'identity'], updated: daysAgo(6), fill: (s) => {
    for (const key of Object.keys(s) as (keyof Sections)[]) {
      const empty = s[key].content as Record<string, unknown>;
      for (const [k, v] of Object.entries(empty)) { if (typeof v === 'string') empty[k] = `${k} for Identity Broker (certified).`; }
    }
    s = withSection(s, 'productIntent', { problem: 'Each product integrates identity separately.', outcome: 'One broker for learner and educator SSO.', successMetrics: ['All new products use broker'], constraints: [] });
    s = withSection(s, 'personas', { personas: [{ id: 'P1', name: 'Product engineer', role: 'Engineer', goals: ['Add SSO in a day'], frustrations: ['Bespoke OIDC each time'] }] });
    s = withSection(s, 'userJourneys', { journeys: [{ id: 'J1', name: 'Integrate SSO', persona: 'P1', steps: ['Register client', 'Configure redirect', 'Test'], outcome: 'SSO live' }] });
    s = withSection(s, 'uxRequirements', { requirements: [req('UXR-1', 'Consistent sign-in screen')], notes: 'n/a' });
    s = withSection(s, 'accessibilityRequirements', { standard: 'WCAG 2.2 AA', assistiveTech: ['Screen reader'], requirements: [req('A11Y-1', 'Sign-in keyboard operable')], notes: 'n/a' });
    s = withSection(s, 'architecture', { overview: 'Keycloak federated to Entra.', components: ['Keycloak', 'Entra'], diagramMermaid: '', patterns: ['Federation'] });
    s = withSection(s, 'adrs', { adrs: [{ id: 'ADR-1', title: 'Keycloak', status: 'Accepted', context: '', decision: 'Use Keycloak', consequences: '' }] });
    s = withSection(s, 'nfrs', { nfrs: [{ id: 'NFR-1', category: 'Availability', text: 'Broker', target: '99.95%' }] });
    s = withSection(s, 'integrationDesign', { integrations: [{ id: 'INT-1', system: 'Entra ID', direction: 'bidirectional', protocol: 'OIDC' }], notes: 'n/a' });
    s = withSection(s, 'dataDesign', { entities: [{ name: 'Session', description: 'Session', fields: ['sub', 'exp'], classification: 'confidential' }], retention: '30 days', notes: 'n/a' });
    s = withSection(s, 'security', { threatModelRef: 'TM-042', controls: [ctl('SEC-1', 'PKCE enforced', 'in-place')] });
    s = withSection(s, 'privacy', { dpiaRef: 'DPIA-2026-007', lawfulBasis: 'Contract', personalDataCategories: ['Identity'], controls: [ctl('PRV-1', 'Minimal claims', 'in-place')] });
    s = withSection(s, 'responsibleAi', { usesAi: false, riskTier: 'none', humanOversight: '', controls: [] });
    s = withSection(s, 'safeguarding', { applies: false, considerations: [], controls: [] });
    s = withSection(s, 'engineeringPlan', { approach: 'Platform squad.', milestones: [{ id: 'M1', name: 'GA', due: '2026-10-01', deliverables: ['Broker'] }], teams: ['Platform'], dependencies: [] });
    s = withSection(s, 'qaStrategy', { approach: 'Contract tests.', testLevels: ['Unit', 'Contract'], environments: ['Test'], exitCriteria: ['All contract tests pass'] });
    s = withSection(s, 'devOpsStrategy', { pipeline: 'GitOps.', environments: ['Dev', 'Prod'], checklist: [{ id: 'C1', text: 'Rollback tested', done: true }] });
    s = withSection(s, 'operationalReadiness', { runbookRef: 'RUN-IDB-01', sloTargets: ['99.95%'], alerting: 'PagerDuty', checklist: [{ id: 'C1', text: 'On-call rota', done: true }] });
    return s;
  } });
  for (const a of idb.approvals) Object.assign(a, { status: 'approved', approver: a.type === 'architecture' ? USERS.rosa : USERS.pat, decidedAt: daysAgo(7) });

  // 4–6. Additional catalogue depth
  mk({ area: 'Higher Education', title: 'Course Planner Redesign', owner: USERS.pat, contributors: [], stage: 'Draft', version: '0.3', tags: ['web'], updated: daysAgo(2), fill: (s) => withSection(s, 'productIntent', { problem: 'Planner is hard to use on mobile.', outcome: 'Responsive planner.', successMetrics: [], constraints: [] }) });
  mk({ area: 'Learning', title: 'Learning Object Repository & Broker', owner: USERS.rosa, contributors: [USERS.meera], stage: 'In Delivery', version: '4.0', tags: ['platform', 'xapi'], updated: daysAgo(3), fill: (s) => { s = withSection(s, 'productIntent', { problem: 'Reusable learning objects launch inconsistently.', outcome: 'One broker for launch and evidence.', successMetrics: ['All launches brokered'], constraints: [] }); return s; } });
  const lorb = [...st.specs.values()].find((x) => x.title.startsWith('Learning Object'))!;
  st.packs.set(`${lorb.id}@4.0`, { id: uid('pack'), specId: lorb.id, version: '4.0', generatedAt: daysAgo(3), generatedBy: USERS.rosa, items: [{ id: 'E-1', type: 'epic', key: 'E-1', title: 'Brokered launch', body: 'Launch descriptors', tracesTo: ['productIntent'] }] });
  mk({ area: 'Assessment', title: 'Item Bank Search', owner: USERS.jane, contributors: [], stage: 'Released', version: '1.0', tags: ['search'], updated: daysAgo(20), fill: (s) => s });
  mk({ area: 'Platform', title: 'Legacy Gradebook Export', owner: USERS.pat, contributors: [], stage: 'Retired', version: '2.1', tags: ['legacy'], updated: daysAgo(90), fill: (s) => s });
  return repo;
}

