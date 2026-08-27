import {z} from 'zod';import {logDiagnostic} from './diagnostics.js';
const base=z.object({protocol:z.literal('lorb-player'),version:z.literal('1.0'),type:z.enum(['module.resize','session.expiring','experience.complete','experience.exit','experience.error']),message_id:z.string().uuid(),correlation_id:z.string().uuid(),reply_to:z.null(),sent_at:z.string().datetime(),payload:z.record(z.unknown())}).strict();
export type PlayerMessage=z.infer<typeof base>;
// The player shell runs in sandbox="allow-scripts" without allow-same-origin, so its messages carry
// the opaque origin "null" rather than the shell's URL origin. "null" is accepted only together with
// the source check below: event.source must be the launch iframe's own window, which no other opaque
// -origin document in this page can forge.
export function acceptPlayerMessage(event:MessageEvent,allowed:ReadonlySet<string>,frame:Window|null):PlayerMessage|null{const correlation=typeof (event.data as any)?.correlation_id==='string'?(event.data as any).correlation_id:'unknown';const originTrusted=allowed.has(event.origin)||event.origin==='null';if(!originTrusted||frame===null||event.source!==frame){logDiagnostic({kind:'postmessage-rejected',correlationId:correlation});console.warn('Dropped untrusted player message');return null}const parsed=base.safeParse(event.data);if(!parsed.success){logDiagnostic({kind:'postmessage-rejected',correlationId:correlation});console.warn('Dropped malformed player message');return null}return parsed.data}
