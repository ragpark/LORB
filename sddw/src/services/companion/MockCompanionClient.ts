import { uid } from '@/domain/ids';
import { SECTION_DEFINITIONS } from '@/domain/sections';
import type { DeliveryItem, Finding, SectionContent, SectionKey } from '@/domain/types';
import type { CompanionClient, CompanionResult, RunAccepted, RunRequest, RunStatus } from './types';

/**
 * Deterministic stand-in for the SDD Companion gateway so the UI is fully demonstrable offline.
 * Simulates queued → running → complete over ~3 seconds.
 */
export class MockCompanionClient implements CompanionClient {
  private runs = new Map<string, { req: RunRequest; startedAt: number; cancelled: boolean }>();
  constructor(private readonly latencyMs = 2500) {}

  async start(req: RunRequest): Promise<RunAccepted> {
    const runId = uid('run');
    this.runs.set(runId, { req, startedAt: Date.now(), cancelled: false });
    return { runId, status: 'queued', estimatedSeconds: Math.ceil(this.latencyMs / 1000) };
  }
  async poll(runId: string): Promise<RunStatus> {
    const run = this.runs.get(runId);
    if (!run) throw new Error('Unknown run');
    const base = { runId, agentVersion: 'sdd-companion-mock/1.0', correlationId: run.req.correlationId };
    if (run.cancelled) return { ...base, status: 'cancelled' };
    const elapsed = Date.now() - run.startedAt;
    if (elapsed < this.latencyMs * 0.2) return { ...base, status: 'queued', progress: 0 };
    if (elapsed < this.latencyMs) return { ...base, status: 'running', progress: elapsed / this.latencyMs };
    return { ...base, status: 'complete', progress: 1, result: fixture(run.req) };
  }
  async cancel(runId: string) { const r = this.runs.get(runId); if (r) r.cancelled = true; }
}

const finding = (reviewId: string, sectionKey: SectionKey, category: Finding['category'], severity: Finding['severity'], title: string, rationale: string, suggestion?: string): Finding =>
  ({ id: uid('f'), reviewId, category, severity, sectionKey, title, rationale, suggestion, status: 'open' });

