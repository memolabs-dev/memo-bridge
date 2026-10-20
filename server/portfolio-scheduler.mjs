// Pure advisory scheduler: existing task_next remains the only assignment authority.
const rank={p0:0,p1:1,p2:2};
export function recommendWork(tasks,{activeIssues=[],blockedIssues=[],openPrIssues=[],now=Date.now(),maxAgeMs=6*3600000}={}){
 const active=new Set(activeIssues),blocked=new Set(blockedIssues),inReview=new Set(openPrIssues);
 const annotated=tasks.map(t=>{
  const stamp=Date.parse(t.observed_at??t.updated_at??'');
  const fresh=Number.isFinite(stamp)&&stamp<=now&&now-stamp<=maxAgeMs;
  const priority=rank[t.priority]===undefined?null:t.priority;
  let reason=!fresh?'stale_observation':!priority?'needs_priority':!t.ready?'not_ready':active.has(t.issue)?'claimed':blocked.has(t.issue)?'blocked':inReview.has(t.issue)?'pr_in_progress':'ready';
  return {...t,priority,eligible:reason==='ready',reason};
 }).sort((a,b)=>Number(b.eligible)-Number(a.eligible)||
  (rank[a.priority]??3)-(rank[b.priority]??3)||
  Date.parse(a.created_at??'')-Date.parse(b.created_at??'')||
  String(a.issue).localeCompare(String(b.issue)));
 return {next:annotated.find(x=>x.eligible)??null,ready:annotated.filter(x=>x.eligible),
   deferred:annotated.filter(x=>!x.eligible),complete:annotated.every(x=>x.reason!=='stale_observation'),
   note:'Advisory only: revalidate live claims with task_next before assigning'};
}
export function jobPlanRecommendation(report,capacity=1){
 if(!Number.isInteger(capacity)||capacity<0||capacity>100)throw new Error('invalid_capacity');
 const selected=[],projects=new Set();
 for(const task of report.ready??[]){
  if(selected.length>=capacity)break;
  // Avoid monopolizing capacity with a single repository before other projects.
  if(!projects.has(task.project)){selected.push(task);projects.add(task.project)}
 }
 if(selected.length<capacity)for(const task of report.ready??[]){
  if(selected.length>=capacity)break;
  if(!selected.includes(task))selected.push(task);
 }
 return {tasks:selected,requiresLiveClaim:true};
}
