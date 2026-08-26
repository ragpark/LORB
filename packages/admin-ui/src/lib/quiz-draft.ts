/**
 * The shape an authored quiz takes in the workspace, and the rules it has to satisfy before it is
 * worth sending.
 *
 * Kept apart from the screens deliberately: what makes a draft publishable is a property of the
 * content model, not of a form, and it is checked here so it can be tested without a browser.
 */

/**
 * Option identifiers are assigned, never typed.
 *
 * They are stable keys that a learner's answer is recorded against — an xAPI response carries the
 * option id and nothing else, which is what keeps free text out of the evidence record. Letting an
 * author edit one would silently re-point every answer already given at a different option.
 */
export const OPTION_IDS = ['a', 'b', 'c', 'd', 'e', 'f'];
/** The content model caps a quiz at 25 questions; the editor stops offering more at the same point. */
export const MAX_QUESTIONS = 25;

export type QuizOption = { id: string; text: string };
export type QuizQuestion = { stem: string; options: QuizOption[]; correct_option_id: string; explanation: string };
export type QuizForm = { title: string; description: string; subject: string; year_group: string; questions: QuizQuestion[] };

export const emptyQuestion = (): QuizQuestion => ({
  stem: '',
  options: [{ id: 'a', text: '' }, { id: 'b', text: '' }],
  correct_option_id: 'a',
  explanation: '',
});

export const emptyQuiz = (): QuizForm => ({ title: '', description: '', subject: '', year_group: '', questions: [emptyQuestion()] });

/** The wire shape the Publisher API accepts: trimmed, with empty optional fields left out entirely. */
export function quizPayload(form: QuizForm): Record<string, unknown> {
  const optional = (value: string, key: string) => (value.trim() ? { [key]: value.trim() } : {});
  return {
    title: form.title.trim(),
    ...optional(form.description, 'description'),
    ...optional(form.subject, 'subject'),
    ...optional(form.year_group, 'year_group'),
    questions: form.questions.map((question) => ({
      stem: question.stem.trim(),
      options: question.options.map((option) => ({ id: option.id, text: option.text.trim() })),
      correct_option_id: question.correct_option_id,
      ...optional(question.explanation, 'explanation'),
    })),
  };
}

/**
 * Says what is wrong with a draft in the author's words.
 *
 * The API refuses the same drafts, and its refusal is a schema error naming a path. An author who
 * left one option blank deserves to be told which one.
 */
export function quizProblem(form: QuizForm): string {
  if (!form.title.trim()) return 'Give the quiz a title.';
  if (form.questions.length === 0) return 'Add at least one question.';
  for (const [index, question] of form.questions.entries()) {
    const number = index + 1;
    if (!question.stem.trim()) return `Question ${number} has no question text.`;
    if (question.options.length < 2) return `Question ${number} needs at least two options.`;
    if (question.options.some((option) => !option.text.trim())) return `Question ${number} has an option with no text.`;
    if (!question.options.some((option) => option.id === question.correct_option_id)) {
      return `Question ${number} has no option marked as the right answer.`;
    }
  }
  return '';
}

/** Reads an authored quiz back into the form shape, filling in the fields the payload omits. */
export function quizFormFrom(content: Record<string, unknown>): QuizForm {
  const questions = Array.isArray(content.questions) ? (content.questions as Record<string, unknown>[]) : [];
  return {
    title: String(content.title ?? ''),
    description: String(content.description ?? ''),
    subject: String(content.subject ?? ''),
    year_group: String(content.year_group ?? ''),
    questions: questions.map((question) => ({
      stem: String(question.stem ?? ''),
      options: (Array.isArray(question.options) ? (question.options as Record<string, unknown>[]) : []).map((option) => ({
        id: String(option.id ?? ''),
        text: String(option.text ?? ''),
      })),
      correct_option_id: String(question.correct_option_id ?? ''),
      explanation: String(question.explanation ?? ''),
    })),
  };
}
