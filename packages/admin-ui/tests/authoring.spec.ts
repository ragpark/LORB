/**
 * The authoring rules the workspace is responsible for.
 *
 * The API refuses a bad draft either way, and that is the authoritative check
 * (tests/runtime-api/publisher-authoring.spec.ts). What is checked here is what the API cannot do
 * for an author: tell them which question is wrong in their own words, keep the marking key attached
 * to an option that still exists, and never send a field the content model does not have a place
 * for. Alongside that, the source assertions guard the two properties a screen could quietly lose —
 * that editing content publishes rather than overwrites, and that removing an object asks first.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { emptyQuiz, MAX_QUESTIONS, OPTION_IDS, quizFormFrom, quizPayload, quizProblem, type QuizForm } from '../src/lib/quiz-draft.js';
import { publisherBaseFor } from '../src/lib/catalogue-api.js';

const workspace = readFileSync(new URL('../src/learning-objects.tsx', import.meta.url).pathname, 'utf8');
const catalogueApi = readFileSync(new URL('../src/lib/catalogue-api.ts', import.meta.url).pathname, 'utf8');
const quizDraft = readFileSync(new URL('../src/lib/quiz-draft.ts', import.meta.url).pathname, 'utf8');

const usable = (): QuizForm => ({
  title: 'Fractions check-in',
  description: '',
  subject: '',
  year_group: '',
  questions: [{
    stem: 'Which is equivalent to 1/2?',
    options: [{ id: 'a', text: '2/4' }, { id: 'b', text: '1/3' }],
    correct_option_id: 'a',
    explanation: '',
  }],
});

describe('authoring a quiz in the workspace', () => {
  it('sends no empty optional field, so a blank box never becomes an empty description', () => {
    const payload = quizPayload(usable());
    expect(payload).not.toHaveProperty('description');
    expect(payload).not.toHaveProperty('subject');
    expect(payload).not.toHaveProperty('year_group');
    expect((payload.questions as Record<string, unknown>[])[0]).not.toHaveProperty('explanation');
  });

  it('trims what an author typed rather than publishing their whitespace', () => {
    const form = usable();
    form.title = '  Fractions  ';
    form.questions[0]!.options[0]!.text = ' 2/4 ';
    const payload = quizPayload(form) as { title: string; questions: { options: { text: string }[] }[] };
    expect(payload.title).toBe('Fractions');
    expect(payload.questions[0]!.options[0]!.text).toBe('2/4');
  });

  it('names the question an author has to go back to, not a schema path', () => {
    expect(quizProblem(usable())).toBe('');
    const blankStem = usable();
    blankStem.questions.push({ stem: '   ', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correct_option_id: 'a', explanation: '' });
    expect(quizProblem(blankStem)).toBe('Question 2 has no question text.');

    const blankOption = usable();
    blankOption.questions[0]!.options[1]!.text = '';
    expect(quizProblem(blankOption)).toBe('Question 1 has an option with no text.');

    const unkeyed = usable();
    unkeyed.questions[0]!.correct_option_id = 'zzz';
    expect(quizProblem(unkeyed)).toBe('Question 1 has no option marked as the right answer.');

    const untitled = usable();
    untitled.title = '';
    expect(quizProblem(untitled)).toBe('Give the quiz a title.');
  });

  it('starts a new quiz at one answerable question with two options', () => {
    const fresh = emptyQuiz();
    expect(fresh.questions).toHaveLength(1);
    expect(fresh.questions[0]!.options.map((option) => option.id)).toEqual(['a', 'b']);
    expect(fresh.questions[0]!.correct_option_id).toBe('a');
  });

  it('reads a published quiz back into an editable draft without losing the marking key', () => {
    const form = quizFormFrom({
      title: 'Fractions',
      questions: [{ stem: 'Which?', options: [{ id: 'a', text: '2/4' }, { id: 'b', text: '1/3' }], correct_option_id: 'b' }],
      object_id: 'ignored', content_version: '3',
    });
    expect(form.questions[0]!.correct_option_id).toBe('b');
    expect(form.description).toBe('');
    // Fields the content model adds on publication are not fields an author edits.
    expect(quizPayload(form)).not.toHaveProperty('content_version');
    expect(quizPayload(form)).not.toHaveProperty('object_id');
  });

  it('offers no more options or questions than the content model accepts', () => {
    expect(OPTION_IDS).toHaveLength(6);
    expect(MAX_QUESTIONS).toBe(25);
    expect(workspace).toContain('disabled={question.options.length >= OPTION_IDS.length}');
    expect(workspace).toContain('disabled={value.questions.length >= MAX_QUESTIONS}');
  });

  it('keeps the marking key on an option that still exists when one is removed', () => {
    expect(workspace).toContain('remaining.some((option) => option.id === question.correct_option_id)');
  });

  it('never lets an author edit an option identifier, because answers are recorded against it', () => {
    expect(workspace).not.toMatch(/onChange=\{\(e\) => setOption\w*Id/);
    expect(quizDraft).toContain('Option identifiers are assigned, never typed.');
  });
});

describe('editing and withdrawing a learning object', () => {
  it('publishes a new version when content is saved rather than overwriting the current one', () => {
    expect(workspace).toContain("method: 'PUT'");
    expect(workspace).toContain('Publish new version');
    expect(workspace).toContain('supersedes the current one');
  });

  it('edits catalogue metadata through PATCH, which cannot carry a package or a module path', () => {
    expect(workspace).toContain("method: 'PATCH'");
    expect(workspace).toMatch(/body: form/);
    // The edit form holds exactly the four fields the API will accept.
    expect(workspace).not.toMatch(/PATCH[\s\S]{0,400}module_path/);
  });

  it('asks before every irreversible action, and says what it does', () => {
    for (const label of ['Suspend', 'Restore', 'Retire', 'Delete']) {
      expect(workspace).toContain(`label="${label}"`);
    }
    expect(workspace).toContain('Retirement does not reverse');
    expect(workspace).toContain('refused if the object has ever been launched or assigned');
    expect(workspace).toContain('<AlertDialog.Cancel asChild>');
  });

  // A published object is one a launch can resolve while the deletion runs, so the API refuses it.
  // Offering the control anyway would put the refusal after the confirmation rather than before it.
  it('offers deletion only once the object has been withdrawn', () => {
    expect(workspace).toContain("{status !== 'PUBLISHED' && (");
  });

  it('derives the publisher surface from the configured administration surface', () => {
    expect(publisherBaseFor('https://runtime.lorb.example/api/v1/admin')).toBe('https://runtime.lorb.example/api/v1/publisher');
    expect(publisherBaseFor('http://localhost:3000/api/v1/admin/')).toBe('http://localhost:3000/api/v1/publisher');
    expect(catalogueApi).toContain('VITE_PUBLISHER_API_BASE');
  });

  // An image declares ENV for every build argument it accepts, so one that was not passed reaches
  // the bundle as an empty string rather than as an absent variable. `??` does not fall back on it,
  // and the workspace would post every publisher request to its own origin.
  it('treats an unset build argument that arrives as an empty string as unset', () => {
    expect(catalogueApi).toContain("value.trim() !== ''");
    expect(catalogueApi).toContain('setting(import.meta.env.VITE_PUBLISHER_API_BASE)');
    expect(catalogueApi).toContain('setting(import.meta.env.VITE_ADMIN_API_BASE)');
  });
});
