import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildWorkbenchMetrics} from '../scripts/ikb-workbench-metrics.mjs';
const now='2026-09-17T12:00:00.000Z';
function fixture(t) { const root=mkdtempSync(join(tmpdir(),'ikb-metrics-')); t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,intakeRoot:join(root,'intake'),generatedAt:now,requests:[]}; }
function completed(id, date, card='card-a') {return {requestId:id,status:'completed',request:{kind:'update'},artifacts:{complete:true,final:{completedAt:date,changes:[{cardId:card,afterHash:'hash'}]}}};}
test('metrics count verified card updates by completion time, dedupe and exclude old resolved attempts',t=>{
 const f=fixture(t);const r=[completed('a','2026-09-16T12:00:00Z'),completed('b','2026-09-16T13:00:00Z'),completed('c','2026-09-08T12:00:00Z','prior'),{...completed('bad',now,'bad'),artifacts:{complete:false}},{requestId:'old',status:'waiting',request:{kind:'feedback'}},{requestId:'feedback',status:'no_change',request:{kind:'feedback'}},{requestId:'defer',status:'waiting',request:{kind:'feedback'},decision:{required:true,recordedAt:'2026-09-17T10:00:00Z'}}];
 const m=buildWorkbenchMetrics({...f,requests:r,historicalIds:['old']});assert.equal(m.knowledge.updatedCards,1);assert.equal(m.knowledge.previous7Days,1);assert.equal(m.decisions.oldestHours,2);assert.equal(m.decisions.pending,1);assert.deepEqual(m.feedback,{total:2,handled:1,deferred:1,pending:0});assert.equal(m.usage.reads,null);
});
test('missing, stale and malformed usage are visible and never silently converted to zero',t=>{
 const f=fixture(t);assert.equal(buildWorkbenchMetrics(f).usage.state,'missing');const dir=join(f.root,'usage-v2');mkdirSync(dir);const path=join(dir,'summary.json');
 writeFileSync(path,JSON.stringify({schema:'ikb-recall-usage-summary-v2',generatedAt:'2026-09-15T12:00:00Z',window:{last7DaysUtc:{from:'2026-09-08T12:00:00Z',to:'2026-09-15T12:00:00Z'}},last7Days:{reads:4,searches:8,zeroResults:3,cards:{a:{references:2}},origins:{'codex|root|maintenance':8}}}));
 const m=buildWorkbenchMetrics(f);assert.equal(m.usage.state,'stale');assert.equal(m.usage.reads,4);assert.equal(m.usage.references,2);assert.equal(m.usage.origins['codex|root|maintenance'],8);
 writeFileSync(path,'{broken');const broken=buildWorkbenchMetrics(f);assert.equal(broken.usage.state,'invalid');assert.equal(broken.usage.reads,null);
});
