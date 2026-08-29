/**
 * The launch-context form's pure half, and the one property the screen could quietly lose: that the
 * tab offers settings at all. The API's refusals stay authoritative
 * (tests/runtime-api/publisher-authoring.spec.ts); what is checked here is what the API cannot do
 * for an author — name the bad row in their words, coerce "true" and "3" into the scalars the
 * schema means, and never send an empty settings object.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  keptRows, launchContextPayload, RESERVED_SETTING_KEY, settingsProblem, settingValue,
} from '../src/lib/launch-context-draft.js';

const workspace = readFileSync(new URL('../src/learning-objects.tsx', import.meta.url).pathname, 'utf8');

describe('authoring a launch context in the workspace', () => {
  it('builds the coach demo context exactly as the schema wants it', () => {
    expect(launchContextPayload('', [
      { key: 'llm_endpoint', value: 'demo' },
      { key: 'topic', value: 'equivalent fractions' },
      { key: 'title', value: 'Fractions coach' },
    ])).toEqual({ settings: { llm_endpoint: 'demo', topic: 'equivalent fractions', title: 'Fractions coach' } });
  });

  it('coerces booleans and numbers, and leaves everything else a string', () => {
    expect(settingValue('true')).toBe(true);
    expect(settingValue('false')).toBe(false);
    expect(settingValue('3')).toBe(3);
    expect(settingValue('2.5')).toBe(2.5);
    expect(settingValue('demo')).toBe('demo');
    expect(settingValue('3 turns')).toBe('3 turns');
    expect(settingValue('')).toBe('');
  });

  it('sends null to clear, and never an empty settings object', () => {
    expect(launchContextPayload('', [])).toBeNull();
    expect(launchContextPayload('', [{ key: '', value: '' }])).toBeNull();
    expect(launchContextPayload('midnight', [])).toEqual({ theme: 'midnight' });
    expect(launchContextPayload('midnight', [{ key: 'topic', value: 'x' }])).toEqual({ theme: 'midnight', settings: { topic: 'x' } });
  });

  it('ignores fully blank rows but keeps a half-filled one, so a mistake is named rather than dropped', () => {
    expect(keptRows([{ key: '', value: '' }, { key: 'topic', value: '' }])).toEqual([{ key: 'topic', value: '' }]);
    expect(settingsProblem([{ key: '', value: 'orphaned' }])).toContain('not a valid setting name');
  });

  it('names the first problem in the author\'s words', () => {
    expect(settingsProblem([{ key: 'llm_endpoint', value: 'demo' }])).toBe('');
    expect(settingsProblem([{ key: 'LLM endpoint', value: 'demo' }])).toContain('"LLM endpoint" is not a valid setting name');
    expect(settingsProblem([{ key: 'topic', value: 'a' }, { key: 'topic', value: 'b' }])).toBe('Setting names must be unique.');
    expect(settingsProblem(Array.from({ length: 17 }, (_, i) => ({ key: `setting_${i}`, value: 'x' })))).toBe('At most 16 settings.');
    expect(settingsProblem([{ key: 'topic', value: 'x'.repeat(257) }])).toContain('over 256 characters');
  });

  it('refuses names the admin leak guard would redact, before they are ever saved', () => {
    for (const key of ['token', 'api_token', 'bearer', 'private_key', 'tenant_secret']) {
      expect(RESERVED_SETTING_KEY.test(key)).toBe(true);
      expect(settingsProblem([{ key, value: 'x' }])).toContain('reserved name');
    }
    expect(RESERVED_SETTING_KEY.test('llm_endpoint')).toBe(false);
  });

  it('the tab offers settings, not only the theme', () => {
    expect(workspace).toContain('launchContextPayload(theme, rows)');
    expect(workspace).toContain('Add setting');
  });
});
