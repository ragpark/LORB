// The tool marketplace, and the course-catalogue section that shows what it has placed.
//
// This surface is a demonstration of the intended teacher flow — browse, subscribe, add to course —
// ahead of the real commercial and deep-linking machinery. Its rules:
//
//  - Purely additive. It reads the same course/catalogue data App.tsx already fetched, and its own
//    state never leaves localStorage (see marketplace.ts). No runtime or admin API is called, so no
//    existing behaviour can change underneath it.
//  - Honest about what is mocked. Subscriptions and external launches carry a DEMO badge and say in
//    words that no payment is taken and no external tool is contacted. Placements of *real* LORB
//    objects, by contrast, launch through the portal's genuine launch path.
//  - Visually the consumer surface's own. Everything here uses the Learner Portal palette tokens
//    from styles.css and the shared foundation shapes; marketplace-only rules live in
//    marketplace.css under a .mkt- prefix so they cannot collide with existing selectors.

import * as Dialog from '@radix-ui/react-dialog';
import {useMemo, useState} from 'react';
import type {CatalogueObject, Course} from './catalogue.js';
import {
  buildListings, isEntitled, grantEntitlement, place, placementsFor,
  type MarketTool, type Placement,
} from './marketplace-store.js';
import './marketplace.css';

type Filter = 'all' | 'LTI 1.3' | 'SCORM 2004' | 'Embedded URL' | 'licensed';
type Step = 'detail' | 'subscribe' | 'course' | 'done';

const licenceLabel = (tool: MarketTool) =>
  isEntitled(tool) ? 'Included' : tool.licence === 'trial' ? 'Trial available' : 'Subscription';
const licenceClass = (tool: MarketTool) =>
  isEntitled(tool) ? 'mkt-lic-included' : tool.licence === 'trial' ? 'mkt-lic-trial' : 'mkt-lic-sub';

