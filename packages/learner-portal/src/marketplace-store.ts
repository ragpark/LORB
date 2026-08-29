// The tool marketplace's data layer.
//
// The marketplace is a teacher-facing catalogue over two kinds of listing:
//
//  1. Objects LORB already serves this portal ("included"): these are the same records the course
//     catalogue shows, so placing one into a course and launching it uses the real launch path —
//     nothing here is a second way to reach content, only a second way to *choose* it.
//  2. External tools ("external"): third-party products that would arrive by LTI 1.3 deep linking,
//     SCORM import, or a plain embedded URL. These are demonstration fixtures. Their commercial
//     states (subscription, trial) and their launches are mocked, and every screen that shows one
//     says so.
//
// Entitlements and placements are demo state, so they live in localStorage under versioned keys and
// never touch the token stores in security.ts. Clearing them loses nothing of record.

import type {CatalogueObject, Course} from './catalogue.js';

export type LaunchProfile = 'LTI 1.3' | 'SCORM 2004' | 'Embedded URL';
export type Licence = 'included' | 'subscription' | 'trial';

export interface MarketTool {
  tool_id: string;
  title: string;
  provider: string;
  description: string;
  launch_profile: LaunchProfile;
  licence: Licence;
  /** Displayed price line, e.g. "£1.20 per learner / month". Absent for included tools. */
  price?: string;
  price_detail?: string;
  subjects: string;
  key_stages: string;
  /** How the tool reports back. Display copy only. */
  grade_return: string;
  external: boolean;
  /** Present when the listing wraps a real catalogue object, so placement can launch it for real. */
  object?: CatalogueObject;
}

export interface Placement {
  tool: MarketTool;
  repository_id: string;
  placed_at: string;
}

const ENTITLEMENT_KEY = 'lorb.marketplace.entitlements.v1';
const PLACEMENT_KEY = 'lorb.marketplace.placements.v1';

/** Demonstration fixtures for external tools. Deliberately data, not configuration: the point of
 *  the demo is the flow, and a fixture that cannot drift from an environment cannot break it. */
export const externalTools: MarketTool[] = [
  {
    tool_id: 'ext-codequest', title: 'CodeQuest', provider: 'ByteSize Ltd',
    description: 'Gamified Python challenges mapped to the KS3 computing curriculum, auto-marked with hints and teacher dashboards.',
    launch_profile: 'LTI 1.3', licence: 'subscription', price: '£1.20', price_detail: 'per learner / month',
    subjects: 'Computing', key_stages: 'KS3', grade_return: 'LTI Assignment & Grade Services', external: true,
  },
  {
    tool_id: 'ext-histmaps', title: 'Historic Maps Explorer', provider: 'Chronicle Digital',
    description: 'Layered historical map investigations packaged as SCORM 2004, reporting completion and score on import.',
    launch_profile: 'SCORM 2004', licence: 'trial', price: 'Free 30-day trial', price_detail: 'then £340 / year per school',
    subjects: 'History, Geography', key_stages: 'KS3', grade_return: 'SCORM score', external: true,
  },
  {
    tool_id: 'ext-fluent', title: 'Fluent Français', provider: 'LinguaCore',
    description: 'Speaking and listening practice with automatic pronunciation feedback; individual units deep-link as course activities.',
    launch_profile: 'LTI 1.3', licence: 'subscription', price: '£2.50', price_detail: 'per learner / month',
    subjects: 'French (MFL)', key_stages: 'KS3–KS4', grade_return: 'LTI Assignment & Grade Services', external: true,
  },
  {
    tool_id: 'ext-molview', title: 'MoleculeView 3D', provider: 'Praxis Science',
    description: 'Embeddable 3D molecule viewer launched by plain URL inside the course player; viewing events captured as xAPI.',
    launch_profile: 'Embedded URL', licence: 'trial', price: 'Free 14-day trial', price_detail: 'then £0.80 per learner / month',
    subjects: 'Chemistry', key_stages: 'KS4–KS5', grade_return: 'None (formative)', external: true,
  },
];

/** Every listing the marketplace shows: real catalogue objects first (deduplicated across the
 *  courses that carry them), then the external fixtures. */
export function buildListings(courses: Course[]): MarketTool[] {
  const seen = new Map<string, MarketTool>();
  for (const course of courses) {
    for (const object of course.objects) {
      if (seen.has(object.object_id)) continue;
      seen.set(object.object_id, {
        tool_id: `obj-${object.object_id}`,
        title: object.title ?? 'Untitled learning activity',
        provider: 'LORB repository',
        description: object.description ?? 'A learning object published to this platform.',
        launch_profile: 'Embedded URL',
        licence: 'included',
        subjects: object.kind ?? 'native-web-package',
        key_stages: object.duration ? `Duration: ${object.duration}` : 'Duration: not stated',
        grade_return: 'xAPI → Learning Record Store',
        external: false,
        object,
      });
    }
  }
  return [...seen.values(), ...externalTools];
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* demo state is best-effort */ }
}

export function entitlements(): Set<string> {
  return new Set(read<string[]>(ENTITLEMENT_KEY, []));
}
export function grantEntitlement(toolId: string) {
  write(ENTITLEMENT_KEY, [...entitlements().add(toolId)]);
}
export function isEntitled(tool: MarketTool): boolean {
  return tool.licence === 'included' || entitlements().has(tool.tool_id);
}

export function placements(): Placement[] {
  return read<Placement[]>(PLACEMENT_KEY, []);
}
export function placementsFor(repositoryId: string): Placement[] {
  return placements().filter(p => p.repository_id === repositoryId);
}
export function place(tool: MarketTool, repositoryId: string) {
  const current = placements().filter(p => !(p.tool.tool_id === tool.tool_id && p.repository_id === repositoryId));
  write(PLACEMENT_KEY, [...current, {tool, repository_id: repositoryId, placed_at: new Date().toISOString()}]);
}
export function clearDemoState() {
  try { localStorage.removeItem(ENTITLEMENT_KEY); localStorage.removeItem(PLACEMENT_KEY); } catch { /* best-effort */ }
}
