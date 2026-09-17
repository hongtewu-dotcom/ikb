// Admission validates evidence identity and coverage. Semantic judgments belong
// to the main maintainer; a machine check must never invent those judgments.
import { readFileSync, writeFileSync, renameSync, existsSync, lstatSync, readdirSync, mkdirSync, unlinkSync, realpathSync } from 'node:fs';
import { resolve, relative, join, isAbsolute, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseCardMarkdown, isActiveCardEntry, normalize } from '../mcp/ikb-cards-core.mjs';

const REPO = resolve(new URL('..', import.meta.url).pathname);
export const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (field, message) => { throw new Error(`${field}: ${message}`); };
const need = (v, field) => { if(typeof v!=='string'||!v.trim()) fail(field,'nonempty string required');return v; };
function read(path) { need(path,'reference');if(!isAbsolute(path)||!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())fail('reference','absolute regular file required');return readFileSync(path,'utf8'); }
const json = path => JSON.parse(read(path));
function inside(root,path) { const rel=relative(resolve(root),resolve(path));if(rel==='..'||rel.startsWith('../')||isAbsolute(rel))fail('path','outside workspace');return resolve(path); }
function save(path,value) { mkdirSync(dirname(path),{recursive:true});const tmp=`${path}.${randomUUID()}.tmp`;writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(tmp,path); }
function library(root) { const paths=[];function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){if(e.isSymbolicLink())fail('cards','symlink forbidden');if(!isActiveCardEntry(e))continue;const p=join(dir,e.name);if(e.isDirectory())walk(p);else paths.push(p);}}for(const scope of ['work','common'])walk(join(root,scope));return paths; }
export function planIdentity(plan,{operations}={}) {
 return hash(JSON.stringify({cardsRoot:resolve(plan.cardsRoot),requestId:plan.requestId??null,intakeRoot:plan.intakeRoot??null,authorizationBasis:plan.authorizationBasis,changes:plan.changes.map(c=>{
  const op=operations?.find(o=>o.cardId===c.cardId&&o.action===c.action&&o.path===c.path);
  if(operations&&!op)fail('publication','missing operation snapshot');
  return {cardId:c.cardId,action:c.action,path:resolve(c.path),knowledgeKind:c.knowledgeKind,before:op?(op.before===null?null:hash(op.before)):(c.oldPath===null?null:hash(read(c.oldPath))),after:op?(op.after===null?null:hash(op.after)):(c.newPath===null?null:hash(read(c.newPath)))};
 })}));
}
function snapshot(ref,refs){const path=resolve(ref);const value=read(path);refs.set(path,{path,hash:hash(value)});return value;}
function validateRequestAuthorization(plan) {
 if(!plan.requestId)return;
 const intake=resolve(need(plan.intakeRoot,'intakeRoot'));
 const requestPath=inside(join(intake,'requests'),join(intake,'requests',plan.requestId,'request.json'));
 const r=json(requestPath);
 if(r.requestId!==plan.requestId||r.kind!=='update')fail('request','explicit update authorization required');
 if(resolve(r.cardsRoot)!==resolve(plan.cardsRoot))fail('request','wrong active library');
 if(plan.changes.length!==1)fail('request','one explicitly requested knowledge object required');
 const c=plan.changes[0],target=r.target??null;
 const id=target?.cardId??r.targetCardId;
 if(id&&(c.cardId!==id||c.action!=='modify'))fail('request','outside requested card/action');
 if(!id&&c.action!=='add')fail('request','new topic authorizes add only');
 if(target?.path&&resolve(target.path)!==resolve(c.path))fail('request','wrong target path');
 if(target?.contentHash&&hash(read(c.oldPath))!==target.contentHash)fail('request','target changed since request; explicit rebase required');
 if(c.knowledgeKind!=='normal')fail('request','principle requires specific confirmation');
 return {request:r,requestPath};
}

