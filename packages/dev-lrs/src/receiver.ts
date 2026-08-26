/**
 * A minimal learning record store for local development.
 *
 * Production deployments point `LRS_ENDPOINT` at the real learning record store; this exists so that
 * `pnpm dev` and the test suites have somewhere for the forwarder to deliver to, and so a developer
 * can see what was actually sent. It keeps statements in memory and is never a deployment target.
 */
export interface StoredStatement {
  statement_id: string;
  received_at: string;
  payload: unknown;
}

const statements = new Map<string, StoredStatement>();

/**
 * xAPI treats the statement id as the deduplication key, so a repeat delivery is accepted and has no
 * second effect — the same contract a real learning record store offers on PUT /statements.
 */
export async function receiveStatement(statement: unknown, statementId?: string): Promise<{ statusCode: number }> {
  const id = statementId ?? (statement as { id?: string } | undefined)?.id;
  if (typeof id !== "string" || id.length === 0) return { statusCode: 400 };
  if (statements.has(id)) return { statusCode: 204 };
  statements.set(id, { statement_id: id, received_at: new Date().toISOString(), payload: statement });
  return { statusCode: 204 };
}

export function storedStatements(): StoredStatement[] {
  return [...statements.values()];
}

export function resetStatements(): void {
  statements.clear();
}
