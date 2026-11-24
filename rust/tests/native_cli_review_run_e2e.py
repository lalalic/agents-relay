#!/usr/bin/env python3
"""Real installed Rust review run exit-code/JSON contract using owned mock
model process. Never invokes Codex CLI, WebHelm, Relay Job or live provider."""
import os,json,tempfile,subprocess,pathlib,shutil
base=pathlib.Path(__file__).resolve().parents[2]
cli=pathlib.Path(os.environ.get('AGENTS_RELAY_REVIEW_CLI_BIN', str(base/'rust/target/debug/agents-relay-rust')))
root=pathlib.Path(tempfile.mkdtemp(prefix='rust2-review-run-owned-'))
project=root/'fixture'; project.mkdir()
subprocess.run(['git','init','-q','-b','main'],cwd=project,check=True)
try:
 for verdict,exit_code in [('PASS',0),('CHANGE_REQUIRED',10),('BLOCKED',20)]:
  script=root/(verdict.lower()+'-provider.sh')
  result={'verdict':verdict,'summary':'fixture-only independent reviewer evidence',
          'findings':[],'evidence':['local fixture']}
  script.write_text('#!/bin/sh\ncat >/dev/null\nprintf %s\\\\n '+
    "'"+json.dumps(result,separators=(',',':'))+"'\n")
  script.chmod(0o700)
  dest=project/(verdict.lower()+'.json')
  env={**os.environ,'AGENTS_RELAY_REVIEW_MODEL_BIN':str(script)}
  proc=subprocess.run([str(cli),'review','run','--prompt',
    'Inspect only the disposable fixture','--project-path',str(project),
    '--output',str(dest)],cwd=base,env=env,text=True,
    stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=12)
  assert proc.returncode==exit_code, (verdict,proc.returncode,proc.stderr)
  receipt=json.loads(proc.stdout.strip())
  assert receipt['verdict']==verdict,receipt
  assert len(receipt['reviews'])==1,receipt
  assert receipt['reviews'][0]['reviewer']=='reviewer',receipt
  assert dest.exists() and json.loads(dest.read_text())==receipt
  print('REVIEW_VERDICT',verdict,'EXIT',proc.returncode,'OUTPUT_FILE',dest.name)
 # Builtin job-acceptance-reviewer must inherit the canonical reviewer
 # base AND retain its own Preflight duties in the actual model prompt.
 trace=root/'review-input.txt'
 script=root/'preflight-provider.sh'
 script.write_text('#!/bin/sh\ncat >> "$AGENTS_RELAY_REVIEW_TRACE"\nprintf %s\\\\n '+
   "'"+json.dumps({'verdict':'PASS','findings':[], 'evidence':['local preflight fixture']},separators=(',',':'))+"'\n")
 script.chmod(0o700)
 env={**os.environ,'AGENTS_RELAY_REVIEW_MODEL_BIN':str(script),
      'AGENTS_RELAY_REVIEW_TRACE':str(trace)}
 proc=subprocess.run([str(cli),'review','run','--agents','job-acceptance-reviewer',
    '--prompt','Preflight-review spec.md for this disposable Job',
    '--project-path',str(project)],cwd=base,env=env,text=True,
    stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15)
 assert proc.returncode==0,(proc.returncode,proc.stderr)
 receipt=json.loads(proc.stdout.strip())
 assert [x['reviewer'] for x in receipt['reviews']]==['reviewer','job-acceptance-reviewer'],receipt
 full=trace.read_text()
 assert '# Relay Reviewer Agent' in full, 'canonical built-in Final Reviewer base missing'
 assert 'For **publish-first live acceptance**' in full, 'inherited review evidence rules missing'
 assert 'Job creation Preflight' in full, 'Job Acceptance extension missing'
 assert full.count('Reviewer: ')==2, 'expected implicit generic reviewer and named builtin'
 print('NATIVE_JOB_PREFLIGHT_INHERITS_BUILTIN_FINAL_REVIEWER_PASS')
 bad=subprocess.run([str(cli),'review','run','--prompt',
  'Fixture','--agents','BAD-LABEL','--project-path',str(project)],
  cwd=base,text=True,stdout=subprocess.PIPE,
  stderr=subprocess.PIPE,timeout=10)
 assert bad.returncode==1 and 'invalid reviewer agent name' in bad.stderr, bad.stderr
 print('NATIVE_INSTALLED_REVIEW_RUN_MOCK_MODEL_EXIT_CODES_PASS')
finally:
 shutil.rmtree(root)
