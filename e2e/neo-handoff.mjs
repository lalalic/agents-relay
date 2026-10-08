#!/usr/bin/env node
// Uses NeoY's own terminal turn handoff implementation, independent of Agents Relay.
import {readFileSync} from 'node:fs';
import {scheduleXChatLifecycle} from '../../neox/mac/NeoY/Runtime/src/core/tools/xchat.mjs';
const threadId=process.env.E2E_CHATGPT_THREAD_ID;
if(!threadId){console.error('E2E_CHATGPT_THREAD_ID is required to avoid sending a diagnostic to the wrong ChatGPT thread');process.exit(64)}
const payload=JSON.parse(readFileSync(process.argv[2],'utf8'));
const text=[
 'E2E runner detected a blocking defect; continue repairing NOW in this ChatGPT thread.',
 'Independent E2E runner is controller, Agents Relay is only the system under test.',
 'Do not create repair Jobs or Tasks.',
 'Branch: '+payload.branch,'Repo: '+payload.repo,'PR: '+payload.pr,'Job under test: '+payload.jobId,
 'Issue evidence: '+JSON.stringify(payload.issue,null,2),
 'Recent events: '+JSON.stringify(payload.events,null,2),
 'Required in this turn: root-cause analysis, edit the existing branch, run tests, make one explanatory commit per bug, append e2e/RUNLOG.md, trigger the next E2E execution. Repeat until all cases pass. Verify actual state rather than promising background work.'
].join('\n');
const output=scheduleXChatLifecycle('chatgpt',{command:'turn',args:{thread_id:threadId,message:text,reason:'Independent E2E failure escalation'}});
const result=JSON.parse(output.content[0].text);
if(result.status!=='scheduled')process.exit(1);
console.log(JSON.stringify({status:result.status,transfer_id:result.transfer_id,thread_id:threadId}));