function validateTrial(workspace,plan,t,refs){
 const card=plan.changes.find(c=>c.cardId===t.cardId);if(!card)fail('trials.cardId','not in changes');
 if(!['positive','negative'].includes(t.kind))fail('trials.kind','positive or negative required');
 need(t.question,'trials.question');need(t.judgment,'trials.judgment');if(t.accepted!==true)fail('trials.accepted','main review required');
 const search=JSON.parse(snapshot(inside(workspace,t.searchRef),refs));
 if(search.schema!=='ikb-card-search-result-v1'||search.scope!=='work'||search.queryHash!==hash(normalize(t.question))||!Array.isArray(search.items))fail('trials.search','wrong query/scope/schema');
 const binding=JSON.parse(snapshot(inside(workspace,t.bindingRef),refs));
 const trialRoot=inside(workspace,need(t.cardsRoot,'trials.cardsRoot'));
 if(realpathSync(binding.root)!==realpathSync(trialRoot)||binding.scope!=='work'||!Array.isArray(binding.cards))fail('trials.binding','wrong isolated root/scope');
 for(const item of search.items){const b=binding.cards.find(([id])=>id===item.cardId)?.[1];if(!b||b.path!==item.path||b.contentHash!==item.contentHash)fail('trials.binding','search item mismatch');}
 const rel=relative(plan.cardsRoot,card.path),staged=join(trialRoot,rel);
 if(card.action==='archive'){if(existsSync(staged))fail('trials','archived card still staged');}
 else if(hash(read(staged))!==hash(read(card.newPath)))fail('trials','candidate changed since trial');
 const output=snapshot(inside(workspace,t.outputRef),refs);if(!output.trim())fail('trials.output','empty consumer answer');
 if(t.kind==='negative'||card.action==='archive'){
  if(search.items.some(i=>i.cardId===card.cardId))fail('trials.negative','target recalled');
  if(t.getRef)fail('trials.negative','negative does not require a target get; preserve search only');
 }else{
  if(!search.items.slice(0,5).some(i=>i.cardId===card.cardId))fail('trials.positive','target not in first five');
  const g=JSON.parse(snapshot(inside(workspace,need(t.getRef,'trials.getRef')),refs));
  const item=search.items.find(i=>i.cardId===card.cardId);
  if(g.schema!=='ikb-card-read-result-v1'||g.retrievalId!==search.retrievalId||g.card?.cardId!==card.cardId||g.card.path!==item.path||g.card.contentHash!==item.contentHash||hash(g.card.markdown)!==item.contentHash||g.card.markdown!==read(staged))fail('trials.get','raw search/get/content identity mismatch');
 }
 return {cardId:t.cardId,kind:t.kind,question:t.question};
}

