import { stringify } from 'yaml';
import { SECTION_DEFINITIONS, SECTION_GROUPS, SECTION_KEYS, sectionsForGroup } from './sections';
import type { Approval, Finding, Sections, Specification, SectionKey } from './types';

/**
 * Deterministic rendering of the structured model into the two persisted artefacts.
 * See ADR-0003. Both renderers are pure and must not depend on the UI.
 */

export interface RenderInput {
  spec: Specification;
  version: string;
  sections: Sections;
  approvals?: Approval[];
  findings?: Finding[];
}

export function renderManifestYaml(input: RenderInput): string {
  const { spec, version, sections, approvals = [], findings = [] } = input;
  const approvalStatus = (t: Approval['type']) => approvals.find((a) => a.type === t)?.status ?? 'pending';
  const open = findings.filter((f) => f.status === 'open');
  const manifest = {
    sddw: 1,
    spec: {
      id: spec.id,
      title: spec.title,
      productArea: spec.productArea,
      version,
      status: spec.status,
      lifecycleStage: spec.lifecycleStage,
      owner: spec.owner.email,
      contributors: spec.contributors.map((c) => c.email),
      tags: spec.tags,
      dataClassification: spec.dataClassification,
      completion: spec.completion,
    },
    sections: Object.fromEntries(
      SECTION_KEYS.map((k) => [k, {
        group: sections[k].group,
        completion: sections[k].completion,
        source: sections[k].source,
        ...(sections[k].lastEditedAt ? { updatedAt: sections[k].lastEditedAt } : {}),
        ...sectionCounts(k, sections),
      }]),
    ),
    certification: {
      architecture: approvalStatus('architecture'),
      privacy: approvalStatus('privacy'),
      security: approvalStatus('security'),
      product: approvalStatus('product'),
    },
    review: {
      openFindings: open.length,
      blockers: open.filter((f) => f.severity === 'blocker').length,
    },
  };
  return stringify(manifest, { lineWidth: 0 });
}

function sectionCounts(k: SectionKey, s: Sections): Record<string, number> {
  const c = s[k].content as Record<string, unknown>;
  const counts: Record<string, number> = {};
  for (const [field, value] of Object.entries(c)) {
    if (Array.isArray(value)) counts[`${field}Count`] = value.length;
  }
  return counts;
}

// ---- Markdown ----------------------------------------------------------------

