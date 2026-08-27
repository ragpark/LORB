/**
 * The learning object workspace: create, read, edit, withdraw.
 *
 * This page used to be a read-only list with a note saying content authoring was out of scope. It
 * was out of scope for as long as the catalogue was something a developer deployed; once an
 * administrator could register objects through the Publisher API, a workspace that could only ever
 * add to the catalogue left them stuck the first time anything was typed wrong.
 *
 * Two distinctions the screens are built around, because they are the ones an administrator gets
 * wrong otherwise:
 *
 *   - Editing the *catalogue entry* — the title, description, stated duration and kind — changes
 *     what a person reads. It never changes what a launch resolves to, so it is an ordinary form
 *     that saves.
 *   - Editing what is *delivered* — a quiz's questions, or a packaged module's bundle — publishes a
 *     new immutable version and supersedes the current one. Attempts already recorded stay bound to
 *     the version they were launched against. The screens say so at the point of the action rather
 *     than in a note nobody reads.
 */
import { useEffect, useMemo, useState } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminApiError } from './lib/api-client.js';
import { admin, errorMessage, publisher } from './lib/catalogue-api.js';
import {
  emptyQuestion, emptyQuiz, OPTION_IDS, MAX_QUESTIONS, quizFormFrom, quizPayload, quizProblem,
  type QuizForm, type QuizQuestion,
} from './lib/quiz-draft.js';
import { AuditTab } from './audit.js';

type Row = Record<string, unknown>;

/** Statuses an administrator can filter the catalogue by, in lifecycle order. */
const STATUSES = ['PUBLISHED', 'SUSPENDED', 'RETIRED'] as const;

// ---------------------------------------------------------------------------
// Quiz authoring
// ---------------------------------------------------------------------------

function QuestionEditor({
  question, index, total, onChange, onRemove,
}: {
  question: QuizQuestion; index: number; total: number;
  onChange: (next: QuizQuestion) => void; onRemove: () => void;
}) {
  const setOption = (optionIndex: number, text: string) =>
    onChange({ ...question, options: question.options.map((option, i) => (i === optionIndex ? { ...option, text } : option)) });
  const addOption = () => {
    const id = OPTION_IDS[question.options.length];
    if (!id) return;
    onChange({ ...question, options: [...question.options, { id, text: '' }] });
  };
  const removeOption = (optionIndex: number) => {
    const remaining = question.options.filter((_, i) => i !== optionIndex);
    onChange({
      ...question,
      options: remaining,
      // The marking key follows the options: dropping the option it named would otherwise leave a
      // question whose right answer is not on offer, which the API refuses and the author cannot see.
      correct_option_id: remaining.some((option) => option.id === question.correct_option_id) ? question.correct_option_id : (remaining[0]?.id ?? ''),
    });
  };
  return (
    <li className="version-card question-card">
      <div className="question-head">
        <strong>Question {index + 1}</strong>
        <button type="button" onClick={onRemove} disabled={total === 1}>Remove question</button>
      </div>
      <label>
        Question text
        <textarea value={question.stem} onChange={(e) => onChange({ ...question, stem: e.target.value })} maxLength={600} rows={2} required />
      </label>
      <fieldset className="options">
        <legend>Options — select the right answer</legend>
        {question.options.map((option, optionIndex) => (
          <div key={option.id} className="option-row">
            <label className="option-key">
              <input
                type="radio"
                name={`answer-${index}`}
                checked={question.correct_option_id === option.id}
                onChange={() => onChange({ ...question, correct_option_id: option.id })}
                aria-label={`Option ${option.id.toUpperCase()} is the right answer`}
              />
              <span className="mono">{option.id.toUpperCase()}</span>
            </label>
            <input
              value={option.text}
              onChange={(e) => setOption(optionIndex, e.target.value)}
              maxLength={300}
              aria-label={`Option ${option.id.toUpperCase()} text`}
              required
            />
            <button type="button" onClick={() => removeOption(optionIndex)} disabled={question.options.length <= 2}>Remove</button>
          </div>
        ))}
        <button type="button" onClick={addOption} disabled={question.options.length >= OPTION_IDS.length}>Add option</button>
      </fieldset>
      <label>
        Explanation shown after answering (optional)
        <input value={question.explanation} onChange={(e) => onChange({ ...question, explanation: e.target.value })} maxLength={1000} />
      </label>
    </li>
  );
}