export function createAdmission(workspace,plan,assessmentPath,{checkOnly=false,runRegression}={}){
 workspace=resolve(workspace);if(plan.schema!=='ikb-approved-publication-v2')fail('schema','v2 required; legacy envelopes cannot publish');
 const requestBinding=validateRequestAuthorization(plan);
 const refs=new Map(),a=JSON.parse(snapshot(inside(workspace,assessmentPath),refs));
 if(requestBinding)snapshot(requestBinding.requestPath,refs);
 if(a.schema!=='ikb-content-review-v1'||a.accepted!==true)fail('assessment','main content review required');
 for(const role of ['author','reviewer','consumer']){need(a[role]?.sessionRef,role+'.sessionRef');snapshot(inside(workspace,need(a[role]?.evidenceRef,role+'.evidenceRef')),refs);}
 if(new Set(['author','reviewer','consumer'].map(role=>a[role].sessionRef)).size!==3)fail('roles','author, main reviewer and consumer must be independent sessions');
 if(a.reviewer.role!=='main')fail('reviewer','main Agent required');
 if(!Array.isArray(a.changes)||a.changes.length!==plan.changes.length)fail('assessment.changes','exact changed cards required');
 if(!Array.isArray(a.sources)||!a.sources.length)fail('sources','claim-linked source evidence required');
 for(const s of a.sources){need(s.claim,'sources.claim');snapshot(s.reference,refs);}
 const auth=plan.authorizationBasis;if(!auth)fail('authorizationBasis','required');snapshot(auth.reference,refs);
 for(const c of plan.changes){
  if(c.knowledgeKind!=='normal')fail('knowledgeKind','principle publication remains gated separately');
  const reviewed=a.changes.filter(x=>x.cardId===c.cardId);if(reviewed.length!==1)fail('assessment','each changed card must be reviewed once');
  const r=reviewed[0];if(r.verdict!=='accept'||r.knowledgeKind!=='normal')fail('assessment','normal accepted review required');
  for(const f of ['oldNewDiff','sourceAssessment','classificationReason'])need(r[f],f);
  const conflict=r.conflicts;
  if(!conflict||!['clear','resolved'].includes(conflict.verdict)||!Array.isArray(conflict.checkedCards)||!Array.isArray(conflict.searchRefs)||!conflict.searchRefs.length)fail('conflicts','search and related-card inspection required');
  need(conflict.rationale,'conflicts.rationale');
  for(const p of conflict.checkedCards)snapshot(p,refs);
  for(const p of conflict.searchRefs){
   const s=JSON.parse(snapshot(inside(workspace,p),refs));if(s.schema!=='ikb-card-search-result-v1'||s.scope!=='work'||!Array.isArray(s.items))fail('conflicts','raw work search required');
   for(const item of s.items.slice(0,5)){
    const inspected=conflict.checkedCards.some(path=>realpathSync(path)===realpathSync(item.path));
    const excluded=(conflict.excluded??[]).find(x=>x.cardId===item.cardId&&typeof x.reason==='string'&&x.reason.trim());
    if(!inspected&&!excluded)fail('conflicts','recalled related card needs inspection or reasoned exclusion: '+item.cardId);
   }
  }
  if(c.newPath!==null){const md=read(c.newPath);const parsed=parseCardMarkdown(md,c.path,{retrievalPolicy:'entries'});if(parsed.cardId!==c.cardId)fail('cardId','mismatch');if(!/^updated_at: \d{4}-\d{2}-\d{2}$/m.test(md))fail('updated_at','date required');}
 }
 if(!Array.isArray(a.trials))fail('trials','required');
 const cases=a.trials.map(t=>validateTrial(workspace,plan,t,refs));
 if(requestBinding)for(const [field,kind] of [['positiveQueries','positive'],['negativeQueries','negative']])for(const question of requestBinding.request.acceptance?.[field]??[]){
  if(!cases.some(t=>t.cardId===plan.changes[0].cardId&&t.kind===kind&&t.question===question))fail('request.acceptance','missing original '+kind+' question: '+question);
 }
 for(const c of plan.changes){const cs=cases.filter(t=>t.cardId===c.cardId);if(new Set(cs.filter(t=>t.kind==='positive').map(t=>t.question)).size<2||!cs.some(t=>t.kind==='negative'))fail('trials','each card needs two distinct positives and a nearby negative');}
 // Run the actual shared recall regression against the complete staged library.
 const roots=new Set(a.trials.map(t=>resolve(t.cardsRoot)));if(roots.size!==1)fail('trials','one complete isolated library required');
 const trialRoot=[...roots][0];
 if(checkOnly)return {cases,reviewer:a.reviewer,evidence:[...refs.values()],trialRoot};
 const live=new Map(library(plan.cardsRoot).map(p=>[relative(plan.cardsRoot,p),hash(read(p))]));
 for(const c of plan.changes){const rel=relative(plan.cardsRoot,c.path);if(c.action==='archive')live.delete(rel);else live.set(rel,hash(read(c.newPath)));}
 const staged=new Map(library(trialRoot).map(p=>[relative(trialRoot,p),hash(read(p))]));
 if(live.size!==staged.size||[...live].some(([p,h])=>staged.get(p)!==h))fail('trials','isolated work/common library differs from approved projection');
 const regression=runRegression?runRegression(trialRoot):spawnSync(process.execPath,[join(REPO,'tests/recall-test.mjs'),'--scope','work'],{encoding:'utf8',env:{...process.env,IKB_CARDS_ROOT:trialRoot,IKB_RETRIEVAL_POLICY:'entries'},maxBuffer:8*1024*1024});
 const regressionPath=join(workspace,'admission-recall.log');writeFileSync(regressionPath,(regression.stdout??'')+(regression.stderr??''),{mode:0o600});
 if(regression.error||regression.status!==0)fail('regression',`recall-test failed; ${regressionPath}`);
 snapshot(regressionPath,refs);
 const receipt={schema:'ikb-admission-v1',ok:true,createdAt:new Date().toISOString(),planHash:planIdentity(plan),assessmentRef:resolve(assessmentPath),evidence:[...refs.values()],cases,roles:a.reviewer,requestId:plan.requestId??null,regression:{exitCode:0,outputRef:regressionPath,outputHash:hash(read(regressionPath)),cardsRoot:trialRoot,policy:'entries',scope:'work',command:'tests/recall-test.mjs --scope work'}};
 const admissionPath=join(workspace,'admission.json');save(admissionPath,receipt);
 const admitted={...plan,changes:plan.changes.map(c=>({...c,admissionRef:admissionPath}))};save(join(workspace,'admitted-plan.json'),admitted);
 return {ok:true,admissionPath,planPath:join(workspace,'admitted-plan.json')};
}

