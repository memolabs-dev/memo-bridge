// Read-only portfolio model. Sources are injected: does not bypass existing GitHub scopes.
// Each fetchPage({repo,kind,page,perPage}) returns {items,hasNext}; stale/error states are explicit.
const levels = ['p0','p1','p2'];
export function summarizeIssue(issue, repo) {
  const labels = (issue.labels ?? []).map(x => typeof x === 'string' ? x : x.name).filter(Boolean);
  const priority = levels.find(x => labels.includes('priority:'+x) || labels.includes(x)) ?? null;
  const ready = labels.includes('agent:ready');
  return { kind:'issue',repo,number:issue.number,title:issue.title,url:issue.html_url ?? issue.url,
    priority,ready,labels,state:issue.state,created_at:issue.created_at,
    blocked:labels.some(x=>x==='blocked'||x==='status:blocked'),claimed:labels.some(x=>x==='agent:claimed'||x==='status:in-progress') };
}
export function summarizePR(pr, repo) {
  return {kind:'pr',repo,number:pr.number,title:pr.title,url:pr.html_url ?? pr.url,
    state:pr.state,draft:Boolean(pr.draft),created_at:pr.created_at,merged_at:pr.merged_at ?? null};
}
export function rankPortfolio({issues,prs,errors=[]}) {
  const prsByRepo=new Map();
  for(const pr of prs){if(!prsByRepo.has(pr.repo))prsByRepo.set(pr.repo,[]);prsByRepo.get(pr.repo).push(pr)}
  const queue=issues.filter(x=>x.state==='open').map(issue=>{
    const nearby=(prsByRepo.get(issue.repo)??[]).filter(pr=>
      new RegExp('(?:#'+issue.number+'\\b|(?:closes|fixes|resolves)\\s+#?'+issue.number+'\\b)','i').test(pr.title??''));
    const openPR=nearby.some(x=>x.state==='open');
    const eligible=issue.ready&&Boolean(issue.priority)&&!issue.blocked&&!issue.claimed&&!openPR;
    const reason=!issue.priority?'needs_priority':!issue.ready?'not_agent_ready':issue.blocked?'blocked':
      issue.claimed?'claimed':openPR?'pr_in_progress':'ready';
    return {...issue,related_prs:nearby.map(x=>x.number),eligible,reason};
  }).sort((a,b)=> (levels.indexOf(a.priority)<0?3:levels.indexOf(a.priority))-
                         (levels.indexOf(b.priority)<0?3:levels.indexOf(b.priority)) ||
                         Number(b.eligible)-Number(a.eligible) ||
                         Date.parse(a.created_at??'')-Date.parse(b.created_at??'')||
                         a.repo.localeCompare(b.repo)||a.number-b.number);
  return {snapshot_at:new Date().toISOString(),complete:errors.length===0,
    totals:{open_issues:queue.length,open_prs:prs.filter(x=>x.state==='open').length,
      ready:queue.filter(x=>x.eligible).length,needs_triage:queue.filter(x=>x.reason==='needs_priority').length},
    next:queue.find(x=>x.eligible)??null,queue,errors};
}
export async function collectPortfolio(repositories, fetchPage, {perPage=100,maxPages=20}={}) {
  const issues=[],prs=[],errors=[];
  const repos=[...new Set(repositories)].filter(x=>/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(x)).sort();
  for(const repo of repos) for(const kind of ['issues','pulls']) {
    for(let page=1;page<=maxPages;page++) {
      let result;
      try {result=await fetchPage({repo,kind,page,perPage})}
      catch(e){errors.push({repo,kind,page,error:String(e?.message??e)});break}
      if(!result||!Array.isArray(result.items)){errors.push({repo,kind,page,error:'invalid_response'});break}
      for(const item of result.items){
        if(kind==='issues'&&!item.pull_request)issues.push(summarizeIssue(item,repo));
        if(kind==='pulls')prs.push(summarizePR(item,repo));
      }
      if(result.hasNext===false||result.items.length<perPage)break;
      if(page===maxPages)errors.push({repo,kind,page,error:'page_limit_reached'});
    }
  }
  return rankPortfolio({issues,prs,errors});
}
