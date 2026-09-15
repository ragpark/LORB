import type { Completion, Section, SectionContentMap, SectionGroup, SectionKey, Sections } from './types';

export interface SectionDefinition<K extends SectionKey = SectionKey> {
  key: K;
  group: SectionGroup;
  label: string;
  description: string;
  empty: () => SectionContentMap[K];
  /** Returns completion from content. Pure. */
  completion: (content: SectionContentMap[K]) => Completion;
}

const filled = (s: string | undefined) => !!s && s.trim().length > 0;
const some = (arr: unknown[] | undefined) => !!arr && arr.length > 0;
const grade = (required: boolean[], optional: boolean[] = []): Completion => {
  const req = required.filter(Boolean).length;
  if (req === 0 && optional.filter(Boolean).length === 0) return 'empty';
  return req === required.length ? 'complete' : 'partial';
};

function def<K extends SectionKey>(d: SectionDefinition<K>): SectionDefinition<K> { return d; }

export const SECTION_DEFINITIONS = {
  productIntent: def({
    key: 'productIntent', group: 'Product', label: 'Product Intent',
    description: 'The problem, the intended outcome, how success is measured and the constraints.',
    empty: () => ({ problem: '', outcome: '', successMetrics: [], constraints: [] }),
    completion: (c) => grade([filled(c.problem), filled(c.outcome), some(c.successMetrics)], [some(c.constraints)]),
  }),
  personas: def({
    key: 'personas', group: 'Product', label: 'Personas',
    description: 'Who the product serves, their goals and frustrations.',
    empty: () => ({ personas: [] }),
    completion: (c) => grade([some(c.personas), c.personas.every((p) => filled(p.name) && some(p.goals))]),
  }),
  userJourneys: def({
    key: 'userJourneys', group: 'Product', label: 'User Journeys',
    description: 'End-to-end journeys per persona with outcomes.',
    empty: () => ({ journeys: [] }),
    completion: (c) => grade([some(c.journeys), c.journeys.every((j) => some(j.steps) && filled(j.outcome))]),
  }),
  uxRequirements: def({
    key: 'uxRequirements', group: 'UX', label: 'UX Requirements',
    description: 'Interaction and content requirements with MoSCoW priority.',
    empty: () => ({ requirements: [], notes: '' }),
    completion: (c) => grade([some(c.requirements)], [filled(c.notes)]),
  }),
  accessibilityRequirements: def({
    key: 'accessibilityRequirements', group: 'UX', label: 'Accessibility Requirements',
    description: 'Target standard, assistive technologies and specific requirements.',
    empty: () => ({ standard: 'WCAG 2.2 AA', assistiveTech: [], requirements: [], notes: '' }),
    completion: (c) => grade([some(c.assistiveTech), some(c.requirements)], [filled(c.notes)]),
  }),
  architecture: def({
    key: 'architecture', group: 'Architecture', label: 'Architecture',
    description: 'Overview, components, diagram and patterns.',
    empty: () => ({ overview: '', components: [], diagramMermaid: '', patterns: [] }),
    completion: (c) => grade([filled(c.overview), some(c.components)], [filled(c.diagramMermaid), some(c.patterns)]),
  }),
  adrs: def({
    key: 'adrs', group: 'Architecture', label: 'ADRs',
    description: 'Architecture decision records.',
    empty: () => ({ adrs: [] }),
    completion: (c) => grade([some(c.adrs)]),
  }),
  nfrs: def({
    key: 'nfrs', group: 'Architecture', label: 'NFRs',
    description: 'Non-functional requirements with measurable targets.',
    empty: () => ({ nfrs: [] }),
    completion: (c) => grade([some(c.nfrs), c.nfrs.every((n) => filled(n.target))]),
  }),
  integrationDesign: def({
    key: 'integrationDesign', group: 'Architecture', label: 'Integration Design',
    description: 'Systems integrated with, direction and protocol.',
    empty: () => ({ integrations: [], notes: '' }),
    completion: (c) => grade([some(c.integrations)], [filled(c.notes)]),
  }),
  dataDesign: def({
    key: 'dataDesign', group: 'Data', label: 'Data Design',
    description: 'Entities, classification and retention.',
    empty: () => ({ entities: [], retention: '', notes: '' }),
    completion: (c) => grade([some(c.entities), filled(c.retention)], [filled(c.notes)]),
  }),
  security: def({
    key: 'security', group: 'Data', label: 'Security',
    description: 'Threat model reference and controls.',
    empty: () => ({ threatModelRef: '', controls: [] }),
    completion: (c) => grade([filled(c.threatModelRef), some(c.controls)]),
  }),
  privacy: def({
    key: 'privacy', group: 'Data', label: 'Privacy',
    description: 'DPIA, lawful basis, personal data categories and controls.',
    empty: () => ({ dpiaRef: '', lawfulBasis: '', personalDataCategories: [], controls: [] }),
    completion: (c) => grade([filled(c.dpiaRef), filled(c.lawfulBasis)], [some(c.personalDataCategories), some(c.controls)]),
  }),
  responsibleAi: def({
    key: 'responsibleAi', group: 'Data', label: 'Responsible AI',
    description: 'AI usage, risk tier, human oversight and controls.',
    empty: () => ({ usesAi: false, riskTier: 'none', humanOversight: '', controls: [] }),
    completion: (c) => (c.usesAi ? grade([filled(c.humanOversight), some(c.controls)]) : grade([true])),
  }),
  safeguarding: def({
    key: 'safeguarding', group: 'Data', label: 'Safeguarding',
    description: 'Learner safeguarding considerations and controls.',
    empty: () => ({ applies: false, considerations: [], controls: [] }),
    completion: (c) => (c.applies ? grade([some(c.considerations), some(c.controls)]) : grade([true])),
  }),
  engineeringPlan: def({
    key: 'engineeringPlan', group: 'Engineering', label: 'Engineering Plan',
    description: 'Approach, milestones, teams and dependencies.',
    empty: () => ({ approach: '', milestones: [], teams: [], dependencies: [] }),
    completion: (c) => grade([filled(c.approach), some(c.milestones)], [some(c.teams), some(c.dependencies)]),
  }),
  qaStrategy: def({
    key: 'qaStrategy', group: 'QA', label: 'QA Strategy',
    description: 'Test approach, levels, environments and exit criteria.',
    empty: () => ({ approach: '', testLevels: [], environments: [], exitCriteria: [] }),
    completion: (c) => grade([filled(c.approach), some(c.testLevels), some(c.exitCriteria)], [some(c.environments)]),
  }),
  devOpsStrategy: def({
    key: 'devOpsStrategy', group: 'Operations', label: 'DevOps Strategy',
    description: 'Pipeline, environments and DevOps checklist.',
    empty: () => ({ pipeline: '', environments: [], checklist: [] }),
    completion: (c) => grade([filled(c.pipeline), some(c.environments)], [some(c.checklist)]),
  }),
  operationalReadiness: def({
    key: 'operationalReadiness', group: 'Operations', label: 'Operational Readiness',
    description: 'Runbook, SLOs, alerting and go-live checklist.',
    empty: () => ({ runbookRef: '', sloTargets: [], alerting: '', checklist: [] }),
    completion: (c) => grade([filled(c.runbookRef), some(c.sloTargets)], [filled(c.alerting), some(c.checklist)]),
  }),
} as const satisfies { [K in SectionKey]: SectionDefinition<K> };