export function validateAdmission(workspace,plan){
 if(plan.schema!=='ikb-approved-publication-v2')fail('schema','v2 admission required; legacy publication is read-only');
 validateRequestAuthorization(plan);
 const paths=new Set(plan.changes.map(c=>inside(workspace,need(c.admissionRef,'admissionRef'))));if(paths.size!==1)fail('admissionRef','one batch admission required');
 const receipt=json([...paths][0]);if(receipt.schema!=='ikb-admission-v1'||receipt.ok!==true||receipt.planHash!==planIdentity(plan))fail('admission','missing or stale exact-diff admission');
 if(!Array.isArray(receipt.evidence)||!receipt.evidence.length||!receipt.regression||receipt.regression.exitCode!==0)fail('admission','evidence and regression required');
 const regression=receipt.regression;
 if(regression.policy!=='entries'||regression.scope!=='work'||regression.command!=='tests/recall-test.mjs --scope work'||regression.outputRef!==resolve(workspace,'admission-recall.log')||hash(read(regression.outputRef))!==regression.outputHash||!receipt.evidence.some(e=>e.path===regression.outputRef&&e.hash===regression.outputHash))fail('regression','bound actual regression log required');
 for(const e of receipt.evidence)if(hash(read(e.path))!==e.hash)fail('admission','evidence changed since review: '+e.path);
 const rechecked=createAdmission(workspace,plan,receipt.assessmentRef,{checkOnly:true});
 if(realpathSync(regression.cardsRoot)!==realpathSync(rechecked.trialRoot))fail('regression','wrong isolated root');
 if(JSON.stringify(rechecked.cases)!==JSON.stringify(receipt.cases)||JSON.stringify(rechecked.reviewer)!==JSON.stringify(receipt.roles))fail('admission','receipt differs from validated assessment');
 for(const e of rechecked.evidence)if(!receipt.evidence.some(saved=>saved.path===e.path&&saved.hash===e.hash))fail('admission','missing bound assessment evidence');
 return receipt;
}

