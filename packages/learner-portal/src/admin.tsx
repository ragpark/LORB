// The teacher-facing roster administration area: classes, learners, assignments and results.
//
// A learner is identified here by the identifier their identity provider issues, and never paired
// with their LORB pseudonym in storage — results are matched by recomputing the pseudonym at read
// time, so no standing re-identification table exists. See 004_roster.sql.

import {useEffect,useState} from 'react';
import {adminRequest} from './admin-api.js';
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

/** The roster accepts only identifiers that could round-trip through the identity provider, so a
 *  roster entry and that learner's own sign-in derive the same pseudonym. Enforced again server-side. */
export const LEARNER_REF=/^[A-Za-z\d._:-]{1,128}$/;

export function AdminWorkspace({config,onSignOut}:{config:Config;onSignOut:()=>void}){
 const [classes,setClasses]=useState<ClassSummary[]>([]);
 const [selected,setSelected]=useState<ClassDetail>();
 const [results,setResults]=useState<AssignmentResults[]>();
 const [objects,setObjects]=useState<Array<{object_id:string;title?:string;status:string}>>([]);
 const [links,setLinks]=useState<AgentLink[]>([]);
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);

 const fail=(e:unknown)=>setError(e instanceof ApiProblem?e.code:'UNKNOWN_ERROR');
 const run=async(work:()=>Promise<void>)=>{setBusy(true);setError('');try{await work()}catch(e){fail(e)}finally{setBusy(false)}};

 const loadClasses=()=>run(async()=>{setClasses((await adminRequest<{items:ClassSummary[]}>(config,'classes')).items)});
 const openClass=(classId:string)=>run(async()=>{
  setSelected(await adminRequest<ClassDetail>(config,`classes/${encodeURIComponent(classId)}`));
  setResults(undefined);
 });

 const loadLinks=()=>run(async()=>{setLinks((await adminRequest<{items:AgentLink[]}>(config,'agent-links')).items)});

 const linkAgent=(form:HTMLFormElement)=>run(async()=>{
  const data=new FormData(form);
  await adminRequest(config,'agent-links',{method:'POST',body:JSON.stringify({
   agent_issuer:String(data.get('agent_issuer')??'').trim(),
   agent_subject:String(data.get('agent_subject')??'').trim(),
   label:String(data.get('label')??'').trim()||undefined,
  })});
  form.reset();
  await loadLinks();
 });

 const revokeAgent=(link:AgentLink)=>run(async()=>{
  await adminRequest(config,`agent-links/${encodeURIComponent(link.agent_issuer)}/${encodeURIComponent(link.agent_subject)}`,{method:'DELETE'});
  await loadLinks();
 });

 useEffect(()=>{void loadClasses();void loadLinks();void run(async()=>{
  setObjects((await adminRequest<{items:Array<{object_id:string;title?:string;status:string}>}>(config,'learning-objects')).items);
 })},[]);

 const createClass=(form:HTMLFormElement)=>run(async()=>{
  const data=new FormData(form);
  await adminRequest(config,'classes',{method:'POST',body:JSON.stringify({
   name:String(data.get('name')??''),
   year_group:String(data.get('year_group')??'')||undefined,
   subject:String(data.get('subject')??'')||undefined,
  })});
  form.reset();
  await loadClasses();
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
  await openClass(selected.class_id);
  await loadClasses();
 });

 const removeLearner=(learnerRef:string)=>run(async()=>{
  if(!selected)return;
  await adminRequest(config,`classes/${encodeURIComponent(selected.class_id)}/learners/${encodeURIComponent(learnerRef)}`,{method:'DELETE'});
  await openClass(selected.class_id);
  await loadClasses();
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
  await openClass(selected.class_id);
 });

 const assign=(objectId:string)=>run(async()=>{
  if(!selected)return;
  await adminRequest(config,`classes/${encodeURIComponent(selected.class_id)}/assignments`,{method:'POST',body:JSON.stringify({object_id:objectId})});
  await showResults();
 });

 const showResults=()=>run(async()=>{
  if(!selected)return;
  setResults((await adminRequest<{items:AssignmentResults[]}>(config,`classes/${encodeURIComponent(selected.class_id)}/results`)).items);
 });

 const titleFor=(objectId:string)=>objects.find(o=>o.object_id===objectId)?.title??objectId;

 return <section className="admin">
  <div className="admin-head">
   <h1>Classes and learners</h1>
   <button onClick={onSignOut}>Sign out of administration</button>
  </div>
  <p className="notice">Learner identifiers must match the identifier your identity provider issues for that learner, for example <code>9b-01</code>. A display name is shown to you only and never reaches a launch or an evidence statement.</p>
  {error&&<p role="alert" className="admin-error">{error}</p>}

  <div className="admin-columns">
   <div>
    <h2>Your classes</h2>
    <ul className="class-list">
     {classes.map(c=><li key={c.class_id}>
      <button onClick={()=>void openClass(c.class_id)} aria-current={selected?.class_id===c.class_id}>
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

   <div>
    {!selected&&<p className="empty">Choose a class to manage its learners.</p>}
    {selected&&<>
     <h2>{selected.name}</h2>

     <h3>Learners</h3>
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

     <h3>Recently taught</h3>
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

     <h3>Assign an activity</h3>
     <ul className="assign-list">
      {objects.filter(o=>o.status==='PUBLISHED').map(o=><li key={o.object_id}>
       <span>{o.title??'Untitled activity'}</span>
       <button onClick={()=>void assign(o.object_id)} disabled={busy||selected.learners.length===0}>Assign to class</button>
      </li>)}
     </ul>
     {selected.learners.length===0&&<p className="empty">Add a learner before assigning work.</p>}

     <h3>Results</h3>
     <button onClick={()=>void showResults()} disabled={busy}>Refresh results</button>
     {results?.length===0&&<p className="empty">Nothing assigned to this class yet.</p>}
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
 </section>;
}

/** Development sign-in for the administration area, asking for the administrator role. */
export async function adminSignIn(config:Config,subject:string):Promise<void>{
 const response=await fetch(config.developmentLoginUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({subject,role:'admin'})});
 if(!response.ok)throw new ApiProblem('AUTHENTICATION_EXPIRED',crypto.randomUUID());
 adminTokenStore.set((await response.json() as {access_token:string}).access_token);
}
