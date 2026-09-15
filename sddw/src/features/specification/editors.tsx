/**
 * Structured editors — one per section type. Each receives the typed content and emits a new value.
 * No section is ever a single free-text document (FR-EDIT-3).
 */
import { Button, Field, Input, Select, Textarea } from '@/components/nebula';
import type { Adr, ChecklistItem, Control, Entity, Integration, Journey, Milestone, Nfr, Persona, Requirement, SectionContentMap, SectionKey } from '@/domain/types';

type P<K extends SectionKey> = { value: SectionContentMap[K]; onChange: (v: SectionContentMap[K]) => void; disabled?: boolean };

function StringList({ label, items, onChange, disabled, placeholder }: { label: string; items: string[]; onChange: (v: string[]) => void; disabled?: boolean; placeholder?: string }) {
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</legend>
      {items.map((it, i) => (
        <div key={i} className="flex gap-2"><Input value={it} onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))} placeholder={placeholder} aria-label={`${label} ${i + 1}`} /><Button size="sm" variant="ghost" aria-label={`Remove ${label} ${i + 1}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>✕</Button></div>
      ))}
      <Button size="sm" onClick={() => onChange([...items, ''])}>+ Add</Button>
    </fieldset>
  );
}

type Col<T> = { key: keyof T & string; label: string; kind?: 'text' | 'select' | 'list' | 'bool'; options?: readonly string[]; width?: string };
function RowTable<T extends object>({ label, rows, onChange, cols, blank, disabled }: { label: string; rows: T[]; onChange: (r: T[]) => void; cols: Col<T>[]; blank: () => T; disabled?: boolean }) {
  const upd = (i: number, k: keyof T, v: unknown) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <fieldset disabled={disabled}>
      <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</legend>
      <div className="overflow-x-auto rounded-nebula border border-surface-line">
        <table className="w-full text-sm"><thead className="bg-surface-alt text-xs uppercase text-ink-muted"><tr>{cols.map((c) => <th key={c.key} className="px-2 py-1.5 text-left font-semibold" style={{ width: c.width }}>{c.label}</th>)}<th className="w-10" /></tr></thead>
          <tbody className="divide-y divide-surface-line">
            {rows.map((r, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c.key} className="px-2 py-1 align-top">
                    {c.kind === 'select' ? <Select className="h-8 w-full text-xs" aria-label={c.label} value={String(r[c.key] ?? '')} onChange={(e) => upd(i, c.key, e.target.value)}>{c.options?.map((o) => <option key={o}>{o}</option>)}</Select>
                      : c.kind === 'list' ? <Input className="h-8 text-xs" aria-label={c.label} value={((r[c.key] as unknown as string[]) ?? []).join('; ')} onChange={(e) => upd(i, c.key, e.target.value.split(';').map((s) => s.trim()).filter(Boolean))} placeholder="a; b; c" />
                      : c.kind === 'bool' ? <input type="checkbox" aria-label={c.label} checked={!!r[c.key]} onChange={(e) => upd(i, c.key, e.target.checked)} />
                      : <Input className="h-8 text-xs" aria-label={c.label} value={String(r[c.key] ?? '')} onChange={(e) => upd(i, c.key, e.target.value)} />}
                  </td>
                ))}
                <td className="px-1 py-1"><Button size="sm" variant="ghost" aria-label={`Remove row ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>✕</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button size="sm" className="mt-2" onClick={() => onChange([...rows, blank()])}>+ Add row</Button>
    </fieldset>
  );
}

const nextId = (prefix: string, rows: unknown[]) => `${prefix}-${rows.length + 1}`;
const PRIORITIES = ['Must', 'Should', 'Could', 'Wont'] as const;
const CONTROL_STATUS = ['planned', 'in-place', 'n/a'] as const;
const CLASSES = ['public', 'internal', 'confidential', 'restricted'] as const;

const reqCols: Col<SectionContentMap['uxRequirements']['requirements'][number]>[] = [{ key: 'id', label: 'ID', width: '6rem' }, { key: 'text', label: 'Requirement' }, { key: 'priority', label: 'Priority', kind: 'select', options: PRIORITIES, width: '7rem' }];
const controlCols: Col<SectionContentMap['security']['controls'][number]>[] = [{ key: 'id', label: 'ID', width: '6rem' }, { key: 'text', label: 'Control' }, { key: 'owner', label: 'Owner', width: '10rem' }, { key: 'status', label: 'Status', kind: 'select', options: CONTROL_STATUS, width: '7rem' }];
const checkCols: Col<SectionContentMap['devOpsStrategy']['checklist'][number]>[] = [{ key: 'id', label: 'ID', width: '5rem' }, { key: 'text', label: 'Item' }, { key: 'done', label: 'Done', kind: 'bool', width: '4rem' }];