export function finalizePublication(workspace,plan,{additionalCases=[]}={}){
 try{return finalizePublishedSnapshots(workspace,plan,additionalCases);}catch(error){const result={schema:'ikb-final-verification-v1',ok:false,requestId:plan.requestId??null,failures:[{error:error.message}],completedAt:new Date().toISOString()};save(join(resolve(workspace),'final-verification.json'),result);return result;}
}
function finalizePublishedSnapshots(workspace,plan,additionalCases){
 workspace=resolve(workspace);const receipt=json(inside(workspace,plan.changes[0].admissionRef));
 if(receipt.schema!=='ikb-admission-v1'||receipt.ok!==true)fail('finalize','invalid admission');
 const publication=json(join(workspace,'publication-result.json'));
 if(publication.ok!==true||publication.status!=='success'||publication.planHash!==receipt.planHash||publication.requestId!==(plan.requestId??null)||resolve(publication.cardsRoot)!==resolve(plan.cardsRoot)||plan.changes.some(c=>!publication.written?.includes(c.path)))fail('finalize','successful matching publication required');
 const ops=publication.operations;
 if(!Array.isArray(ops)||ops.length!==plan.changes.length||ops.some(o=>!plan.changes.some(c=>c.cardId===o.cardId&&c.path===o.path&&c.action===o.action)||(o.after===null?o.afterHash!==null:hash(o.after)!==o.afterHash)||(o.before===null?o.beforeHash!==null:hash(o.before)!==o.beforeHash)))fail('finalize','invalid immutable publication snapshots');
 if(planIdentity(plan,{operations:ops})!==publication.planHash)fail('finalize','snapshot does not match admitted plan');
 if(!Array.isArray(additionalCases)||additionalCases.some(t=>!ops.some(c=>c.cardId===t.cardId)||!['positive','negative'].includes(t.kind)||typeof t.question!=='string'||!t.question.trim()))fail('additionalCases','valid additive cases for published cards required');
 const readbacks=[],failures=[];let requestedCases=[];
 if(plan.requestId)try{
  const requestPath=inside(join(plan.intakeRoot,'requests'),join(plan.intakeRoot,'requests',plan.requestId,'request.json'));
  const request=json(requestPath);
  if(request.requestId!==plan.requestId||request.kind!=='update')throw Error('request identity mismatch');
  const bound=receipt.evidence.find(e=>resolve(e.path)===resolve(requestPath));
  if(bound&&hash(read(requestPath))!==bound.hash)throw Error('request evidence changed');
  requestedCases=[...['positiveQueries','negativeQueries'].flatMap((field,i)=>(request.acceptance?.[field]??[]).map(question=>({cardId:ops[0].cardId,kind:i?'negative':'positive',question})))];
 }catch(error){failures.push({error:'request acceptance: '+error.message});}
 const cases=[...new Map([...receipt.cases,...requestedCases,...additionalCases].map(t=>[JSON.stringify([t.cardId,t.kind,t.question]),t])).values()];
 const cache=join(workspace,'final-cache');mkdirSync(cache,{recursive:true,mode:0o700});
 const env={...process.env,IKB_CARDS_ROOT:resolve(plan.cardsRoot),IKB_RETRIEVAL_CACHE_DIR:cache,IKB_RETRIEVAL_POLICY:'entries'};
 const call=args=>{const r=spawnSync(process.execPath,[join(REPO,'scripts/ikb-cards-cli.mjs'),...args],{env,encoding:'utf8',maxBuffer:8*1024*1024});if(r.status!==0)throw Error(r.stderr||r.stdout||'CLI failed');return JSON.parse(r.stdout);};
 for(const [i,t]of cases.entries())try{
  const s=call(['search','--scope','work','--query',t.question,'--limit','5']);save(join(workspace,`final-search-${i}.json`),s);
  const c=ops.find(c=>c.cardId===t.cardId);const item=s.items.find(x=>x.cardId===c.cardId);
  if(t.kind==='negative'||c.action==='archive'){if(item)throw Error('negative still recalls target');}
  else{if(!item)throw Error('positive target missing');const g=call(['get','--retrieval-id',s.retrievalId,'--card-id',c.cardId]);save(join(workspace,`final-get-${i}.json`),g);if(g.card.markdown!==c.after||hash(g.card.markdown)!==g.card.contentHash)throw Error('default CLI readback differs');}
  readbacks.push({question:t.question,cardId:t.cardId,ok:true});
 }catch(error){failures.push({question:t.question,error:error.message});}
 const r=spawnSync(process.execPath,[join(REPO,'tests/recall-test.mjs'),'--scope','work'],{env,encoding:'utf8',maxBuffer:8*1024*1024});writeFileSync(join(workspace,'final-recall.log'),(r.stdout??'')+(r.stderr??''),{mode:0o600});if(r.status!==0)failures.push({error:'formal recall regression failed'});
 const changes=ops.map(c=>({cardId:c.cardId,path:c.path,afterHash:c.afterHash}));
 for(const c of changes)if(c.afterHash===null?existsSync(c.path):!existsSync(c.path)||hash(read(c.path))!==c.afterHash)failures.push({error:'active target drift',path:c.path});
 const result={schema:'ikb-final-verification-v1',ok:failures.length===0,requestId:plan.requestId??null,planHash:receipt.planHash,publicationRef:join(workspace,'publication-result.json'),readbacks,changes,failures,completedAt:new Date().toISOString()};
 if(failures.length){
  result.restored=[];result.concurrentPreserved=[];
  const lock=join(plan.cardsRoot,'.maintenance.lock');let locked=false;
  try{writeFileSync(lock,JSON.stringify({pid:process.pid,kind:'finalize-recovery'}),{flag:'wx',mode:0o600});locked=true;
   for(const c of ops){const current=existsSync(c.path)?read(c.path):null,after=c.after;if(current!==after){result.concurrentPreserved.push(c.path);continue;}if(c.before===null){if(existsSync(c.path))unlinkSync(c.path);}else{const tmp=c.path+'.restore-'+randomUUID();writeFileSync(tmp,c.before,{mode:0o600});renameSync(tmp,c.path);}result.restored.push(c.path);}
  }catch(error){result.failures.push({error:'recovery: '+error.message});}finally{if(locked)unlinkSync(lock);}
 }
 save(join(workspace,'final-verification.json'),result);return result;
}

