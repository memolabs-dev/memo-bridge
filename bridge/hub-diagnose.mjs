// Pure, read-only classifier for redacted hub journal excerpts.
// The caller is responsible for reading an authorized, bounded log source.
const MAX_LINES = 5000;
const WINDOW = 10 * 60 * 1000;
const signatures = [
  ['auto_frozen', /(?:auto[_ -]?froz(?:en|e)|automatic(?:ally)?[_ -]?froz(?:en|e)|freeze[_ -]?automatic)/i],
  ['signature_refused', /(?:signature[_ -]?(?:refus|reject|invalid)|invalid[_ -]?signature)/i],
  ['rate_limited', /(?:rate[_ -]?limit|too many requests|429\b)/i],
  ['approval_expired', /(?:approval[_ -]?expir|expired[_ -]?approval)/i],
  ['telegram_poll_failed', /telegram_poll_failed/i],
  ['reconnection', /(?:reconnect(?:ed|ing|ion)?|agent[_ -]?connected|tunnel[_ -]?restored)/i]
];
const parseTime = line => {
  const match=/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/.exec(line);
  const n=match?Date.parse(match[0]):NaN;
  return Number.isFinite(n)?n:null;
};
export function diagnoseHubJournal(lines,{now=Date.now()}={}) {
  if (!Array.isArray(lines)) return {ok:false,error:'invalid_journal'};
  const input=lines.slice(-MAX_LINES).filter(x=>typeof x==='string').map(x=>x.slice(0,2048));
  const matches=[]; const counts={};
  for(const [index,line] of input.entries()) {
    const timestamp=parseTime(line);
    for(const [kind,re] of signatures) if(re.test(line)){
      counts[kind]=(counts[kind]??0)+1;
      // Never echo raw log lines: they may carry credentials, URLs or private messages.
      matches.push({kind,line:index+1,timestamp:timestamp===null?null:new Date(timestamp).toISOString()});
    }
  }
  const reconnections=matches.filter(x=>x.kind==='reconnection'&&x.timestamp!==null)
    .map(x=>Date.parse(x.timestamp)).sort((a,b)=>a-b);
  let flapCount=0;
  for(let i=0;i<reconnections.length;i++){
    let j=i;while(j<reconnections.length&&reconnections[j]-reconnections[i]<=WINDOW)j++;
    flapCount=Math.max(flapCount,j-i);
  }
  const recent = type => matches.filter(x=>x.kind===type).slice(-10);
  let conclusion='inconclusive';let evidence=[];let owner_action='Inspect the authenticated hub journal and agent status; no automatic corrective action.';
  if(counts.auto_frozen){conclusion='auto_frozen';evidence=recent('auto_frozen');owner_action='Review the freeze reason, current locks and outstanding approvals before an explicit authorized unfreeze.';}
  else if(flapCount>=6){conclusion='tunnel_flapping';evidence=recent('reconnection');owner_action='Inspect tunnel and agent connectivity; avoid automatic restarts without diagnosing the cause.';}
  else {
    const important=['signature_refused','rate_limited','approval_expired','telegram_poll_failed'];
    for(const kind of important) if(counts[kind]){conclusion=kind;evidence=recent(kind);break;}
  }
  if(!evidence.length)evidence=matches.slice(-5);
  return {ok:true,conclusion,evidence,counts,window_minutes:10,reconnections_in_window:flapCount,lines_inspected:input.length,owner_action};
}