export function ProductIntentEditor({ value, onChange, disabled }: P<'productIntent'>) {
  return <div className="space-y-4">
    <Field label="Problem"><Textarea rows={3} disabled={disabled} value={value.problem} onChange={(e) => onChange({ ...value, problem: e.target.value })} /></Field>
    <Field label="Intended outcome"><Textarea rows={3} disabled={disabled} value={value.outcome} onChange={(e) => onChange({ ...value, outcome: e.target.value })} /></Field>
    <StringList label="Success metrics" items={value.successMetrics} onChange={(v) => onChange({ ...value, successMetrics: v })} disabled={disabled} />
    <StringList label="Constraints" items={value.constraints} onChange={(v) => onChange({ ...value, constraints: v })} disabled={disabled} />
  </div>;
}
export function PersonasEditor({ value, onChange, disabled }: P<'personas'>) {
  return <RowTable label="Personas" rows={value.personas} disabled={disabled} onChange={(personas) => onChange({ personas })} blank={(): Persona => ({ id: nextId('P', value.personas), name: '', role: '', goals: [], frustrations: [] })}
    cols={[{ key: 'id', label: 'ID', width: '5rem' }, { key: 'name', label: 'Name' }, { key: 'role', label: 'Role' }, { key: 'goals', label: 'Goals', kind: 'list' }, { key: 'frustrations', label: 'Frustrations', kind: 'list' }]} />;
}
export function UserJourneysEditor({ value, onChange, disabled }: P<'userJourneys'>) {
  return <RowTable label="Journeys" rows={value.journeys} disabled={disabled} onChange={(journeys) => onChange({ journeys })} blank={(): Journey => ({ id: nextId('J', value.journeys), name: '', persona: '', steps: [], outcome: '' })}
    cols={[{ key: 'id', label: 'ID', width: '5rem' }, { key: 'name', label: 'Journey' }, { key: 'persona', label: 'Persona', width: '6rem' }, { key: 'steps', label: 'Steps', kind: 'list' }, { key: 'outcome', label: 'Outcome' }]} />;
}
export function UxRequirementsEditor({ value, onChange, disabled }: P<'uxRequirements'>) {
  return <div className="space-y-4"><RowTable label="Requirements" rows={value.requirements} disabled={disabled} onChange={(requirements) => onChange({ ...value, requirements })} blank={(): Requirement => ({ id: nextId('UXR', value.requirements), text: '', priority: 'Must' })} cols={reqCols} />
    <Field label="Notes"><Textarea rows={3} disabled={disabled} value={value.notes} onChange={(e) => onChange({ ...value, notes: e.target.value })} /></Field></div>;
}
export function AccessibilityEditor({ value, onChange, disabled }: P<'accessibilityRequirements'>) {
  const AT = ['Screen reader', 'Switch access', 'Voice control', 'Magnification', 'Braille display'];
  return <div className="space-y-4">
    <Field label="Standard"><Select disabled={disabled} value={value.standard} onChange={(e) => onChange({ ...value, standard: e.target.value as typeof value.standard })}>{['WCAG 2.1 AA', 'WCAG 2.2 AA', 'WCAG 2.2 AAA'].map((s) => <option key={s}>{s}</option>)}</Select></Field>
    <fieldset disabled={disabled}><legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">Assistive technology supported</legend>
      <div className="flex flex-wrap gap-3">{AT.map((a) => <label key={a} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={value.assistiveTech.includes(a)} onChange={(e) => onChange({ ...value, assistiveTech: e.target.checked ? [...value.assistiveTech, a] : value.assistiveTech.filter((x) => x !== a) })} />{a}</label>)}</div></fieldset>
    <RowTable label="Requirements" rows={value.requirements} disabled={disabled} onChange={(requirements) => onChange({ ...value, requirements })} blank={(): Requirement => ({ id: nextId('A11Y', value.requirements), text: '', priority: 'Must' })} cols={reqCols} />
    <Field label="Notes"><Textarea rows={3} disabled={disabled} value={value.notes} onChange={(e) => onChange({ ...value, notes: e.target.value })} /></Field>
  </div>;
}
export function ArchitectureEditor({ value, onChange, disabled }: P<'architecture'>) {
  return <div className="space-y-4">
    <Field label="Overview"><Textarea rows={4} disabled={disabled} value={value.overview} onChange={(e) => onChange({ ...value, overview: e.target.value })} /></Field>
    <StringList label="Components" items={value.components} onChange={(v) => onChange({ ...value, components: v })} disabled={disabled} />
    <StringList label="Patterns" items={value.patterns} onChange={(v) => onChange({ ...value, patterns: v })} disabled={disabled} />
    <Field label="Diagram (Mermaid)" hint="Rendered in the Markdown export."><Textarea rows={5} disabled={disabled} className="font-mono text-xs" value={value.diagramMermaid} onChange={(e) => onChange({ ...value, diagramMermaid: e.target.value })} /></Field>
  </div>;
}
export function AdrsEditor({ value, onChange, disabled }: P<'adrs'>) {
  return <RowTable label="Architecture decision records" rows={value.adrs} disabled={disabled} onChange={(adrs) => onChange({ adrs })} blank={(): Adr => ({ id: nextId('ADR', value.adrs), title: '', status: 'Proposed', context: '', decision: '', consequences: '' })}
    cols={[{ key: 'id', label: 'ID', width: '6rem' }, { key: 'title', label: 'Title' }, { key: 'status', label: 'Status', kind: 'select', options: ['Proposed', 'Accepted', 'Superseded', 'Rejected'], width: '8rem' }, { key: 'context', label: 'Context' }, { key: 'decision', label: 'Decision' }, { key: 'consequences', label: 'Consequences' }]} />;
}
export function NfrsEditor({ value, onChange, disabled }: P<'nfrs'>) {
  return <RowTable label="Non-functional requirements" rows={value.nfrs} disabled={disabled} onChange={(nfrs) => onChange({ nfrs })} blank={(): Nfr => ({ id: nextId('NFR', value.nfrs), category: '', text: '', target: '' })}
    cols={[{ key: 'id', label: 'ID', width: '6rem' }, { key: 'category', label: 'Category', width: '9rem' }, { key: 'text', label: 'Requirement' }, { key: 'target', label: 'Measurable target' }]} />;
}
export function IntegrationEditor({ value, onChange, disabled }: P<'integrationDesign'>) {
  return <div className="space-y-4"><RowTable label="Integrations" rows={value.integrations} disabled={disabled} onChange={(integrations) => onChange({ ...value, integrations })} blank={(): Integration => ({ id: nextId('INT', value.integrations), system: '', direction: 'outbound', protocol: '', notes: '' })}
    cols={[{ key: 'id', label: 'ID', width: '6rem' }, { key: 'system', label: 'System' }, { key: 'direction', label: 'Direction', kind: 'select', options: ['inbound', 'outbound', 'bidirectional'], width: '9rem' }, { key: 'protocol', label: 'Protocol' }, { key: 'notes', label: 'Notes' }]} />
    <Field label="Notes"><Textarea rows={3} disabled={disabled} value={value.notes} onChange={(e) => onChange({ ...value, notes: e.target.value })} /></Field></div>;
}
export function DataDesignEditor({ value, onChange, disabled }: P<'dataDesign'>) {
  return <div className="space-y-4"><RowTable label="Entities" rows={value.entities} disabled={disabled} onChange={(entities) => onChange({ ...value, entities })} blank={(): Entity => ({ name: '', description: '', fields: [], classification: 'internal' })}
    cols={[{ key: 'name', label: 'Entity', width: '10rem' }, { key: 'description', label: 'Description' }, { key: 'fields', label: 'Fields', kind: 'list' }, { key: 'classification', label: 'Classification', kind: 'select', options: CLASSES, width: '8rem' }]} />
    <Field label="Retention"><Input disabled={disabled} value={value.retention} onChange={(e) => onChange({ ...value, retention: e.target.value })} /></Field>
    <Field label="Notes"><Textarea rows={3} disabled={disabled} value={value.notes} onChange={(e) => onChange({ ...value, notes: e.target.value })} /></Field></div>;
}
export function SecurityEditor({ value, onChange, disabled }: P<'security'>) {
  return <div className="space-y-4"><Field label="Threat model reference"><Input disabled={disabled} value={value.threatModelRef} onChange={(e) => onChange({ ...value, threatModelRef: e.target.value })} placeholder="TM-…" /></Field>
    <RowTable label="Controls" rows={value.controls} disabled={disabled} onChange={(controls) => onChange({ ...value, controls })} blank={(): Control => ({ id: nextId('SEC', value.controls), text: '', status: 'planned' })} cols={controlCols} /></div>;
}
export function PrivacyEditor({ value, onChange, disabled }: P<'privacy'>) {
  return <div className="space-y-4">
    <div className="grid gap-3 md:grid-cols-2"><Field label="DPIA reference"><Input disabled={disabled} value={value.dpiaRef} onChange={(e) => onChange({ ...value, dpiaRef: e.target.value })} /></Field><Field label="Lawful basis"><Input disabled={disabled} value={value.lawfulBasis} onChange={(e) => onChange({ ...value, lawfulBasis: e.target.value })} /></Field></div>
    <StringList label="Personal data categories" items={value.personalDataCategories} onChange={(v) => onChange({ ...value, personalDataCategories: v })} disabled={disabled} />
    <RowTable label="Controls" rows={value.controls} disabled={disabled} onChange={(controls) => onChange({ ...value, controls })} blank={(): Control => ({ id: nextId('PRV', value.controls), text: '', status: 'planned' })} cols={controlCols} /></div>;
}
export function ResponsibleAiEditor({ value, onChange, disabled }: P<'responsibleAi'>) {
  return <div className="space-y-4">
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={disabled} checked={value.usesAi} onChange={(e) => onChange({ ...value, usesAi: e.target.checked })} />This product uses AI</label>
    {value.usesAi && <>
      <Field label="Risk tier"><Select disabled={disabled} value={value.riskTier} onChange={(e) => onChange({ ...value, riskTier: e.target.value as typeof value.riskTier })}>{['low', 'medium', 'high'].map((s) => <option key={s}>{s}</option>)}</Select></Field>
      <Field label="Human oversight"><Textarea rows={3} disabled={disabled} value={value.humanOversight} onChange={(e) => onChange({ ...value, humanOversight: e.target.value })} /></Field>
      <RowTable label="Controls" rows={value.controls} disabled={disabled} onChange={(controls) => onChange({ ...value, controls })} blank={(): Control => ({ id: nextId('RAI', value.controls), text: '', status: 'planned' })} cols={controlCols} /></>}
  </div>;
}
export function SafeguardingEditor({ value, onChange, disabled }: P<'safeguarding'>) {
  return <div className="space-y-4">
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={disabled} checked={value.applies} onChange={(e) => onChange({ ...value, applies: e.target.checked })} />Safeguarding considerations apply</label>
    {value.applies && <><StringList label="Considerations" items={value.considerations} onChange={(v) => onChange({ ...value, considerations: v })} disabled={disabled} />
      <RowTable label="Controls" rows={value.controls} disabled={disabled} onChange={(controls) => onChange({ ...value, controls })} blank={(): Control => ({ id: nextId('SG', value.controls), text: '', status: 'planned' })} cols={controlCols} /></>}
  </div>;
}
export function EngineeringPlanEditor({ value, onChange, disabled }: P<'engineeringPlan'>) {
  return <div className="space-y-4"><Field label="Approach"><Textarea rows={3} disabled={disabled} value={value.approach} onChange={(e) => onChange({ ...value, approach: e.target.value })} /></Field>
    <RowTable label="Milestones" rows={value.milestones} disabled={disabled} onChange={(milestones) => onChange({ ...value, milestones })} blank={(): Milestone => ({ id: nextId('M', value.milestones), name: '', due: '', deliverables: [] })} cols={[{ key: 'id', label: 'ID', width: '5rem' }, { key: 'name', label: 'Milestone' }, { key: 'due', label: 'Due', width: '9rem' }, { key: 'deliverables', label: 'Deliverables', kind: 'list' }]} />
    <StringList label="Teams" items={value.teams} onChange={(v) => onChange({ ...value, teams: v })} disabled={disabled} /><StringList label="Dependencies" items={value.dependencies} onChange={(v) => onChange({ ...value, dependencies: v })} disabled={disabled} /></div>;
}
export function QaStrategyEditor({ value, onChange, disabled }: P<'qaStrategy'>) {
  return <div className="space-y-4"><Field label="Approach"><Textarea rows={3} disabled={disabled} value={value.approach} onChange={(e) => onChange({ ...value, approach: e.target.value })} /></Field>
    <StringList label="Test levels" items={value.testLevels} onChange={(v) => onChange({ ...value, testLevels: v })} disabled={disabled} /><StringList label="Environments" items={value.environments} onChange={(v) => onChange({ ...value, environments: v })} disabled={disabled} /><StringList label="Exit criteria" items={value.exitCriteria} onChange={(v) => onChange({ ...value, exitCriteria: v })} disabled={disabled} /></div>;
}
export function DevOpsEditor({ value, onChange, disabled }: P<'devOpsStrategy'>) {
  return <div className="space-y-4"><Field label="Pipeline"><Textarea rows={3} disabled={disabled} value={value.pipeline} onChange={(e) => onChange({ ...value, pipeline: e.target.value })} /></Field>
    <StringList label="Environments" items={value.environments} onChange={(v) => onChange({ ...value, environments: v })} disabled={disabled} />
    <RowTable label="DevOps checklist" rows={value.checklist} disabled={disabled} onChange={(checklist) => onChange({ ...value, checklist })} blank={(): ChecklistItem => ({ id: nextId('C', value.checklist), text: '', done: false })} cols={checkCols} /></div>;
}
export function OperationalReadinessEditor({ value, onChange, disabled }: P<'operationalReadiness'>) {
  return <div className="space-y-4"><Field label="Runbook reference"><Input disabled={disabled} value={value.runbookRef} onChange={(e) => onChange({ ...value, runbookRef: e.target.value })} /></Field>
    <StringList label="SLO targets" items={value.sloTargets} onChange={(v) => onChange({ ...value, sloTargets: v })} disabled={disabled} />
    <Field label="Alerting"><Textarea rows={2} disabled={disabled} value={value.alerting} onChange={(e) => onChange({ ...value, alerting: e.target.value })} /></Field>
    <RowTable label="Go-live checklist" rows={value.checklist} disabled={disabled} onChange={(checklist) => onChange({ ...value, checklist })} blank={(): ChecklistItem => ({ id: nextId('C', value.checklist), text: '', done: false })} cols={checkCols} /></div>;
}