function fixture(req: RunRequest): CompanionResult {
  const rid = uid('rev');
  switch (req.action) {
    case 'generate-section': return { kind: 'section-proposal', sectionKey: req.sectionKey!, confidence: 'medium', rationale: `Drafted from Product Intent, Personas and User Journeys${req.guidance ? ` with guidance “${req.guidance}”` : ''}.`, proposal: proposalFor(req.sectionKey!) };
    case 'critique-section': return { kind: 'findings', findings: [
      finding(rid, req.sectionKey!, 'suggested-change', 'medium', `${SECTION_DEFINITIONS[req.sectionKey!].label}: make acceptance measurable`, 'Two statements use “fast” and “easy” without a target.', 'Replace with p95 latency and task-completion targets.'),
      finding(rid, req.sectionKey!, 'open-question', 'low', 'Which persona is primary for this section?', 'The section addresses all personas equally; prioritisation would sharpen trade-offs.'),
    ] };
    case 'contradictions': return { kind: 'findings', findings: [
      finding(rid, 'dataDesign', 'risk', 'high', 'Retention contradicts Privacy section', 'Data Design retains progress for 7 years; Privacy states 2 years after last activity.', 'Align to the Privacy statement or record a justified exception.'),
      finding(rid, 'nfrs', 'warning', 'medium', 'Offline journey vs. NFR availability', 'NFR-2 assumes always-online 99.9%; Journey J3 is explicitly offline.'),
    ] };
    case 'constitution-review': return { kind: 'findings', findings: [
      finding(rid, 'security', 'warning', 'blocker', 'Constitution §4.2: threat model reference missing', 'Every specification entering Certified must reference a completed threat model.', 'Add the threat model link to the Security section.'),
      finding(rid, 'accessibilityRequirements', 'warning', 'medium', 'Constitution §2.1: assistive technologies list incomplete', 'Voice control is required for learner-facing products.'),
    ] };
    case 'reuse-review': return { kind: 'reuse', candidates: [
      { name: 'Pearson Identity Broker', kind: 'platform', owner: 'Platform Engineering', fit: 'high', rationale: 'Covers learner SSO and consent without new build.' },
      { name: 'Content Sync SDK', kind: 'component', owner: 'Learning Platforms', fit: 'medium', rationale: 'Offline download and delta sync; lacks conflict resolution.' },
      { name: 'Event Outbox pattern', kind: 'pattern', owner: 'Architecture Guild', fit: 'high', rationale: 'Matches the evidence delivery requirement.' },
    ], findings: [finding(rid, 'architecture', 'suggested-change', 'medium', 'Adopt Content Sync SDK instead of bespoke sync', 'Reduces delivery scope by an estimated two sprints.')] };
    case 'architecture-review': return { kind: 'findings', findings: [
      finding(rid, 'architecture', 'risk', 'high', 'Single write path for progress events', 'No back-pressure or dead-letter handling described.', 'Introduce an outbox with retry and DLQ.'),
      finding(rid, 'integrationDesign', 'open-question', 'medium', 'Which LRS instance receives statements?', 'Integration lists “LRS” without environment mapping.'),
    ] };
    case 'privacy-review': return { kind: 'findings', findings: [
      finding(rid, 'privacy', 'warning', 'blocker', 'No DPIA reference', 'Offline caching of learner progress on personal devices requires a DPIA.', 'Link the DPIA or record the screening decision.'),
      finding(rid, 'privacy', 'suggested-change', 'low', 'Name the data controller', 'Lawful basis is stated but the controller/processor split is not.'),
    ] };
    case 'review': return { kind: 'findings', findings: [
      finding(rid, 'privacy', 'warning', 'blocker', 'No DPIA reference', 'Offline caching of learner progress requires a DPIA.', 'Link the DPIA.'),
      finding(rid, 'dataDesign', 'risk', 'high', 'Sync conflict strategy undefined', 'Two devices editing offline will diverge.', 'Specify last-writer-wins with server reconciliation, or CRDT.'),
      finding(rid, 'userJourneys', 'open-question', 'medium', 'Persona P2 has no journey', 'Every persona should map to at least one journey.'),
      finding(rid, 'qaStrategy', 'suggested-change', 'medium', 'Add offline test environment', 'QA environments do not include a network-degraded profile.', 'Add a throttled/offline device lab profile.'),
    ] };
    case 'generate-adrs': return { kind: 'adrs', adrs: [
      { id: 'ADR-001', title: 'Use Content Sync SDK for offline download', status: 'Proposed', context: 'Journeys require offline access; a reusable SDK exists.', decision: 'Adopt the SDK and extend it with conflict resolution.', consequences: 'Dependency on Learning Platforms roadmap; faster delivery.' },
      { id: 'ADR-002', title: 'Event outbox for progress statements', status: 'Proposed', context: 'Evidence must never be lost when the LRS is unavailable.', decision: 'Persist statements locally in an outbox with retry and dead-lettering.', consequences: 'Eventual consistency; additional storage on device.' },
    ] };
    case 'generate-delivery-pack': return { kind: 'delivery-pack', items: deliveryPackFixture() };
  }
}

function proposalFor(key: SectionKey): SectionContent {
  switch (key) {
    case 'accessibilityRequirements': return { standard: 'WCAG 2.2 AA', assistiveTech: ['Screen reader', 'Switch access', 'Voice control'], notes: 'Offline state changes must be announced non-visually.', requirements: [
      { id: 'A11Y-1', text: 'All controls operable by keyboard with visible focus order.', priority: 'Must' },
      { id: 'A11Y-2', text: 'Offline/online transitions announced via aria-live region.', priority: 'Must' },
      { id: 'A11Y-3', text: 'Reading view supports 200% zoom without horizontal scroll.', priority: 'Must' },
    ] } satisfies import('@/domain/types').SectionContentMap['accessibilityRequirements'];
    case 'nfrs': return { nfrs: [
      { id: 'NFR-1', category: 'Performance', text: 'Open a downloaded chapter', target: '< 1 s p95 on mid-range Android' },
      { id: 'NFR-2', category: 'Availability', text: 'Online services availability', target: '99.5% business hours' },
      { id: 'NFR-3', category: 'Security', text: 'Cached content encrypted at rest', target: 'AES-256, OS keystore' },
    ] } satisfies import('@/domain/types').SectionContentMap['nfrs'];
    case 'qaStrategy': return { approach: 'Risk-based testing led by the offline journeys; automated regression on every merge; exploratory sessions per milestone.', testLevels: ['Unit', 'Contract', 'Integration', 'E2E (device lab)', 'Accessibility'], environments: ['Dev', 'Test', 'Pre-prod (throttled network)'], exitCriteria: ['No open Must defects', 'A11y automated pass', '95% story coverage'] } satisfies import('@/domain/types').SectionContentMap['qaStrategy'];
    default: {
      const empty = SECTION_DEFINITIONS[key].empty() as Record<string, unknown>;
      for (const [k, v] of Object.entries(empty)) { if (typeof v === 'string') empty[k] = `Proposed ${k} for ${SECTION_DEFINITIONS[key].label}, derived from the product intent and journeys.`; }
      return empty as never;
    }
  }
}

