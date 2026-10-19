"""Run through `browser-workspace session exec SESSION --code-file FILE`.
Requires an isolated running Dashboard at http://127.0.0.1:18983/.
"""
import json
from pathlib import Path

BASE='http://127.0.0.1:18983/'
OUT=Path('/tmp/agents-relay-workflow-browser')
OUT.mkdir(exist_ok=True)
checks=[]
def check(name, condition, detail=None):
    assert condition, f'{name}: {detail}'
    checks.append({'test':name,'detail':detail,'passed':True})
    print('PASS',name,detail if detail is not None else '')
def j(code): return js(code)
def open_graph(id):
    goto_url(BASE+'#/graphs/'+id)
    wait(1)
def entry():
    j('document.querySelector("#graph-entry").click()');wait(1)
    check('Return Entry',j('location.hash')=='#/graphs/entry')
def click_node(id):
    return j(f'(()=>{{const n=document.querySelector("#graph-canvas [aria-label=\\"Explore {id}\\"]");if(!n)return false;n.dispatchEvent(new MouseEvent("click",{{bubbles:true}}));return true;}})()')

open_graph('entry')
j('location.reload()');wait(1)
a=j('({n:document.querySelectorAll("#graph-canvas g.node").length,b:document.querySelectorAll("#graph-canvas [role=button]").length,source:document.querySelector("#graph-source").textContent})')
check('Entry rendered with clickable nodes',a['n']==11 and a['b']==11,a['n'])
check('Entry happy and review paths',all(x in a['source'] for x in ['START: Job Objective','Changes Required','Escalator workflow']))
capture_screenshot(str(OUT/'entry.png'),full=False,max_dim=1600)
check('Click Planner',click_node('planner'))
wait(1)
a=j('({hash:location.hash,buttons:document.querySelectorAll("#graph-canvas [role=button]").length,label:document.querySelector("#graph-canvas g.node")?.textContent,crumb:document.querySelector("#graph-breadcrumb").textContent})')
check('Planner graph and breadcrumb',a['hash']=='#/graphs/planner-orchestration' and a['buttons']>10 and 'Entry' in a['crumb'] and 'state:' in a['label'],a)
capture_screenshot(str(OUT/'planner.png'),full=False,max_dim=1600)
j('document.querySelector("#graph-links button").click()');wait(0.6)
links=j('[...document.querySelectorAll("#graph-detail a")].map(a=>a.href)')
check('Event detail exact source',any('src/workflow/planner-orchestration-v2.ts#L' in x for x in links),links)
j('document.querySelector("#graph-canvas [role=button]").dispatchEvent(new MouseEvent("click",{bubbles:true}))');wait(0.5)
check('Node detail contract', 'Canonical contract' in j('document.querySelector("#graph-detail").textContent'))
j('history.back()');wait(0.8)
check('Browser Back',j('location.hash')=='#/graphs/entry')
j('history.forward()');wait(0.8)
check('Browser Forward',j('location.hash')=='#/graphs/planner-orchestration')
entry()
for name,target in [('worker','task-lifecycle'),('troubleshooter','troubleshooter'),('escalator','escalation')]:
    check('Click '+name,click_node(name));wait(1)
    d=j('({hash:location.hash,n:document.querySelectorAll("#graph-canvas g.node").length,error:document.querySelector("#graph-canvas .error-state")?.textContent})')
    check(name+' child graph',d['hash']=='#/graphs/'+target and d['n']>0 and not d.get('error'),d)
    if name=='escalator':
        capture_screenshot(str(OUT/'escalation.png'),full=False,max_dim=1600)
        sel='#graph-canvas [aria-label="Inspect action escalation.invoke"]'
        check('Escalation action interactive',j(f'!!document.querySelector({json.dumps(sel)})'))
        j(f'document.querySelector({json.dumps(sel)}).dispatchEvent(new MouseEvent("click",{{bubbles:true}}))');wait(0.6)
        refs=j('[...document.querySelectorAll("#graph-detail a")].map(a=>a.href)')
        check('Escalation real implementation and test',any('src/workflow/escalation.ts#L' in x for x in refs) and any('test/escalation.test.js#L' in x for x in refs),refs)
    entry()
j('document.querySelector("#graph-canvas [aria-label=\\"Explore planner\\"]").focus()')
press_key('Enter');wait(0.6)
check('Keyboard Enter',j('location.hash')=='#/graphs/planner-orchestration')
open_graph('escalation')
check('Direct deep link',j('document.querySelector("#graph-title").textContent')=='Escalation')
j('location.reload()');wait(1)
check('Reload deep link',j('location.hash')=='#/graphs/escalation' and j('document.querySelectorAll("#graph-canvas g.node").length')>0)
open_graph('no-such-graph')
check('Missing graph error', 'Graph not found' in j('document.querySelector("#graph-canvas").textContent'))
open_graph('entry')
try:
    cdp('Emulation.setDeviceMetricsOverride',width=390,height=844,deviceScaleFactor=1,mobile=True)
    wait(0.5)
    d=j('({width:innerWidth,mobile:matchMedia("(max-width:650px)").matches,view:!document.querySelector("#graphs-view").hidden,controls:document.querySelectorAll("#graph-canvas [role=button]").length})')
    check('390px responsive',d['width']==390 and d['mobile'] and d['view'] and d['controls']==11,d)
    capture_screenshot(str(OUT/'mobile.png'),full=False,max_dim=1100)
finally:
    cdp('Emulation.clearDeviceMetricsOverride')
j('window.__savedMermaid=window.mermaid;window.mermaid=undefined;renderSelectedGraph()');wait(0.4)
check('Mermaid unavailable fallback','Mermaid renderer unavailable' in j('document.querySelector("#graph-canvas").textContent') and 'flowchart LR' in j('document.querySelector("#graph-source").textContent'))
j('window.mermaid=window.__savedMermaid;window.__relayMermaidReady=false;renderSelectedGraph()');wait(1)
attacks=[
'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect onload="alert(1)"/></svg>',
'<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="https://evil.test"/></foreignObject><use href="https://evil.test/a#x"/></svg>',
'<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:url(https://evil.test/x)}</style><rect style="background:url(https://evil.test/x)" fill="URL(https://evil.test/x)"/></svg>',
'<svg xmlns="http://www.w3.org/2000/svg"><g onclick="alert(1)"><path d="M0 0" marker-end="url(https://evil.test/x#e)"/></g></svg>',
'<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>bad</text></a><image href="https://evil.test/x.png"/></svg>',
'<svg xmlns="http://www.w3.org/2000/svg"><rect/><script></svg>'
]
for i,payload in enumerate(attacks):
    r=j(f'(()=>{{try{{return {{html:sanitizeGraphSvg({json.dumps(payload)}).outerHTML}}}}catch(e){{return {{rejected:true,error:e.message}}}}}})()')
    html=r.get('html','').lower()
    bad=['<script','foreignobject','<iframe','<use','<image','<style','<a ',' onload',' onclick',' href=','xlink:href','style=','https://evil.test','javascript:','url(https:']
    check('XSS adversarial '+str(i+1),r.get('rejected',False) or not any(x in html for x in bad),r)
(OUT/'evidence.json').write_text(json.dumps({'url':BASE,'checks':checks},indent=2))
print('ALL PASSED',len(checks),OUT)