export function SectionEditor({ sectionKey, value, onChange, disabled }: { sectionKey: SectionKey; value: SectionContentMap[SectionKey]; onChange: (v: SectionContentMap[SectionKey]) => void; disabled?: boolean }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = { onChange, disabled } as { onChange: (v: any) => void; disabled?: boolean };
  switch (sectionKey) {
    case 'productIntent': return <ProductIntentEditor value={value as SectionContentMap['productIntent']} {...p} />;
    case 'personas': return <PersonasEditor value={value as SectionContentMap['personas']} {...p} />;
    case 'userJourneys': return <UserJourneysEditor value={value as SectionContentMap['userJourneys']} {...p} />;
    case 'uxRequirements': return <UxRequirementsEditor value={value as SectionContentMap['uxRequirements']} {...p} />;
    case 'accessibilityRequirements': return <AccessibilityEditor value={value as SectionContentMap['accessibilityRequirements']} {...p} />;
    case 'architecture': return <ArchitectureEditor value={value as SectionContentMap['architecture']} {...p} />;
    case 'adrs': return <AdrsEditor value={value as SectionContentMap['adrs']} {...p} />;
    case 'nfrs': return <NfrsEditor value={value as SectionContentMap['nfrs']} {...p} />;
    case 'integrationDesign': return <IntegrationEditor value={value as SectionContentMap['integrationDesign']} {...p} />;
    case 'dataDesign': return <DataDesignEditor value={value as SectionContentMap['dataDesign']} {...p} />;
    case 'security': return <SecurityEditor value={value as SectionContentMap['security']} {...p} />;
    case 'privacy': return <PrivacyEditor value={value as SectionContentMap['privacy']} {...p} />;
    case 'responsibleAi': return <ResponsibleAiEditor value={value as SectionContentMap['responsibleAi']} {...p} />;
    case 'safeguarding': return <SafeguardingEditor value={value as SectionContentMap['safeguarding']} {...p} />;
    case 'engineeringPlan': return <EngineeringPlanEditor value={value as SectionContentMap['engineeringPlan']} {...p} />;
    case 'qaStrategy': return <QaStrategyEditor value={value as SectionContentMap['qaStrategy']} {...p} />;
    case 'devOpsStrategy': return <DevOpsEditor value={value as SectionContentMap['devOpsStrategy']} {...p} />;
    case 'operationalReadiness': return <OperationalReadinessEditor value={value as SectionContentMap['operationalReadiness']} {...p} />;
  }
}
