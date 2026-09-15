/** Small, dependency-free id helpers. */
export const AREA_CODES: Record<string, string> = {
  Learning: 'LRN', Assessment: 'ASM', Platform: 'PLT', 'Higher Education': 'HED', 'Workforce Skills': 'WFS', 'English Language': 'ELL',
};

export function specIdFor(productArea: string, seq: number): string {
  const code = AREA_CODES[productArea] ?? productArea.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X');
  return `SPEC-${code}-${String(seq).padStart(4, '0')}`;
}

export function uid(prefix = ''): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(16).slice(2, 10);
  return prefix ? `${prefix}-${rnd}` : rnd;
}

export const nowIso = () => new Date().toISOString();