export function QuizEditor({ value, onChange }: { value: QuizForm; onChange: (next: QuizForm) => void }) {
  const setQuestion = (index: number, next: QuizQuestion) =>
    onChange({ ...value, questions: value.questions.map((question, i) => (i === index ? next : question)) });
  return (
    <div className="quiz-editor">
      <div className="form">
        <label>
          Title
          <input value={value.title} onChange={(e) => onChange({ ...value, title: e.target.value })} maxLength={200} required />
        </label>
        <label>
          Subject (optional)
          <input value={value.subject} onChange={(e) => onChange({ ...value, subject: e.target.value })} maxLength={80} />
        </label>
        <label>
          Year group (optional)
          <input value={value.year_group} onChange={(e) => onChange({ ...value, year_group: e.target.value })} maxLength={40} />
        </label>
      </div>
      <label className="stacked">
        Description (optional)
        <textarea value={value.description} onChange={(e) => onChange({ ...value, description: e.target.value })} maxLength={600} rows={2} />
      </label>
      <ul className="list">
        {value.questions.map((question, index) => (
          <QuestionEditor
            key={index}
            question={question}
            index={index}
            total={value.questions.length}
            onChange={(next) => setQuestion(index, next)}
            onRemove={() => onChange({ ...value, questions: value.questions.filter((_, i) => i !== index) })}
          />
        ))}
      </ul>
      <button
        type="button"
        onClick={() => onChange({ ...value, questions: [...value.questions, emptyQuestion()] })}
        disabled={value.questions.length >= MAX_QUESTIONS}
      >
        Add question
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

function NewQuizForm({ repositories, onCreated }: { repositories: Row[]; onCreated: (objectId: string) => void }) {
  const [repositoryId, setRepositoryId] = useState('');
  const [form, setForm] = useState<QuizForm>(emptyQuiz());
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    const problem = quizProblem(form);
    if (problem) return setError(problem);
    setError('');
    setSaving(true);
    try {
      const created = await publisher<{ object_id: string }>('learning-objects/quizzes', {
        method: 'POST',
        body: { ...(repositoryId ? { repository_id: repositoryId } : {}), ...quizPayload(form) },
      });
      setForm(emptyQuiz());
      onCreated(created.object_id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <p className="governance-note">
        A quiz is content, not code: the questions below are published as data and rendered by the one shared quiz player that has already been reviewed. No
        bundle is uploaded, so however many quizzes are written, none of them adds executable surface to the catalogue.
      </p>
      <label className="stacked">
        Repository
        <select value={repositoryId} onChange={(e) => setRepositoryId(e.target.value)}>
          <option value="">Default repository</option>
          {repositories.map((row) => (
            <option key={String(row.repository_id)} value={String(row.repository_id)}>{String(row.display_name)}</option>
          ))}
        </select>
      </label>
      <QuizEditor value={form} onChange={setForm} />
      {error && <p role="alert" className="error-text">{error}</p>}
      <div className="dialog-actions">
        <button type="submit" disabled={saving}>{saving ? 'Publishing…' : 'Publish quiz'}</button>
      </div>
    </form>
  );
}

function NewPackagedObjectForm({ repositories, onCreated }: { repositories: Row[]; onCreated: (objectId: string) => void }) {
  const [form, setForm] = useState({
    repository_id: '', title: '', description: '', duration: '', kind: 'native-web-package',
    module_path: '', semver: '1.0.0', sha256: '',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  const submit = async () => {
    setError('');
    setSaving(true);
    try {
      const created = await publisher<{ object_id: string }>('learning-objects', {
        method: 'POST',
        body: {
          repository_id: form.repository_id || String(repositories[0]?.repository_id ?? ''),
          title: form.title,
          ...(form.description ? { description: form.description } : {}),
          ...(form.duration ? { duration: form.duration } : {}),
          kind: form.kind,
          module_path: form.module_path,
          semver: form.semver,
          sha256: form.sha256,
        },
      });
      onCreated(created.object_id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <p className="governance-note">
        A module path is a path under the Player Shell origin, never a full URL. The digest is what a launch descriptor pins, so it is recorded once and never
        edited: correcting a package means publishing a new version, which supersedes this one and leaves every recorded attempt describing what it was actually
        delivered.
      </p>
      <div className="form">
        <label>
          Repository
          <select value={form.repository_id} onChange={set('repository_id')} required>
            <option value="">Select a repository</option>
            {repositories.map((row) => (
              <option key={String(row.repository_id)} value={String(row.repository_id)}>{String(row.display_name)}</option>
            ))}
          </select>
        </label>
        <label>
          Title
          <input value={form.title} onChange={set('title')} maxLength={200} required />
        </label>
        <label>
          Stated duration
          <input value={form.duration} onChange={set('duration')} placeholder="20 minutes" maxLength={60} />
        </label>
        <label>
          Kind
          <input value={form.kind} onChange={set('kind')} pattern="[a-z][a-z0-9\-]{1,60}" required />
        </label>
        <label>
          Module path
          <input value={form.module_path} onChange={set('module_path')} placeholder="/modules/my-activity/index.html" pattern="/[A-Za-z0-9._~\-/]*" required />
        </label>
        <label>
          Semantic version
          <input value={form.semver} onChange={set('semver')} pattern="\d+\.\d+\.\d+" required />
        </label>
        <label>
          Package digest (sha256, hex)
          <input value={form.sha256} onChange={set('sha256')} pattern="[0-9a-fA-F]{64}" required />
        </label>
      </div>
      <label className="stacked">
        Description
        <textarea value={form.description} onChange={set('description')} maxLength={1000} rows={2} />
      </label>
      {error && <p role="alert" className="error-text">{error}</p>}
      <div className="dialog-actions">
        <button type="submit" disabled={saving}>{saving ? 'Registering…' : 'Register learning object'}</button>
      </div>
    </form>
  );
}

function NewLearningObjectDialog({ repositories, onCreated }: { repositories: Row[]; onCreated: (objectId: string) => void }) {
  const [open, setOpen] = useState(false);
  const created = (objectId: string) => {
    setOpen(false);
    onCreated(objectId);
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className="primary-action">New learning object</button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog wide">
          <Dialog.Title>New learning object</Dialog.Title>
          <Dialog.Description>Author a quiz here, or register a packaged module that has already been built and hashed.</Dialog.Description>
          <Tabs.Root defaultValue="quiz">
            <Tabs.List aria-label="What to create">
              <Tabs.Trigger value="quiz">Author a quiz</Tabs.Trigger>
              <Tabs.Trigger value="package">Register a packaged module</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="quiz">
              <NewQuizForm repositories={repositories} onCreated={created} />
            </Tabs.Content>
            <Tabs.Content value="package">
              <NewPackagedObjectForm repositories={repositories} onCreated={created} />
            </Tabs.Content>
          </Tabs.Root>
          <Dialog.Close asChild>
            <button>Cancel</button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Smart links
// ---------------------------------------------------------------------------

type SmartLink = { smart_link_id: string; object_id: string; token: string; url: string; created_at: string; revoked_at: string | null };

export function LearningObjectSmartLink({ objectId }: { objectId: string }) {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const link = useQuery({
    queryKey: ['smart-link', objectId],
    queryFn: async (): Promise<SmartLink | null> => {
      try {
        return await admin<SmartLink>(`learning-objects/${objectId}/smart-link`);
      } catch (e) {
        if (e instanceof AdminApiError && e.problem.code === 'SMART_LINK_NOT_FOUND') return null;
        throw e;
      }
    },
  });
  const copy = async () => {
    setError('');
    setCopied(false);
    try {
      const result = await admin<SmartLink>(`learning-objects/${objectId}/smart-link`, { method: 'POST' });
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
      void queryClient.invalidateQueries({ queryKey: ['smart-link', objectId] });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const revoke = async () => {
    setError('');
    setCopied(false);
    try {
      await admin(`learning-objects/${objectId}/smart-link/revoke`, { method: 'POST' });
      void queryClient.invalidateQueries({ queryKey: ['smart-link', objectId] });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <p className="mono small">
      <button onClick={() => void copy()}>{link.data ? 'Copy smart link' : 'Create smart link'}</button>{' '}
      {link.data && (
        <button onClick={() => void revoke()}>Revoke</button>
      )}
      {link.data && <span> {link.data.url}</span>}
      {copied && <span role="status"> Copied to clipboard.</span>}
      {error && <span role="alert" className="error-text"> {error}</span>}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export function LearningObjectsView({ onOpen }: { onOpen: (objectId: string) => void }) {
  const queryClient = useQueryClient();
  const repositories = useQuery({ queryKey: ['repositories'], queryFn: () => admin<{ items: Row[] }>('repositories') });
  const [repositoryId, setRepositoryId] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const query = [repositoryId && `repository_id=${encodeURIComponent(repositoryId)}`, status && `status=${status}`].filter(Boolean).join('&');
  const objects = useQuery({
    queryKey: ['learning-objects', repositoryId, status],
    queryFn: () => publisher<{ items: Row[] }>(`learning-objects${query ? `?${query}` : ''}`),
  });
  const term = search.trim().toLowerCase();
  const items = (objects.data?.items ?? []).filter(
    (row) => !term || `${String(row.title ?? '')} ${String(row.description ?? '')} ${String(row.object_id)}`.toLowerCase().includes(term),
  );
  return (
    <section>
      <div className="page-head">
        <h1>Learning objects</h1>
        <NewLearningObjectDialog
          repositories={repositories.data?.items ?? []}
          onCreated={(objectId) => {
            void queryClient.invalidateQueries({ queryKey: ['learning-objects'] });
            onOpen(objectId);
          }}
        />
      </div>
      <p className="governance-note">
        Open a learning object to edit it, publish a new version of it, or withdraw it. A smart link — which lets a learner open a published object directly in
        the Player Shell without a consumer or identity-provider sign-in — is created and revoked there too: it is pseudonymous per browser, not tied to a real
        identity, so it must not be used where a real identity is required downstream.
      </p>
      <div className="filters">
        <label>
          Repository
          <select value={repositoryId} onChange={(e) => setRepositoryId(e.target.value)}>
            <option value="">All repositories</option>
            {(repositories.data?.items ?? []).map((row) => (
              <option key={String(row.repository_id)} value={String(row.repository_id)}>{String(row.display_name)}</option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Search
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Title, description or object ID" />
        </label>
      </div>
      {objects.error && <p role="alert" className="error-text">{errorMessage(objects.error)}</p>}
      <ul className="list">
        {items.map((row) => {
          const pkg = row.package_version as Row | undefined;
          return (
            <li key={String(row.object_id)} className="version-card">
              <p>
                <button className="link-button" onClick={() => onOpen(String(row.object_id))}>
                  <strong>{String(row.title || 'Untitled learning activity')}</strong>
                </button>{' '}
                <span className="status-badge">{String(row.status)}</span>
              </p>
              <p className="mono small">
                {String(row.kind)} · {String(row.duration || 'duration not stated')}
                {row.content_profile === 'quiz-json-v1' && ' · authored content'}
              </p>
              <p>{String(row.description ?? '')}</p>
              {pkg && (
                <p className="mono small">
                  Active package: <span className="mono">{String(pkg.semver)}</span> — <span className="status-badge">{String(pkg.status)}</span>
                </p>
              )}
            </li>
          );
        })}
        {!items.length && <li>{objects.isPending ? 'Loading…' : 'No learning objects match these filters.'}</li>}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Detail: editing, publishing, withdrawing
// ---------------------------------------------------------------------------

function ConfirmedAction({
  label, title, description, danger, onConfirm,
}: {
  label: string; title: string; description: string; danger?: boolean; onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <AlertDialog.Trigger asChild>
        <button className={danger ? 'danger' : undefined}>{label}</button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="overlay" />
        <AlertDialog.Content className="dialog">
          <AlertDialog.Title>{title}</AlertDialog.Title>
          <AlertDialog.Description>{description}</AlertDialog.Description>
          {error && <p role="alert" className="error-text">{error}</p>}
          <div className="dialog-actions">
            <AlertDialog.Cancel asChild>
              <button>Cancel</button>
            </AlertDialog.Cancel>
            <button className={danger ? 'danger' : undefined} disabled={busy} onClick={() => void submit()}>{busy ? 'Working…' : label}</button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function MetadataForm({ object, onSaved }: { object: Row; onSaved: () => void }) {
  const objectId = String(object.object_id);
  const [form, setForm] = useState({
    title: String(object.title ?? ''),
    description: String(object.description ?? ''),
    duration: String(object.duration ?? ''),
    kind: String(object.kind ?? ''),
  });
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  // A refetch after a save — or after somebody else's edit — must reach the fields.
  useEffect(() => {
    setForm({
      title: String(object.title ?? ''),
      description: String(object.description ?? ''),
      duration: String(object.duration ?? ''),
      kind: String(object.kind ?? ''),
    });
  }, [object.title, object.description, object.duration, object.kind]);
  const retired = object.status === 'RETIRED';
  const submit = async () => {
    setError('');
    setSaved(false);
    setSaving(true);
    try {
      await publisher(`learning-objects/${objectId}`, { method: 'PATCH', body: form });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <p className="governance-note">
        These fields are what the catalogue says about this object. None of them changes what a launch resolves to: the module path, the package digest and the
        version chain are reachable only by publishing a new version.
      </p>
      <div className="form">
        <label>
          Title
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={200} disabled={retired} required />
        </label>
        <label>
          Stated duration
          <input value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} maxLength={60} disabled={retired} />
        </label>
        <label>
          Kind
          <input value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} pattern="[a-z][a-z0-9\-]{1,60}" disabled={retired} required />
        </label>
      </div>
      <label className="stacked">
        Description
        <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={1000} rows={3} disabled={retired} />
      </label>
      <p className="mono small">
        Module path: {String(object.module_path ?? '—')} · Object ID: {objectId}
      </p>
      {error && <p role="alert" className="error-text">{error}</p>}
      {saved && <p role="status">Saved.</p>}
      <button type="submit" disabled={retired || saving}>{saving ? 'Saving…' : 'Save changes'}</button>
      {retired && <p className="small">A retired learning object is a historical record and cannot be edited.</p>}
    </form>
  );
}

function ContentTab({ object, onSaved }: { object: Row; onSaved: () => void }) {
  const objectId = String(object.object_id);
  const content = useQuery({
    queryKey: ['learning-object-content', objectId],
    queryFn: () => publisher<Record<string, unknown>>(`learning-objects/${objectId}/content`),
  });
  const loaded = useMemo(() => (content.data ? quizFormFrom(content.data) : undefined), [content.data]);
  const [form, setForm] = useState<QuizForm | undefined>(undefined);
  useEffect(() => {
    if (loaded) setForm(loaded);
  }, [loaded]);
  const [error, setError] = useState('');
  const [published, setPublished] = useState('');
  const [saving, setSaving] = useState(false);
  if (content.error) return <p role="alert" className="error-text">{errorMessage(content.error)}</p>;
  if (!form) return <p>Loading…</p>;
  const submit = async () => {
    const problem = quizProblem(form);
    if (problem) return setError(problem);
    setError('');
    setPublished('');
    setSaving(true);
    try {
      const revision = await publisher<{ content_version: string; semver: string }>(`learning-objects/${objectId}/content`, {
        method: 'PUT',
        body: quizPayload(form),
      });
      setPublished(`Published content version ${revision.content_version} as ${revision.semver}.`);
      onSaved();
      void content.refetch();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <p className="governance-note">
        Saving publishes a new version of this quiz and supersedes the current one. Attempts already recorded stay bound to the version they were launched
        against, so a learner is never reported against questions they did not see. The right answers below are shown to you because you are editing them, and
        the fact that you read them is written to the audit trail.
      </p>
      <QuizEditor value={form} onChange={setForm} />
      {error && <p role="alert" className="error-text">{error}</p>}
      {published && <p role="status">{published}</p>}
      <button type="submit" disabled={saving}>{saving ? 'Publishing…' : 'Publish new version'}</button>
    </form>
  );
}

function PublishVersionForm({ objectId, onPublished }: { objectId: string; onPublished: () => void }) {
  const [form, setForm] = useState({ semver: '', module_path: '', sha256: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setError('');
    setSaving(true);
    try {
      await publisher(`learning-objects/${objectId}/versions`, { method: 'POST', body: form });
      setForm({ semver: '', module_path: '', sha256: '' });
      onPublished();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label>
        Semantic version
        <input value={form.semver} onChange={(e) => setForm({ ...form, semver: e.target.value })} pattern="\d+\.\d+\.\d+" placeholder="1.1.0" required />
      </label>
      <label>
        Module path
        <input value={form.module_path} onChange={(e) => setForm({ ...form, module_path: e.target.value })} pattern="/[A-Za-z0-9._~\-/]*" required />
      </label>
      <label>
        Package digest (sha256, hex)
        <input value={form.sha256} onChange={(e) => setForm({ ...form, sha256: e.target.value })} pattern="[0-9a-fA-F]{64}" required />
      </label>
      <button type="submit" disabled={saving}>{saving ? 'Publishing…' : 'Publish version'}</button>
      {error && <p role="alert" className="error-text">{error}</p>}
    </form>
  );
}

export function LearningObjectDetail({ objectId, onClosed }: { objectId: string; onClosed: () => void }) {
  const queryClient = useQueryClient();
  const object = useQuery({
    queryKey: ['learning-object', objectId],
    queryFn: () => publisher<Row & { versions: Row[]; package_versions: Row[] }>(`learning-objects/${objectId}`),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['learning-object', objectId] });
    void queryClient.invalidateQueries({ queryKey: ['learning-objects'] });
  };
  const lifecycle = async (action: string) => {
    await publisher(`learning-objects/${objectId}/${action}`, { method: 'POST' });
    refresh();
  };
  if (object.error) return <p role="alert" className="error-text">{errorMessage(object.error)}</p>;
  if (!object.data) return <p>Loading…</p>;
  const row = object.data;
  const status = String(row.status);
  const editableContent = row.editable_content === true;
  return (
    <section>
      <div className="page-head">
        <h1>{String(row.title || 'Untitled learning activity')}</h1>
        <button onClick={onClosed}>Back to learning objects</button>
      </div>
      <p>
        Status: <span className="status-badge">{status}</span> · Kind: <span className="mono">{String(row.kind)}</span>
        {row.authored_by ? <> · Authored by <span className="mono">{String(row.authored_by)}</span></> : null}
      </p>
      <div className="version-actions">
        {status === 'PUBLISHED' && (
          <ConfirmedAction
            label="Suspend"
            title="Suspend this learning object?"
            description="It stops being launchable and any smart link for it is revoked. Its versions and evidence are untouched, and it can be restored — or, if it was never launched or assigned, deleted."
            onConfirm={() => lifecycle('suspend')}
          />
        )}
        {status === 'SUSPENDED' && (
          <ConfirmedAction
            label="Restore"
            title="Restore this learning object?"
            description="It becomes launchable again at its current version. A revoked smart link is not restored — create a new one if it is needed."
            onConfirm={() => lifecycle('restore')}
          />
        )}
        {status !== 'RETIRED' && (
          <ConfirmedAction
            label="Retire"
            danger
            title="Retire this learning object?"
            description="Retirement does not reverse. The object stops being launchable for good, its smart link is revoked, and the evidence already recorded against it stays exactly as it is."
            onConfirm={() => lifecycle('retire')}
          />
        )}
        {/* Deletion is offered only once the object is withdrawn. A published object is one a launch
            can resolve while the deletion runs, and the API refuses it for that reason; showing the
            control anyway would make suspending look like an extra step rather than the first one. */}
        {status !== 'PUBLISHED' && (
          <ConfirmedAction
            label="Delete"
            danger
            title="Delete this learning object?"
            description="Deletion removes the object and its versions from the catalogue entirely. It is refused if the object has ever been launched or assigned — evidence outlives the catalogue, and those objects stay retired instead."
            onConfirm={async () => {
              await publisher(`learning-objects/${objectId}`, { method: 'DELETE' });
              void queryClient.invalidateQueries({ queryKey: ['learning-objects'] });
              onClosed();
            }}
          />
        )}
      </div>
      {status === 'PUBLISHED' && <LearningObjectSmartLink objectId={objectId} />}
      <Tabs.Root defaultValue="details">
        <Tabs.List aria-label="Learning object detail">
          <Tabs.Trigger value="details">Details</Tabs.Trigger>
          {editableContent && <Tabs.Trigger value="content">Content</Tabs.Trigger>}
          <Tabs.Trigger value="versions">Versions</Tabs.Trigger>
          <Tabs.Trigger value="audit">Audit</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="details">
          <MetadataForm object={row} onSaved={refresh} />
        </Tabs.Content>
        {editableContent && (
          <Tabs.Content value="content">
            <ContentTab object={row} onSaved={refresh} />
          </Tabs.Content>
        )}
        <Tabs.Content value="versions">
          <ul className="list">
            {(row.versions ?? []).map((version) => (
              <li key={String(version.object_version_id)} className="version-card">
                <p>
                  <span className="mono">{String(version.semver)}</span> — <span className="status-badge">{String(version.status)}</span>
                </p>
                <p className="mono small">
                  {String(version.object_version_id)} · package {String(version.package_version_id)}
                </p>
                <p className="small">{version.published_at ? `Published ${String(version.published_at)}` : 'Not published'}</p>
              </li>
            ))}
            {!(row.versions ?? []).length && <li>No versions recorded.</li>}
          </ul>
          {editableContent ? (
            <p className="governance-note">
              This object&rsquo;s payload is authored content rendered by the shared quiz player, so it has no bundle of its own to publish. Edit its questions
              on the Content tab — each save publishes a new version.
            </p>
          ) : status === 'RETIRED' ? (
            <p className="small">A retired learning object accepts no further versions.</p>
          ) : (
            <>
              <h2>Publish a new version</h2>
              <p className="small">
                The new version supersedes the current one. Nothing already published is edited, so an attempt that pinned the previous version still describes
                what was delivered.
              </p>
              <PublishVersionForm objectId={objectId} onPublished={refresh} />
            </>
          )}
        </Tabs.Content>
        <Tabs.Content value="audit">
          <AuditTab targetType="learning_object" targetId={objectId} />
        </Tabs.Content>
      </Tabs.Root>
    </section>
  );
}
