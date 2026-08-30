// The teacher-facing workspace: discovering and assigning resources to learners is the main job, so
// it is the first thing this renders. Class and roster administration, and results, are real work
// too but not that job — they live on their own destination behind the same rail nav, alongside a
// marketplace for bringing in another repository's content.
//
// A learner is identified here by the identifier their identity provider issues, and never paired
// with their LORB pseudonym in storage — results are matched by recomputing the pseudonym at read
// time, so no standing re-identification table exists. See 004_roster.sql.

import {useEffect,useRef,useState} from 'react';
import {adminRequest} from './admin-api.js';
import {adminSignInAgain} from './admin-auth.js';
import {ApiProblem} from './api.js';
import type {Config} from './config.js';
import {adminTokenStore} from './security.js';

export interface ClassSummary{class_id:string;name:string;year_group?:string;subject?:string;learner_count:number}
export interface ClassLearner{learner_ref:string;display_name:string}
export interface ClassTopic{topic:string;taught_on:string;summary:string}
export interface ClassDetail extends ClassSummary{learners:ClassLearner[];topics:ClassTopic[]}
export interface LearnerResult{learner_ref:string;display_name:string;attempted:boolean;completed:boolean;scaled:number|null}
export interface AgentLink{agent_issuer:string;agent_subject:string;label:string;linked_at:string}
export interface AssignmentResults{assignment_id:string;object_id:string;assigned_at:string;learner_count:number;attempted_count:number;learners:LearnerResult[]}
/** One learning object as the assign surface needs it — enough to render a tile and assign it. */
export interface AssignableObject{object_id:string;repository_id:string;title?:string;description?:string;kind?:string;duration?:string;status:string}
/** A repository this teacher belongs to, worn as a course label — same grouping the learner-facing catalogue uses. */
export interface Course{repository_id:string;name:string}
/** A published object another repository has opted in to marketplace discovery. */
export interface MarketplaceListing{object_id:string;title?:string;description?:string;kind?:string;duration?:string;publisher_name:string}
/** One of this teacher's own bookmarks — a marketplace listing they have chosen to make assignable. */
export interface MarketplaceImport{object_id:string;title?:string;description?:string;kind?:string;duration?:string;status:string;imported_at:string}

/** The roster accepts only identifiers that could round-trip through the identity provider, so a
 *  roster entry and that learner's own sign-in derive the same pseudonym. Enforced again server-side. */
export const LEARNER_REF=/^[A-Za-z\d._:-]{1,128}$/;

/**
 * Administration error copy.
 *
 * The administration area is reached by a teacher, not a developer: a bare `AGENT_LINK_TAKEN` or
 * `AUTHENTICATION_EXPIRED` on screen tells them nothing about what to do next. The codes remain the
 * contract with the API — this is only how they are said out loud.
 */
const adminErrorCopy:Record<string,string>={
 AUTHENTICATION_EXPIRED:'Your administration session has expired. Sign in again to continue.',
 ADMIN_AUDIT_DENIED:'Your account does not have teacher access to this area. Ask whoever administers your organisation’s accounts for the teacher role.',
 ADMIN_SIGN_IN_UNAVAILABLE:'No identity provider is configured for this environment, so the teacher area cannot sign you in.',
 ADMIN_REQUEST_INVALID:'Check the details you entered and try again.',
 AGENT_LINK_INVALID:'Check the issuer and subject. Both are required, and each must be 256 characters or fewer.',
 AGENT_LINK_TAKEN:'That assistant is already linked to another account.',
 AGENT_LINK_NOT_FOUND:'That assistant is not linked to your account.',
 CLASS_NOT_FOUND:'That class no longer exists. Refresh and try again.',
 CLASS_REQUEST_INVALID:'Check the class details and try again.',
 CLASS_EMPTY:'Add at least one learner to the class before assigning work.',
 LEARNER_REF_INVALID:'That learner identifier is not in a supported shape. Use letters, digits, and . _ : - only.',
 LEARNER_NOT_FOUND:'That learner is not in this class.',
 LEARNING_OBJECT_NOT_FOUND:'That marketplace listing is no longer available. Refresh and try again.',
};
export const adminErrorMessage=(code:string)=>adminErrorCopy[code]??`We could not complete that request (${code}).`;

