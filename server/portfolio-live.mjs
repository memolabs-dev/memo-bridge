import { rankPortfolio } from './portfolio.mjs';

// Live authenticated reads use the existing GitHub integration and its registered-repo scope.
// One hundred results is a possible truncation: never call that a complete inventory.
export async function livePortfolio({projects,github,allowedProjects=null,limit=100}) {
 const issues=[],prs=[],errors=[],observed=[];
 const allowed=allowedProjects===null?null:new Set(allowedProjects);
 const candidates=(projects??[]).filter(p=>p.kind==='repo'&&p.available&&(!allowed||allowed.has(p.name)));
 for(const project of candidates) {
  const origin=await github.projectRepo(project.name).catch(()=>null);
  if(!origin){errors.push({project:project.name,error:'origin_unavailable'});continue}
  const resolved=await github.resolveRepo(origin).catch(()=>null);
  if(!resolved?.ok){errors.push({project:project.name,error:resolved?.error??'repo_unavailable'});continue}
  const repo=resolved.repo;
  let resultIssue, resultPR;
  try{[resultIssue,resultPR]=await Promise.all([
   github.portfolioPages ? github.portfolioPages(repo,{kind:'issues'}) : github.issues(repo,{state:'open',limit}),
   github.portfolioPages ? github.portfolioPages(repo,{kind:'pulls'}) : github.pullRequests(repo,{state:'open',limit})
  ])}catch{errors.push({project:project.name,repo:repo.full,error:'github_unavailable'});continue}
  if(!resultIssue?.ok||!resultPR?.ok){errors.push({project:project.name,repo:repo.full,error:resultIssue?.error??resultPR?.error??'github_unavailable'});continue}
  if(!github.portfolioPages && (resultIssue.count>=limit||resultPR.count>=limit))errors.push({project:project.name,repo:repo.full,error:'possibly_truncated'});
  for(const i of (resultIssue.items??resultIssue.issues)??[]){
   const labels=i.labels??[];
   const priority=['p0','p1','p2'].find(p=>labels.includes('priority:'+p))??null;
   issues.push({repo:repo.full,number:i.number,title:i.title,url:i.url,state:i.state,priority,
    ready:labels.includes('agent:ready'),blocked:labels.includes('blocked')||labels.includes('status:blocked'),
    claimed:labels.includes('agent:claimed'),created_at:i.created_at??i.updated_at,labels});
  }
  for(const p of (resultPR.items??resultPR.pull_requests)??[])prs.push({repo:repo.full,number:p.number,title:p.title,url:p.url,
   state:p.state,draft:p.draft,created_at:p.updated_at,merged_at:null});
  observed.push({project:project.name,repo:repo.full,issue_count:(resultIssue.items??resultIssue.issues??[]).length,pr_count:(resultPR.items??resultPR.pull_requests??[]).length});
 }
 return {...rankPortfolio({issues,prs,errors}),observed_projects:observed,
  unobserved_projects:candidates.length-observed.length,scope:'registered_available_repositories_only'};
}