export function Marketplace({courses, onBack, onPlaced}: {
  courses: Course[];
  onBack: () => void;
  /** Called after a placement so the catalogue can reflect it when next shown. */
  onPlaced?: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<MarketTool>();
  const [step, setStep] = useState<Step>('detail');
  const [targetCourse, setTargetCourse] = useState<string>('');
  // Bumped after grant/place so licence badges and buttons re-read localStorage.
  const [, setRevision] = useState(0);

  const listings = useMemo(() => buildListings(courses), [courses]);
  const placeable = courses.filter(course => course.repository_id !== '');

  const visible = listings.filter(tool => {
    const matchesFilter =
      filter === 'all' ? true :
      filter === 'licensed' ? isEntitled(tool) :
      tool.launch_profile === filter;
    const q = query.trim().toLowerCase();
    const matchesQuery = !q ||
      `${tool.title} ${tool.provider} ${tool.subjects} ${tool.description}`.toLowerCase().includes(q);
    return matchesFilter && matchesQuery;
  });

  const open = (tool: MarketTool) => {
    setSelected(tool);
    setStep('detail');
    setTargetCourse(placeable[0]?.repository_id ?? '');
  };
  const close = () => setSelected(undefined);
  const subscribe = () => {
    if (!selected) return;
    grantEntitlement(selected.tool_id);
    setRevision(r => r + 1);
    setStep('course');
  };
  const confirmPlacement = () => {
    if (!selected || !targetCourse) return;
    place(selected, targetCourse);
    setRevision(r => r + 1);
    setStep('done');
    onPlaced?.();
  };
  const targetName = placeable.find(course => course.repository_id === targetCourse)?.name ?? 'the course';

  const filters: Array<[Filter, string]> = [
    ['all', 'All'], ['LTI 1.3', 'LTI 1.3'], ['SCORM 2004', 'SCORM'],
    ['Embedded URL', 'Embedded URL'], ['licensed', 'In your licence'],
  ];

  return <section className="mkt">
    <nav className="crumbs"><button className="crumb" onClick={onBack}>← Your courses</button></nav>
    <h1>Tool marketplace <span className="mkt-demo-badge">Demo</span></h1>
    <p className="lede">Browse tools and learning objects, then add them to a course. External tools
      launch by LTI 1.3, SCORM or embedded URL; subscriptions here are mocked and take no payment.</p>

    <div className="mkt-toolbar">
      <input
        type="search" className="mkt-search" value={query}
        onChange={event => setQuery(event.target.value)}
        placeholder="Search tools, subjects, providers…" aria-label="Search the marketplace"
      />
      <div className="mkt-chips" role="group" aria-label="Filter tools">
        {filters.map(([value, label]) =>
          <button key={value} className={`mkt-chip${filter === value ? ' mkt-chip-on' : ''}`}
            aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
      </div>
    </div>

    <div className="grid">
      {visible.map(tool =>
        <button className="card mkt-card" key={tool.tool_id} onClick={() => open(tool)}>
          <span className="mkt-card-top">
            <strong>{tool.title}</strong>
            <span className={`mkt-lic ${licenceClass(tool)}`}>{licenceLabel(tool)}</span>
          </span>
          <span>{tool.provider}</span>
          <span className="mkt-desc">{tool.description}</span>
          <span className="mkt-meta">
            <code className="mkt-proto">{tool.launch_profile}</code>
            <span>{tool.subjects}</span>
          </span>
        </button>)}
      {visible.length === 0 && <p className="empty">No tools match that search.</p>}
    </div>

    <Dialog.Root open={Boolean(selected)} onOpenChange={opened => { if (!opened) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="drawer mkt-drawer" aria-describedby={undefined}>
          {selected && step === 'detail' && <>
            <Dialog.Title>{selected.title}</Dialog.Title>
            <p className="mkt-provider">{selected.provider}</p>
            <p>{selected.description}</p>
            <dl className="mkt-spec">
              <dt>Launch</dt><dd><code className="mkt-proto">{selected.launch_profile}</code></dd>
              <dt>Subjects</dt><dd>{selected.subjects}</dd>
              <dt>Key stages</dt><dd>{selected.key_stages}</dd>
              <dt>Learner data</dt><dd>xAPI → Learning Record Store</dd>
              <dt>Grade return</dt><dd>{selected.grade_return}</dd>
              <dt>Licence</dt><dd>{isEntitled(selected) ? 'Included — active for your school'
                : `${selected.price ?? ''} ${selected.price_detail ?? ''}`.trim()}</dd>
            </dl>
            {isEntitled(selected)
              ? <button onClick={() => setStep('course')} disabled={placeable.length === 0}>Add to course</button>
              : <button onClick={() => setStep('subscribe')}>
                  {selected.licence === 'trial' ? 'Start free trial' : 'Start subscription'}
                </button>}
            {placeable.length === 0 && <p className="empty">No courses are available to add tools to yet.</p>}
          </>}

          {selected && step === 'subscribe' && <>
            <Dialog.Title>Confirm {selected.licence === 'trial' ? 'trial' : 'subscription'}
              <span className="mkt-demo-badge">Demo</span></Dialog.Title>
            <div className="mkt-confirm">
              <strong>{selected.title}</strong>
              <p>{`${selected.price ?? ''} ${selected.price_detail ?? ''}`.trim()}</p>
              <p>Mocked for demonstration — no payment is taken and no order is created. In the
                intended flow this bills the institutional account, and the licence covers every
                teacher and learner in your organisation.</p>
            </div>
            <button onClick={subscribe}>Confirm {selected.licence === 'trial' ? 'trial' : 'subscription'}</button>
            <button className="mkt-quiet" onClick={() => setStep('detail')}>Back</button>
          </>}

          {selected && step === 'course' && <>
            <Dialog.Title>Add to a course</Dialog.Title>
            <p>The tool appears to learners as a new activity in the course you choose.</p>
            <div className="mkt-courses" role="radiogroup" aria-label="Choose a course">
              {placeable.map(course =>
                <button key={course.repository_id} role="radio"
                  aria-checked={targetCourse === course.repository_id}
                  className={`mkt-course${targetCourse === course.repository_id ? ' mkt-course-on' : ''}`}
                  onClick={() => setTargetCourse(course.repository_id)}>{course.name}</button>)}
            </div>
            <button onClick={confirmPlacement} disabled={!targetCourse}>Add to course</button>
            <button className="mkt-quiet" onClick={() => setStep('detail')}>Back</button>
          </>}

          {selected && step === 'done' && <>
            <Dialog.Title>{selected.title} added</Dialog.Title>
            <p>Now shown in <strong>{targetName}</strong>.
              {selected.external
                ? ' As an external tool it appears with a marketplace badge; its launch is mocked in this demo.'
                : ' It launches through the portal’s standard launch path.'}</p>
            <dl className="mkt-spec">
              <dt>Placement</dt><dd>{selected.external ? 'LTI Deep Linking (mocked)' : 'Course catalogue entry'}</dd>
              <dt>Entitlement</dt><dd>Verified at launch</dd>
              <dt>Telemetry</dt><dd>xAPI statements enabled</dd>
            </dl>
            <Dialog.Close asChild><button>Back to marketplace</button></Dialog.Close>
          </>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </section>;
}

/**
 * The marketplace's footprint on the course catalogue: placed tools, clearly badged, after the
 * course's own activities. Real objects hand off to the caller's normal detail/launch path;
 * external tools open a small dialog that explains the launch that would happen.
 */
export function MarketplacePlacements({course, onOpenObject}: {
  course: Course;
  onOpenObject: (object: CatalogueObject) => void;
}) {
  const [mockLaunch, setMockLaunch] = useState<Placement>();
  const placed = course.repository_id ? placementsFor(course.repository_id) : [];
  if (placed.length === 0) return null;
  return <>
    <h2 className="mkt-placed-heading">From the marketplace <span className="mkt-demo-badge">Demo</span></h2>
    <div className="grid">
      {placed.map(placement =>
        <button className="card mkt-card mkt-placed" key={placement.tool.tool_id}
          onClick={() => placement.tool.object ? onOpenObject(placement.tool.object) : setMockLaunch(placement)}>
          <span className="mkt-card-top">
            <strong>{placement.tool.title}</strong>
            <span className="mkt-lic mkt-lic-included">Marketplace</span>
          </span>
          <span>{placement.tool.provider}</span>
          <span className="mkt-meta"><code className="mkt-proto">{placement.tool.launch_profile}</code></span>
        </button>)}
    </div>
    <Dialog.Root open={Boolean(mockLaunch)} onOpenChange={opened => { if (!opened) setMockLaunch(undefined); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="drawer mkt-drawer" aria-describedby={undefined}>
          <Dialog.Title>{mockLaunch?.tool.title} <span className="mkt-demo-badge">Demo</span></Dialog.Title>
          <p>This external tool would now launch by <strong>{mockLaunch?.tool.launch_profile}</strong>:
            the platform signs a launch request, the tool verifies it, and the learner lands in the
            activity with their pseudonymous identity. No external service is contacted in this demo.</p>
          <Dialog.Close asChild><button>Close</button></Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}
