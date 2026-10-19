"""Run with browser-workspace session exec <id> --code-file this-file.
Uses isolated test Dashboard port 18983; does not access production SQLite.
"""
import json
from pathlib import Path

OUT=Path('/tmp/agents-relay-workflow-fourth-review')
OUT.mkdir(exist_ok=True)
checks=[]
def check(name, ok, info=None):
    assert ok, name+' '+str(info)
    checks.append({'name':name,'passed':True,'detail':info})
    print('PASS',name,info if info is not None else '')
def get():
    return js('({hash:location.hash,back:document.querySelector("#graph-back")?.disabled,forward:document.querySelector("#graph-forward")?.disabled,index:history.state?.workflowIndex,path:history.state?.workflowPath,ref:WORKFLOW_SOURCE_REF})')
def click(selector):
    js(f'document.querySelector({json.dumps(selector)}).click()')
    wait(.5)

# On entry after direct load, neither button claims a browser-history action.
goto_url('http://127.0.0.1:18983/#/graphs/entry')
wait(.8)
s=get()
check('initial Entry controls',s['back'] and s['forward'] and s['index']==0,s)
check('source reference is exact 40-char commit',len(s['ref'])==40 and all(c in '0123456789abcdef' for c in s['ref']),s['ref'])
js('navigateGraph("planner-orchestration")')
wait(.3)
js('navigateGraph("task-lifecycle")')
wait(.3)
s=get();check('Forward disabled at navigation end',s['back']==False and s['forward']==True,s)
click('#graph-back')
s=get();check('Back Worker to Planner enables Forward',s['hash']=='#/graphs/planner-orchestration' and not s['forward'] and not s['back'],s)
click('#graph-back')
s=get();check('Back Planner to Entry keeps Forward enabled',s['hash']=='#/graphs/entry' and s['back'] and not s['forward'],s)
click('#graph-forward')
s=get();check('Forward from Entry returns Planner',s['hash']=='#/graphs/planner-orchestration' and not s['forward'],s)
click('#graph-forward')
s=get();check('Forward to end disables Forward',s['hash']=='#/graphs/task-lifecycle' and s['forward'],s)

# Use another console tab and return through its Workflow tab.
click('#usage-tab')
check('Other tab is Usage',js('location.hash')=='#/usage')
click('#graphs-tab')
s=get();check('Returning from another tab has coherent Entry reset',s['hash']=='#/graphs/entry' and s['back'] and s['forward'] and s['path']==['entry'],s)

# Fresh direct deep link, unbacked by any prior graph page.
goto_url('http://127.0.0.1:18983/#/graphs/escalation')
wait(.8)
s=get();check('Fresh direct deep link initializes controls',s['hash']=='#/graphs/escalation' and s['back'] and s['forward'] and s['path']==['entry','escalation'],s)
click('#graph-entry')
s=get();check('Entry control returns from direct link',s['hash']=='#/graphs/entry' and not s['back'] and s['forward'],s)
js('location.reload()')
wait(.8)
s=get();check('Reload maintains URL and history state',s['hash']=='#/graphs/entry' and s['back']==False and s['forward']==True,s)

# Reference link remains tied to exact SHA and text-search evidence stays labelled.
js('navigateGraph("escalation")')
wait(.6)
js('document.querySelector("#graph-canvas [aria-label=\\"Inspect action escalation.invoke\\"]").dispatchEvent(new MouseEvent("click",{bubbles:true}))')
wait(.5)
refs=js('[...document.querySelectorAll("#graph-detail a")].map(a=>a.href)')
labels=js('document.querySelector("#graph-detail").textContent')
sha=get()['ref']
check('Graph evidence links pinned to running checkout SHA',bool(refs) and all('/blob/'+sha+'/' in url for url in refs),refs)
check('Search-suggestion evidence marked distinct from exact graph token', 'verified graph token' in labels and 'text-search suggestion' in labels,labels[:360])
capture_screenshot(str(OUT/'action-detail.png'),full=False,max_dim=1600)
(OUT/'evidence.json').write_text(json.dumps({'base':'http://127.0.0.1:18983/','checks':checks},indent=2))
print('ALL PASSED',len(checks))
