import { recommendWork, jobPlanRecommendation } from './portfolio-scheduler.mjs';

// Bridge existing task listing to advisory scheduling. Claiming belongs only to
// existing task_next/task_claim with live lease fencing; never cache a claim.
export function planFromTaskList(taskList, observations, { now = Date.now(), capacity = 1 } = {}) {
 if (!taskList?.ok || !Array.isArray(taskList.tasks)) {
  return { ok: false, error: 'task_list_unavailable', tasks: [] };
 }
 const rows = taskList.tasks.map(t => ({
  issue: t.issue, project: t.project, title: t.title, priority: t.priority,
  ready: (t.labels??[]).includes('agent:ready'), updated_at: t.observed_at ?? taskList.observed_at ?? null,
  created_at: t.created_at, url: t.url
 }));
 // A timestamp supplied by the consumer must be an authenticated observation time,
 // not the timestamp when an Issue was last edited.
 const ranked = recommendWork(rows, { now,
   activeIssues: observations.activeIssues??[],
   blockedIssues: observations.blockedIssues??[],
   openPrIssues: observations.openPrIssues??[] });
 return { ok: true, ...ranked, plan: jobPlanRecommendation(ranked,capacity),
  requires_task_next_revalidation:true };
}
export async function claimRecommended(plan,{taskNext,projectAllowed=()=>true}={}) {
 if (!plan?.ok || !plan.next) return { ok:false,error:'no_eligible_task' };
 if (typeof taskNext !== 'function') return { ok:false,error:'claim_handler_required' };
 if (!projectAllowed(plan.next.project)) return { ok:false,error:'project_not_allowed' };
 // taskNext picks from the live ledger and may return a different Issue.
 const result=await taskNext({project:plan.next.project});
 if(!result?.ok)return { ok:false,error:result?.error??'task_next_failed' };
 return { ...result, advisory_issue:plan.next.issue,
  selected_by_live_ledger:result.issue??null,
  same_as_recommendation:result.issue===plan.next.issue };
}