function deliveryPackFixture(): DeliveryItem[] {
  const e1 = 'E-1', s1 = 'S-01', s2 = 'S-02';
  return [
    { id: e1, type: 'epic', key: 'E-1', title: 'Offline reading', body: 'Learners can download and read chapters without connectivity.', tracesTo: ['userJourneys', 'productIntent'] },
    { id: 'E-2', type: 'epic', key: 'E-2', title: 'Progress evidence', body: 'Progress is captured offline and delivered reliably.', tracesTo: ['dataDesign', 'integrationDesign'] },
    { id: s1, type: 'story', key: 'S-01', title: 'Download a chapter', body: 'As a commuter I can download a chapter for offline reading.', parentId: e1, tracesTo: ['J3', 'UXR-1'] },
    { id: s2, type: 'story', key: 'S-02', title: 'Open a downloaded chapter offline', body: 'As a commuter I can open a downloaded chapter with no network.', parentId: e1, tracesTo: ['J3', 'A11Y-2'] },
    { id: 'AC-01', type: 'acceptance-criterion', key: 'AC-01', title: 'Download completes with progress', body: 'Given a 20 MB chapter, when I tap download, then progress is shown and completion announced.', parentId: s1, tracesTo: ['A11Y-2'] },
    { id: 'AC-02', type: 'acceptance-criterion', key: 'AC-02', title: 'Opens under 1 s', body: 'Given a downloaded chapter, when offline, then it opens in under 1 s p95.', parentId: s2, tracesTo: ['NFR-1'] },
    { id: 'ADR-001', type: 'adr', key: 'ADR-001', title: 'Use Content Sync SDK', body: 'Adopt the SDK for download and delta sync.', tracesTo: ['architecture'] },
    { id: 'T-01', type: 'task', key: 'T-01', title: 'Integrate Content Sync SDK', body: 'Add SDK, configure storage quota, wire download UI.', parentId: s1, tracesTo: ['ADR-001'] },
    { id: 'T-02', type: 'task', key: 'T-02', title: 'Implement outbox for xAPI statements', body: 'Local queue, retry with back-off, dead-letter view.', parentId: 'E-2', tracesTo: ['ADR-002'] },
    { id: 'QA-01', type: 'qa-case', key: 'QA-01', title: 'Offline open — device lab', body: 'Airplane mode, open downloaded chapter, verify render and announcement.', parentId: s2, tracesTo: ['qaStrategy'] },
    { id: 'BDD-01', type: 'bdd-scenario', key: 'BDD-01', title: 'Open chapter offline', body: 'Given I have downloaded "Chapter 3"\nAnd my device is offline\nWhen I open "Chapter 3"\nThen the content renders within 1 second\nAnd the offline state is announced.', parentId: s2, tracesTo: ['AC-02'] },
    { id: 'DO-01', type: 'devops-check', key: 'DO-01', title: 'Feature flag for offline mode', body: 'Flag `offline_reader` per environment; kill switch documented in runbook.', tracesTo: ['devOpsStrategy', 'operationalReadiness'] },
    { id: 'DO-02', type: 'devops-check', key: 'DO-02', title: 'Outbox depth alert', body: 'Alert when device outbox median depth > 50 for 1 h.', tracesTo: ['operationalReadiness'] },
  ];
}