const h = (level: number, text: string) => `${'#'.repeat(level)} ${text}`;
const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '_None recorded._');
const table = (headers: string[], rows: string[][]) =>
  rows.length
    ? [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n')
    : '_None recorded._';
const esc = (s: string) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const para = (s: string) => (s && s.trim() ? s.trim() : '_Not yet written._');

export function renderMarkdown(input: RenderInput): string {
  const { spec, version, sections } = input;
  const out: string[] = [];
  out.push(h(1, `${spec.id} — ${spec.title}`));
  out.push('');
  out.push(table(['Field', 'Value'], [
    ['Spec ID', spec.id], ['Version', version], ['Product Area', spec.productArea], ['Status', spec.status],
    ['Lifecycle Stage', spec.lifecycleStage], ['Owner', spec.owner.displayName],
    ['Contributors', spec.contributors.map((c) => c.displayName).join(', ') || '—'], ['Tags', spec.tags.join(', ') || '—'],
    ['Completion', `${spec.completion}%`],
  ]));
  out.push('');
  for (const group of SECTION_GROUPS) {
    out.push(h(2, group));
    for (const key of sectionsForGroup(group)) {
      const def = SECTION_DEFINITIONS[key];
      out.push('', h(3, `${def.label} (${sections[key].completion})`), '');
      out.push(renderSection(key, sections));
    }
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function renderSection(key: SectionKey, s: Sections): string {
  switch (key) {
    case 'productIntent': { const c = s.productIntent.content; return [h(4, 'Problem'), para(c.problem), '', h(4, 'Outcome'), para(c.outcome), '', h(4, 'Success metrics'), list(c.successMetrics), '', h(4, 'Constraints'), list(c.constraints)].join('\n'); }
    case 'personas': return table(['ID', 'Name', 'Role', 'Goals', 'Frustrations'], s.personas.content.personas.map((p) => [p.id, p.name, p.role, p.goals.join('; '), p.frustrations.join('; ')]));
    case 'userJourneys': return s.userJourneys.content.journeys.map((j) => [h(4, `${j.id} ${j.name} (${j.persona})`), j.steps.map((st, i) => `${i + 1}. ${st}`).join('\n'), `**Outcome:** ${j.outcome}`].join('\n')).join('\n\n') || '_None recorded._';
    case 'uxRequirements': { const c = s.uxRequirements.content; return [table(['ID', 'Requirement', 'Priority'], c.requirements.map((r) => [r.id, r.text, r.priority])), '', para(c.notes)].join('\n'); }
    case 'accessibilityRequirements': { const c = s.accessibilityRequirements.content; return [`**Standard:** ${c.standard}`, `**Assistive technology:** ${c.assistiveTech.join(', ') || '—'}`, '', table(['ID', 'Requirement', 'Priority'], c.requirements.map((r) => [r.id, r.text, r.priority])), '', para(c.notes)].join('\n'); }
    case 'architecture': { const c = s.architecture.content; return [para(c.overview), '', h(4, 'Components'), list(c.components), '', h(4, 'Patterns'), list(c.patterns), '', c.diagramMermaid ? '```mermaid\n' + c.diagramMermaid + '\n```' : ''].join('\n'); }
    case 'adrs': return s.adrs.content.adrs.map((a) => [h(4, `${a.id} ${a.title} — ${a.status}`), `**Context.** ${a.context}`, `**Decision.** ${a.decision}`, `**Consequences.** ${a.consequences}`].join('\n\n')).join('\n\n') || '_None recorded._';
    case 'nfrs': return table(['ID', 'Category', 'Requirement', 'Target'], s.nfrs.content.nfrs.map((n) => [n.id, n.category, n.text, n.target ?? '']));
    case 'integrationDesign': { const c = s.integrationDesign.content; return [table(['ID', 'System', 'Direction', 'Protocol', 'Notes'], c.integrations.map((i) => [i.id, i.system, i.direction, i.protocol, i.notes ?? ''])), '', para(c.notes)].join('\n'); }
    case 'dataDesign': { const c = s.dataDesign.content; return [table(['Entity', 'Description', 'Fields', 'Classification'], c.entities.map((e) => [e.name, e.description, e.fields.join(', '), e.classification])), '', `**Retention:** ${c.retention || '—'}`, '', para(c.notes)].join('\n'); }
    case 'security': { const c = s.security.content; return [`**Threat model:** ${c.threatModelRef || '—'}`, '', controls(c.controls)].join('\n'); }
    case 'privacy': { const c = s.privacy.content; return [`**DPIA:** ${c.dpiaRef || '—'}`, `**Lawful basis:** ${c.lawfulBasis || '—'}`, `**Personal data categories:** ${c.personalDataCategories.join(', ') || '—'}`, '', controls(c.controls)].join('\n'); }
    case 'responsibleAi': { const c = s.responsibleAi.content; return c.usesAi ? [`**Risk tier:** ${c.riskTier}`, `**Human oversight:** ${para(c.humanOversight)}`, '', controls(c.controls)].join('\n') : '_This product does not use AI._'; }
    case 'safeguarding': { const c = s.safeguarding.content; return c.applies ? [h(4, 'Considerations'), list(c.considerations), '', controls(c.controls)].join('\n') : '_Safeguarding assessed as not applicable._'; }
    case 'engineeringPlan': { const c = s.engineeringPlan.content; return [para(c.approach), '', table(['ID', 'Milestone', 'Due', 'Deliverables'], c.milestones.map((m) => [m.id, m.name, m.due ?? '', m.deliverables.join('; ')])), '', `**Teams:** ${c.teams.join(', ') || '—'}`, `**Dependencies:** ${c.dependencies.join(', ') || '—'}`].join('\n'); }
    case 'qaStrategy': { const c = s.qaStrategy.content; return [para(c.approach), '', h(4, 'Test levels'), list(c.testLevels), '', h(4, 'Environments'), list(c.environments), '', h(4, 'Exit criteria'), list(c.exitCriteria)].join('\n'); }
    case 'devOpsStrategy': { const c = s.devOpsStrategy.content; return [para(c.pipeline), '', h(4, 'Environments'), list(c.environments), '', checklist(c.checklist)].join('\n'); }
    case 'operationalReadiness': { const c = s.operationalReadiness.content; return [`**Runbook:** ${c.runbookRef || '—'}`, '', h(4, 'SLO targets'), list(c.sloTargets), '', h(4, 'Alerting'), para(c.alerting), '', checklist(c.checklist)].join('\n'); }
  }
}

const controls = (cs: { id: string; text: string; owner?: string; status: string }[]) => table(['ID', 'Control', 'Owner', 'Status'], cs.map((c) => [c.id, c.text, c.owner ?? '', c.status]));
const checklist = (items: { text: string; done: boolean }[]) => (items.length ? items.map((i) => `- [${i.done ? 'x' : ' '}] ${i.text}`).join('\n') : '_No checklist items._');
