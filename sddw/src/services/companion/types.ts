import { z } from 'zod';
import type { Adr, DeliveryItem, Finding, SectionContent, SectionKey } from '@/domain/types';

/** Contract with the SDD Companion gateway — docs/09-api-layer-design.md */

export type CompanionAction =
  | 'review' | 'generate-section' | 'critique-section' | 'contradictions' | 'constitution-review'
  | 'reuse-review' | 'architecture-review' | 'privacy-review' | 'generate-adrs' | 'generate-delivery-pack';

export const ACTION_LABELS: Record<CompanionAction, string> = {
  'generate-section': 'Generate section', 'critique-section': 'Critique section', contradictions: 'Detect contradictions',
  'constitution-review': 'Review against constitution', 'reuse-review': 'Run reuse review', 'generate-adrs': 'Generate ADRs',
  'generate-delivery-pack': 'Generate delivery pack', review: 'Full review', 'architecture-review': 'Architecture review', 'privacy-review': 'Privacy review',
};
export const SECTION_ACTIONS: CompanionAction[] = ['generate-section', 'critique-section'];
export const SPEC_ACTIONS: CompanionAction[] = ['review', 'contradictions', 'constitution-review', 'reuse-review', 'architecture-review', 'privacy-review', 'generate-adrs', 'generate-delivery-pack'];

export interface RunRequest { specId: string; version: string; action: CompanionAction; sectionKey?: SectionKey; guidance?: string; correlationId: string }
export interface RunAccepted { runId: string; status: 'queued'; estimatedSeconds?: number }

export interface ReuseCandidate { name: string; kind: 'platform' | 'component' | 'pattern' | 'service'; owner: string; fit: 'high' | 'medium' | 'low'; rationale: string; link?: string }

export type CompanionResult =
  | { kind: 'findings'; findings: Finding[] }
  | { kind: 'section-proposal'; sectionKey: SectionKey; proposal: SectionContent; rationale: string; confidence: 'low' | 'medium' | 'high' }
  | { kind: 'reuse'; candidates: ReuseCandidate[]; findings: Finding[] }
  | { kind: 'adrs'; adrs: Adr[] }
  | { kind: 'delivery-pack'; items: DeliveryItem[] };

export interface RunStatus {
  runId: string;
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  progress?: number;
  result?: CompanionResult;
  error?: { code: string; message: string };
  agentVersion: string;
  correlationId: string;
}

// Runtime validation of gateway responses (defence against malformed/prompt-injected output).
const FindingSchema = z.object({
  id: z.string(), reviewId: z.string().default(''), category: z.enum(['warning', 'risk', 'open-question', 'suggested-change']),
  severity: z.enum(['blocker', 'high', 'medium', 'low']), sectionKey: z.string(), title: z.string().max(300), rationale: z.string().max(4000),
  suggestion: z.string().max(8000).optional(), status: z.enum(['open', 'accepted', 'rejected', 'resolved']).default('open'),
});
const AdrSchema = z.object({ id: z.string(), title: z.string(), status: z.enum(['Proposed', 'Accepted', 'Superseded', 'Rejected']), context: z.string(), decision: z.string(), consequences: z.string() });
const DeliveryItemSchema = z.object({ id: z.string(), type: z.enum(['epic', 'story', 'acceptance-criterion', 'adr', 'task', 'qa-case', 'bdd-scenario', 'devops-check']), key: z.string(), title: z.string(), body: z.string(), parentId: z.string().optional(), tracesTo: z.array(z.string()).default([]) });
const ReuseSchema = z.object({ name: z.string(), kind: z.enum(['platform', 'component', 'pattern', 'service']), owner: z.string(), fit: z.enum(['high', 'medium', 'low']), rationale: z.string(), link: z.string().url().optional() });

export const ResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('findings'), findings: z.array(FindingSchema) }),
  z.object({ kind: z.literal('section-proposal'), sectionKey: z.string(), proposal: z.unknown(), rationale: z.string(), confidence: z.enum(['low', 'medium', 'high']) }),
  z.object({ kind: z.literal('reuse'), candidates: z.array(ReuseSchema), findings: z.array(FindingSchema) }),
  z.object({ kind: z.literal('adrs'), adrs: z.array(AdrSchema) }),
  z.object({ kind: z.literal('delivery-pack'), items: z.array(DeliveryItemSchema) }),
]);

export const RunStatusSchema = z.object({
  runId: z.string(), status: z.enum(['queued', 'running', 'complete', 'failed', 'cancelled']), progress: z.number().min(0).max(1).optional(),
  result: ResultSchema.optional(), error: z.object({ code: z.string(), message: z.string() }).optional(), agentVersion: z.string().default('unknown'), correlationId: z.string().default(''),
});

export interface CompanionClient {
  start(req: RunRequest): Promise<RunAccepted>;
  poll(runId: string): Promise<RunStatus>;
  cancel(runId: string): Promise<void>;
}
