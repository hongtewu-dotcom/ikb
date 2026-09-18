import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,writeFileSync,chmodSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('F19 collector preserves a failed child even when log tail and later children succeed',t=>{
 const root=mkdtempSync(join(tmpdir(),'ikb-usage-exit-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const node=join(root,'fake-node');writeFileSync(node,'#!/bin/bash\necho fixture-result\nif [[ "$*" == *"collect-pi"* ]]; then exit 7; fi\nexit 0\n');chmodSync(node,0o700);
 const log=join(root,'collect.log');const r=spawnSync('bash',[fileURLToPath(new URL('../scripts/collect-usage.sh',import.meta.url))],{encoding:'utf8',env:{...process.env,IKB_USAGE_NODE:node,IKB_USAGE_REPO:root,IKB_USAGE_LOG:log}});
 assert.equal(r.status,1,r.stderr);assert.match(readFileSync(log,'utf8'),/collect-pi.*exit=7/);
});

test('activated collector uses only v2 projection and labels regression',t=>{
 const root=mkdtempSync(join(tmpdir(),'ikb-usage-shell-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'ikb-data/usage'),{recursive:true});
 writeFileSync(join(root,'ikb-data/usage/activation.json'),JSON.stringify({activatedAt:'2026-09-15T00:00:00.000Z'}));
 const node=join(root,'fake-node');
 writeFileSync(node,'#!/bin/bash\nif [[ "$1" == "-p" ]]; then echo 2026-09-15T00:00:00.000Z; exit 0; fi\necho "$IKB_USAGE_PURPOSE $*" >> "$IKB_USAGE_REPO/calls"\necho fixture-result\n');chmodSync(node,0o700);
 const r=spawnSync('bash',[fileURLToPath(new URL('../scripts/collect-usage.sh',import.meta.url))],{encoding:'utf8',env:{...process.env,IKB_USAGE_NODE:node,IKB_USAGE_REPO:root,IKB_USAGE_LOG:join(root,'collect.log')}});
 assert.equal(r.status,0,r.stderr);
 const calls=readFileSync(join(root,'calls'),'utf8');
 assert.match(calls,/collect-v2 --data-root/);assert.doesNotMatch(calls,/ikb-recall-cli.ts collect(?: |\n)/);
 assert.match(calls,/ikb-feedback-import.mjs --usage-root .*usage --intake-root .* --cards-root .* --since 2026-09-15T00:00:00.000Z/);
 assert.match(calls,/ikb-weekly-summary-cli.ts --v2 --usage-root .*usage/);
 assert.match(calls,/regression .*--test test\/ikb-cards-cli.test.ts test\/ikb-cards-mcp.test.ts/);
 assert.match(calls,/scripts\/ikb-workbench.mjs --intake-root .*\/ikb-data\/intake --output-dir .*\/ikb-data\/intake\/workbench/);
});

test('collector reports workbench refresh failures instead of claiming a fresh page',t=>{
 const root=mkdtempSync(join(tmpdir(),'ikb-workbench-refresh-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const node=join(root,'fake-node');writeFileSync(node,'#!/bin/bash\necho fixture-result\nif [[ "$*" == *"ikb-workbench.mjs"* ]]; then exit 9; fi\nexit 0\n');chmodSync(node,0o700);
 const log=join(root,'collect.log');const r=spawnSync('bash',[fileURLToPath(new URL('../scripts/collect-usage.sh',import.meta.url))],{encoding:'utf8',env:{...process.env,IKB_USAGE_NODE:node,IKB_USAGE_REPO:root,IKB_USAGE_LOG:log}});
 assert.equal(r.status,1,r.stderr);assert.match(readFileSync(log,'utf8'),/ikb-workbench.mjs.*exit=9/);
});