export const ADMISSION_HELP = `admit --workspace DIR --review PLAN.json --assessment ASSESSMENT.json
PLAN schema ikb-approved-publication-v2: same explicit authorizationBasis and changes as publish-approved; requestId/intakeRoot bind an update request.
ASSESSMENT schema ikb-content-review-v1, accepted:true; author/reviewer/consumer each {sessionRef,evidenceRef}, reviewer.role:main, all three sessions distinct. Evidence files preserve actual native author/reviewer/consumer output; do not invent session IDs.
sources:[{claim,reference}] must point to readable local primary evidence.
changes:[{cardId,knowledgeKind:normal,verdict:accept,classificationReason,oldNewDiff,sourceAssessment,conflicts:{verdict:clear|resolved,rationale,checkedCards:[absolute live related card paths],searchRefs:[raw work search JSON paths],excluded:[{cardId,reason}]}}]. Each first-five result needs full inspection or reasoned exclusion. Unresolved conflict rejects admission.
trials:[{cardId,kind:positive|negative,question,cardsRoot:absolute isolated complete library,searchRef,bindingRef,outputRef,getRef (positive only),judgment,accepted:true}]. At least 2 distinct positives and 1 nearby negative per card. A negative preserves search only and must exclude target. bindingRef is copied raw disk cache binding for this search. All trial files under workspace. Author must not provide expected answers to independent consumer.
Request acceptance.positiveQueries and negativeQueries must all appear unchanged in trials; extra independent questions cannot replace them. Final verification also reads these required cases directly from the request. Optional --extra-cases FILE is an additive JSON array [{cardId,kind:positive|negative,question}]; it cannot remove existing cases.
admit runs recall-test itself and writes admission.json + admitted-plan.json; then publish-approved check-only, publish-approved, finalize. finalize accepts additive --extra-cases FILE for original user regressions and runs real active CLI and recall regression, writes final-verification.json; failure restores only unchanged own writes. No self-declared completed event can substitute for final verification.
`;