type View='assign'|'classes'|'marketplace';
type ClassTab='roster'|'results'|'topics';

export function AdminWorkspace({config,onSignOut,onSignInAgain}:{config:Config;onSignOut:()=>void;
 /** Re-authenticates the teacher after the administration session expires. Defaults to the shared path: renewal where the provider allows it, a fresh sign-in otherwise. */
 onSignInAgain?:()=>Promise<void>}){
 const [view,setView]=useState<View>('assign');
 const [classTab,setClassTab]=useState<ClassTab>('roster');
 const [classes,setClasses]=useState<ClassSummary[]>([]);
 const [selected,setSelected]=useState<ClassDetail>();
 const [results,setResults]=useState<AssignmentResults[]>();
 const [objects,setObjects]=useState<AssignableObject[]>([]);
 const [courses,setCourses]=useState<Course[]>([]);
 const [links,setLinks]=useState<AgentLink[]>([]);
 const [marketplace,setMarketplace]=useState<MarketplaceListing[]>([]);
 const [imports,setImports]=useState<MarketplaceImport[]>([]);
 const [assignQuery,setAssignQuery]=useState('');
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);
 const [toast,setToast]=useState('');

 /** The activity the assign drawer is open for, and which of this teacher's classes are checked in it. */
 const [drawerObject,setDrawerObject]=useState<{object_id:string;title?:string}>();
 const [drawerClassIds,setDrawerClassIds]=useState<Set<string>>(new Set());

 /**
  * Expiry is a state of the workspace, not one more error message.
  *
  * The administration token is short-lived and nothing renews it, so a teacher who spends a few
  * minutes reading an assistant's issuer and subject off another screen comes back to a session that
  * has already expired: the next action — linking that assistant, typically — fails 401 with
  * AUTHENTICATION_EXPIRED. Reported as a bare code it looks like the assistant was rejected. So the
  * expired session is held separately, the work that hit it is kept, and signing in again replays it
  * rather than asking the teacher to retype what is still on screen.
  */
 const [expired,setExpired]=useState(false);
 const pending=useRef<(()=>Promise<void>)|undefined>(undefined);

 const fail=(e:unknown,work?:()=>Promise<void>)=>{
  const code=e instanceof ApiProblem?e.code:'UNKNOWN_ERROR';
  if(code==='AUTHENTICATION_EXPIRED'){
   // The token is spent; holding on to it only produces the same 401 on the next action.
   adminTokenStore.clear();
   pending.current=work;
   setExpired(true);
   setError('');
   return;
  }
  setError(adminErrorMessage(code));
 };
 /**
  * One action, one `run`. The work it is given must reach every request it makes: a `run` nested
  * inside another handles the failure itself and then returns normally, so the outer one treats a
  * request that expired as a success and clears the prompt it just raised. That is why the loads
  * below come in two forms — a raw `fetch*` that throws, composed freely inside an action, and a
  * `load*` that wraps exactly one of them for a handler that is the whole action.
  */
 const run=async(work:()=>Promise<void>)=>{setBusy(true);setError('');try{await work();setExpired(false)}catch(e){fail(e,work)}finally{setBusy(false)}};

 const signInAgain=async()=>{
  const work=pending.current;
  setBusy(true);setError('');
  try{
   await (onSignInAgain?onSignInAgain():adminSignInAgain(config));
   pending.current=undefined;
   setExpired(false);
   if(work)await work();
   await fetchEverything();
  }catch(e){fail(e,work)}finally{setBusy(false)}
 };

 const fetchClasses=async()=>{setClasses((await adminRequest<{items:ClassSummary[]}>(config,'classes')).items)};
 const fetchClass=async(classId:string)=>{
  setSelected(await adminRequest<ClassDetail>(config,`classes/${encodeURIComponent(classId)}`));
  setResults(undefined);
 };
 const fetchLinks=async()=>{setLinks((await adminRequest<{items:AgentLink[]}>(config,'agent-links')).items)};
 const fetchObjects=async()=>{
  setObjects((await adminRequest<{items:AssignableObject[]}>(config,'learning-objects')).items);
 };
 // Repositories this teacher belongs to, worn as "your courses" — the same grouping idea the
 // learner-facing catalogue uses (see catalogue.ts), fetched through the admin surface instead since
 // this workspace holds no learner session. Scoped server-side to the caller's own memberships.
 const fetchCourses=async()=>{
  setCourses((await adminRequest<{items:Course[]}>(config,'repositories')).items);
 };
 const fetchResults=async(classId:string)=>{
  setResults((await adminRequest<{items:AssignmentResults[]}>(config,`classes/${encodeURIComponent(classId)}/results`)).items);
 };
 const fetchMarketplace=async()=>{
  setMarketplace((await adminRequest<{items:MarketplaceListing[]}>(config,'marketplace')).items);
 };
 const fetchImports=async()=>{
  setImports((await adminRequest<{items:MarketplaceImport[]}>(config,'marketplace/imports')).items);
 };
 /** Everything the workspace shows, reloaded together after a fresh sign-in. */
 const fetchEverything=async()=>{await fetchClasses();await fetchLinks();await fetchObjects();await fetchCourses();await fetchMarketplace();await fetchImports()};

 const loadClasses=()=>run(fetchClasses);
 const openClass=(classId:string)=>run(()=>fetchClass(classId));
 const loadLinks=()=>run(fetchLinks);

 const linkAgent=(form:HTMLFormElement)=>run(async()=>{
  const data=new FormData(form);
  await adminRequest(config,'agent-links',{method:'POST',body:JSON.stringify({
   agent_issuer:String(data.get('agent_issuer')??'').trim(),
   agent_subject:String(data.get('agent_subject')??'').trim(),
   label:String(data.get('label')??'').trim()||undefined,
  })});
  form.reset();
  await fetchLinks();
 });

 const revokeAgent=(link:AgentLink)=>run(async()=>{
  await adminRequest(config,`agent-links/${encodeURIComponent(link.agent_issuer)}/${encodeURIComponent(link.agent_subject)}`,{method:'DELETE'});
  await fetchLinks();
 });

 useEffect(()=>{void run(fetchEverything)},[]);
 useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(''),4000);return()=>clearTimeout(timer)},[toast]);

 const createClass=(form:HTMLFormElement)=>run(async()=>{
  const data=new FormData(form);
  await adminRequest(config,'classes',{method:'POST',body:JSON.stringify({
   name:String(data.get('name')??''),
   year_group:String(data.get('year_group')??'')||undefined,
   subject:String(data.get('subject')??'')||undefined,
  })});
  form.reset();
  await fetchClasses();
 });

 const addLearner=(form:HTMLFormElement)=>run(async()=>{
  if(!selected)return;
  const data=new FormData(form);
  const learner_ref=String(data.get('learner_ref')??'').trim();
  if(!LEARNER_REF.test(learner_ref))throw new ApiProblem('LEARNER_REF_INVALID',crypto.randomUUID());
  await adminRequest(config,`classes/${encodeURIComponent(selected.class_id)}/learners`,{
   method:'POST',body:JSON.stringify({learners:[{learner_ref,display_name:String(data.get('display_name')??'').trim()}]}),
  });
  form.reset();
  await fetchClass(selected.class_id);
  await fetchClasses();
 });

 const removeLearner=(learnerRef:string)=>run(async()=>{
  if(!selected)return;
  await adminRequest(config,`classes/${encodeURIComponent(selected.class_id)}/learners/${encodeURIComponent(learnerRef)}`,{method:'DELETE'});
  await fetchClass(selected.class_id);
  await fetchClasses();
 });

 const addTopic=(form:HTMLFormElement)=>run(async()=>{
  if(!selected)return;
  const data=new FormData(form);
  await adminRequest(config,`classes/${encodeURIComponent(selected.class_id)}/topics`,{
   method:'POST',body:JSON.stringify({topics:[{
    topic:String(data.get('topic')??'').trim(),
    taught_on:String(data.get('taught_on')??''),
    summary:String(data.get('summary')??'').trim()||undefined,
   }]}),
  });
  form.reset();
  await fetchClass(selected.class_id);
 });

 const showResults=()=>run(async()=>{
  if(!selected)return;
  await fetchResults(selected.class_id);
 });

 /** Bookmarks a marketplace listing into this teacher's own assignable set. Nothing is copied — the
  *  object stays owned by its own repository; this only records the choice to treat it as theirs. */
 const importListing=(objectId:string)=>run(async()=>{
  await adminRequest(config,'marketplace/imports',{method:'POST',body:JSON.stringify({object_id:objectId})});
  await fetchImports();
 });

 const removeImport=(objectId:string)=>run(async()=>{
  await adminRequest(config,`marketplace/imports/${encodeURIComponent(objectId)}`,{method:'DELETE'});
  await fetchImports();
 });

 // -------------------------------------------------------------------------
 // The assign drawer: opened from a tile on the Assign work page, targets one or more of the
 // teacher's own classes. There is no way to target named individual learners within a class here —
 // the assignment API records who was in the class at the moment of assignment, not a hand-picked
 // subset of it, so the drawer offers exactly what it can deliver.
 // -------------------------------------------------------------------------
 const openDrawer=(object:{object_id:string;title?:string})=>{setDrawerObject(object);setDrawerClassIds(new Set())};
 const closeDrawer=()=>setDrawerObject(undefined);
 const toggleDrawerClass=(classId:string)=>setDrawerClassIds(current=>{
  const next=new Set(current);
  if(next.has(classId))next.delete(classId);else next.add(classId);
  return next;
 });
 const confirmAssign=()=>run(async()=>{
  if(!drawerObject||drawerClassIds.size===0)return;
  for(const classId of drawerClassIds){
   await adminRequest(config,`classes/${encodeURIComponent(classId)}/assignments`,{method:'POST',body:JSON.stringify({object_id:drawerObject.object_id})});
  }
  const count=drawerClassIds.size;
  setToast(`Assigned “${drawerObject.title??'this activity'}” to ${count===1?'1 class':`${count} classes`}.`);
  // The class currently open in Classes & results may be one of the targets — keep its results current.
  if(selected&&drawerClassIds.has(selected.class_id))await fetchResults(selected.class_id);
  closeDrawer();
 });

 const titleFor=(objectId:string)=>objects.find(o=>o.object_id===objectId)?.title??objectId;
 const importedObjectIds=new Set(imports.map(i=>i.object_id));

 // "Your courses": objects published in a repository this teacher belongs to, grouped by that
 // repository. This is curation, not enforcement — the assignment API does not itself scope by
 // repository — so an object from a repository the teacher does not belong to and has not
 // bookmarked from the marketplace simply never appears as a tile here.
 const ownRepositoryIds=new Set(courses.map(c=>c.repository_id.toLowerCase()));
 const matchesQuery=(title:string|undefined)=>!assignQuery.trim()||(title??'').toLowerCase().includes(assignQuery.trim().toLowerCase());
 const courseSections=courses
  .map(course=>({
   ...course,
   objects:objects.filter(o=>o.status==='PUBLISHED'&&o.repository_id.toLowerCase()===course.repository_id.toLowerCase()&&matchesQuery(o.title)),
  }))
  .filter(course=>course.objects.length>0);
 const importedTiles=imports.filter(i=>i.status==='PUBLISHED'&&matchesQuery(i.title));

 return <section className="teacher-shell">
  <nav className="teacher-rail" aria-label="Teacher workspace">
   <div className="teacher-rail-brand"><span className="teacher-rail-mark">L</span><div><strong>LORB</strong><span>Teacher workspace</span></div></div>
   <div className="teacher-rail-nav">
    <button className="teacher-rail-link" aria-current={view==='assign'} onClick={()=>setView('assign')}>Assign work</button>
    <button className="teacher-rail-link" aria-current={view==='classes'} onClick={()=>setView('classes')}>Classes &amp; results</button>
    <button className="teacher-rail-link" aria-current={view==='marketplace'} onClick={()=>setView('marketplace')}>Marketplace</button>
   </div>
   <div className="teacher-rail-foot">
    <button onClick={onSignOut}>Sign out of administration</button>
   </div>
  </nav>

  <div className="teacher-main">
   {expired&&<div role="alert" className="admin-error admin-expired">
    <p>{adminErrorMessage('AUTHENTICATION_EXPIRED')}</p>
    <button onClick={()=>void signInAgain()} disabled={busy}>Sign in again</button>
   </div>}
   {error&&!expired&&<p role="alert" className="admin-error">{error}</p>}

   {view==='assign'&&<section className="teacher-view">
    <div className="teacher-page-head">
     <div>
      <h1>Assign work</h1>
      <p className="lede">Browse by course and send an activity straight to one or more classes.</p>
     </div>
     <input type="search" placeholder="Search activities…" aria-label="Search activities" value={assignQuery} onChange={e=>setAssignQuery(e.target.value)}/>
    </div>

    {courseSections.map(course=><div className="teacher-course" key={course.repository_id}>
     <h2>{course.name}</h2>
     <div className="teacher-tiles">
      {course.objects.map(o=><article className="teacher-tile" key={o.object_id}>
       <span className="teacher-tile-kind">{o.kind??'activity'}</span>
       <h3>{o.title??'Untitled activity'}</h3>
       <p>{o.description??'No description is available.'}</p>
       {o.duration&&<p className="teacher-tile-meta">{o.duration}</p>}
       <button onClick={()=>openDrawer(o)} disabled={busy}>Assign</button>
      </article>)}
     </div>
    </div>)}

    {importedTiles.length>0&&<div className="teacher-course">
     <h2>From the marketplace</h2>
     <div className="teacher-tiles">
      {importedTiles.map(o=><article className="teacher-tile" key={o.object_id}>
       <span className="teacher-tile-kind">{o.kind??'activity'}</span>
       <h3>{o.title??'Untitled activity'}</h3>
       <p>{o.description??'No description is available.'}</p>
       {o.duration&&<p className="teacher-tile-meta">{o.duration}</p>}
       <button onClick={()=>openDrawer(o)} disabled={busy}>Assign</button>
      </article>)}
     </div>
    </div>}

    {courseSections.length===0&&importedTiles.length===0&&<p className="empty">
     {assignQuery?'Nothing matches that search.':'Nothing to assign yet — publish an activity, or add one from the Marketplace.'}
    </p>}
   </section>}

   {view==='classes'&&<section className="teacher-view">
    <div className="teacher-page-head">
     <div><h1>Classes &amp; results</h1><p className="lede">Manage rosters, add learners, and review how work is landing.</p></div>
    </div>

    <div className="teacher-classes-grid">
     <div className="teacher-panel">
      <h2>Your classes</h2>
      <ul className="class-list">
       {classes.map(c=><li key={c.class_id}>
        <button onClick={()=>{setClassTab('roster');void openClass(c.class_id)}} aria-current={selected?.class_id===c.class_id}>
         <strong>{c.name}</strong>
         <span>{[c.year_group,c.subject].filter(Boolean).join(' · ')||'No year group or subject'}</span>
         <span>{c.learner_count} {c.learner_count===1?'learner':'learners'}</span>
        </button>
       </li>)}
       {classes.length===0&&<li className="empty">No classes yet.</li>}
      </ul>
      <form onSubmit={e=>{e.preventDefault();void createClass(e.currentTarget)}}>
       <h3>Add a class</h3>
       <label>Name<input name="name" required maxLength={120}/></label>
       <label>Year group<input name="year_group" maxLength={40}/></label>
       <label>Subject<input name="subject" maxLength={80}/></label>
       <button type="submit" disabled={busy}>Create class</button>
      </form>
     </div>

     <div className="teacher-panel teacher-class-detail">
      {!selected&&<p className="empty">Choose a class to manage it.</p>}
      {selected&&<>
       <h2>{selected.name}</h2>
       <div className="teacher-tabs" role="tablist">
        <button role="tab" aria-selected={classTab==='roster'} onClick={()=>setClassTab('roster')}>Roster</button>
        <button role="tab" aria-selected={classTab==='results'} onClick={()=>setClassTab('results')}>Results</button>
        <button role="tab" aria-selected={classTab==='topics'} onClick={()=>setClassTab('topics')}>Recently taught</button>
       </div>

       {classTab==='roster'&&<div className="teacher-tab-panel">
        <p className="notice">Learner identifiers must match the identifier your identity provider issues for that learner, for example <code>9b-01</code>. A display name is shown to you only and never reaches a launch or an evidence statement.</p>
        <ul className="learner-list">
         {selected.learners.map(l=><li key={l.learner_ref}>
          <span>{l.display_name}</span>
          <code>{l.learner_ref}</code>
          <button onClick={()=>void removeLearner(l.learner_ref)} disabled={busy} aria-label={`Remove ${l.display_name}`}>Remove</button>
         </li>)}
         {selected.learners.length===0&&<li className="empty">No learners yet.</li>}
        </ul>
        <form onSubmit={e=>{e.preventDefault();void addLearner(e.currentTarget)}}>
         <label>Display name<input name="display_name" required maxLength={120}/></label>
         <label>Learner identifier<input name="learner_ref" required placeholder="9b-01"/></label>
         <button type="submit" disabled={busy}>Add learner</button>
        </form>
       </div>}

       {classTab==='results'&&<div className="teacher-tab-panel">
        <button onClick={()=>void showResults()} disabled={busy}>Refresh results</button>
        {results?.length===0&&<p className="empty">Nothing assigned to this class yet. Assign work from the Assign work page.</p>}
        {results?.map(assignment=><div key={assignment.assignment_id} className="results">
         <h4>{titleFor(assignment.object_id)}</h4>
         <p>{assignment.attempted_count} of {assignment.learner_count} started</p>
         <table>
          <thead><tr><th scope="col">Learner</th><th scope="col">Status</th><th scope="col">Score</th></tr></thead>
          <tbody>
           {assignment.learners.map(l=><tr key={l.learner_ref}>
            <td>{l.display_name}</td>
            <td>{l.completed?'Completed':l.attempted?'In progress':'Not started'}</td>
            <td>{l.scaled===null?'—':`${Math.round(l.scaled*100)}%`}</td>
           </tr>)}
          </tbody>
         </table>
        </div>)}
        {results===undefined&&<p className="empty">Press &ldquo;Refresh results&rdquo; to load them.</p>}
       </div>}

       {classTab==='topics'&&<div className="teacher-tab-panel">
        <ul className="topic-list">
         {selected.topics.map(t=><li key={`${t.topic}-${t.taught_on}`}>{t.taught_on} — {t.topic}</li>)}
         {selected.topics.length===0&&<li className="empty">No topics recorded. Agents use these to keep generated questions relevant.</li>}
        </ul>
        <form onSubmit={e=>{e.preventDefault();void addTopic(e.currentTarget)}}>
         <label>Topic<input name="topic" required maxLength={120}/></label>
         <label>Taught on<input name="taught_on" type="date" required/></label>
         <label>Summary<input name="summary" maxLength={600}/></label>
         <button type="submit" disabled={busy}>Record topic</button>
        </form>
       </div>}
      </>}
     </div>
    </div>

    <section className="agent-links">
     <h2>AI assistants</h2>
     <p className="notice">An assistant can only see the classes of the teacher who linked it. Until you add one here, it sees nothing at all.</p>
     <p className="notice">Ask the assistant &ldquo;what principal are you connecting as?&rdquo; and it will report both values exactly as LORB sees them. They must match character for character, the issuer&rsquo;s trailing slash included &mdash; a mismatch shows up as an empty class list rather than an error.</p>
     <ul className="link-list">
      {links.map(link=><li key={`${link.agent_issuer}|${link.agent_subject}`}>
       <span>{link.label||'Unlabelled assistant'}</span>
       <code className="link-issuer">{link.agent_issuer}</code>
       <code>{link.agent_subject}</code>
       <button onClick={()=>void revokeAgent(link)} disabled={busy} aria-label={`Revoke ${link.label||link.agent_subject}`}>Revoke</button>
      </li>)}
      {links.length===0&&<li className="empty">No assistants linked. Any assistant connecting to LORB currently sees no classes.</li>}
     </ul>
     <form onSubmit={e=>{e.preventDefault();void linkAgent(e.currentTarget)}}>
      <label>Label<input name="label" maxLength={120} placeholder="Claude on my laptop"/></label>
      <label>Issuer<input name="agent_issuer" required maxLength={256} placeholder="https://your-tenant.us.auth0.com/"/></label>
      <label>Subject<input name="agent_subject" required maxLength={256} placeholder="auth0|..."/></label>
      <button type="submit" disabled={busy}>Link assistant</button>
     </form>
    </section>
   </section>}

   {view==='marketplace'&&<section className="teacher-view">
    <div className="teacher-page-head">
     <div><h1>Marketplace</h1><p className="lede">Activities other repositories have opted in to sharing. Adding one bookmarks it into your own library — nothing is copied, and it becomes assignable to your classes from Assign work.</p></div>
    </div>
    <div className="teacher-tiles">
     {marketplace.map(item=><article className="teacher-tile" key={item.object_id}>
      <span className="teacher-tile-kind">{item.kind??'activity'}</span>
      <h3>{item.title??'Untitled activity'}</h3>
      <p>{item.description??'No description is available.'}</p>
      <p className="teacher-tile-meta">from {item.publisher_name}</p>
      {importedObjectIds.has(item.object_id)
       ?<button onClick={()=>void removeImport(item.object_id)} disabled={busy}>Remove from my library</button>
       :<button onClick={()=>void importListing(item.object_id)} disabled={busy}>Add to my library</button>}
     </article>)}
     {marketplace.length===0&&<p className="empty">No repository has listed anything on the marketplace yet.</p>}
    </div>
   </section>}
  </div>

  {drawerObject&&<>
   <div className="teacher-scrim" onClick={closeDrawer}/>
   <aside className="teacher-drawer" aria-label={`Assign ${drawerObject.title??'this activity'}`}>
    <button className="teacher-drawer-close" onClick={closeDrawer} aria-label="Close">×</button>
    <h2>{drawerObject.title??'Untitled activity'}</h2>
    <p className="lede">Choose one or more classes to assign this to.</p>
    <ul className="teacher-picker-list">
     {classes.map(c=><li key={c.class_id}>
      <label>
       <input type="checkbox" checked={drawerClassIds.has(c.class_id)} onChange={()=>toggleDrawerClass(c.class_id)}/>
       <span><strong>{c.name}</strong><span className="teacher-tile-meta">{c.learner_count} {c.learner_count===1?'learner':'learners'}</span></span>
      </label>
     </li>)}
     {classes.length===0&&<li className="empty">Create a class first, on Classes &amp; results.</li>}
    </ul>
    <p className="teacher-drawer-summary">{drawerClassIds.size===0?'No classes selected.':drawerClassIds.size===1?'1 class selected.':`${drawerClassIds.size} classes selected.`}</p>
    <button onClick={()=>void confirmAssign()} disabled={busy||drawerClassIds.size===0}>Assign</button>
   </aside>
  </>}

  {toast&&<div className="teacher-toast" role="status">{toast}</div>}
 </section>;
}