export const SECTION_KEYS = Object.keys(SECTION_DEFINITIONS) as SectionKey[];
export const SECTION_GROUPS: SectionGroup[] = ['Product', 'UX', 'Architecture', 'Data', 'Engineering', 'QA', 'Operations'];

export function sectionsForGroup(group: SectionGroup): SectionKey[] {
  return SECTION_KEYS.filter((k) => SECTION_DEFINITIONS[k].group === group);
}

export function emptySections(): Sections {
  const out = {} as Sections;
  for (const key of SECTION_KEYS) {
    (out as Record<SectionKey, Section>)[key] = {
      key,
      group: SECTION_DEFINITIONS[key].group,
      completion: 'empty',
      content: SECTION_DEFINITIONS[key].empty(),
      source: 'human',
    } as Section;
  }
  return out;
}

export function computeCompletion<K extends SectionKey>(key: K, content: SectionContentMap[K]): Completion {
  return (SECTION_DEFINITIONS[key] as unknown as SectionDefinition<K>).completion(content);
}

/** Overall completion 0–100: complete = 1, partial = 0.5, empty = 0 across all sections. */
export function overallCompletion(sections: Sections): number {
  const score = SECTION_KEYS.reduce((acc, k) => acc + (sections[k].completion === 'complete' ? 1 : sections[k].completion === 'partial' ? 0.5 : 0), 0);
  return Math.round((score / SECTION_KEYS.length) * 100);
}

export function groupCompletion(sections: Sections, group: SectionGroup): number {
  const keys = sectionsForGroup(group);
  const score = keys.reduce((acc, k) => acc + (sections[k].completion === 'complete' ? 1 : sections[k].completion === 'partial' ? 0.5 : 0), 0);
  return Math.round((score / keys.length) * 100);
}

/** Returns a new Sections with the given section replaced and completion recomputed. */
export function withSection<K extends SectionKey>(sections: Sections, key: K, content: SectionContentMap[K], meta: Partial<Pick<Section, 'lastEditedBy' | 'lastEditedAt' | 'source'>> = {}): Sections {
  const next: Section<K> = { ...sections[key], content, completion: computeCompletion(key, content), ...meta } as Section<K>;
  return { ...sections, [key]: next };
}
