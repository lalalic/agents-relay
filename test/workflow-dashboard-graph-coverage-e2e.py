"""Isolated browser E2E for all canonical workflow graph views.
Run with: browser-workspace session exec SESSION --code-file test/workflow-dashboard-graph-coverage-e2e.py
The operator must first host this checkout on http://127.0.0.1:18983/.
"""
import json
from pathlib import Path
BASE='http://127.0.0.1:18983/'
OUT=Path('/tmp/agents-relay-job481-graph-browser-evidence')
OUT.mkdir(parents=True,exist_ok=True)
checks=[]
def check(name, condition, evidence=None):
    item={'name':name,'passed':bool(condition),'evidence':evidence}
    checks.append(item)
    print(('PASS' if item['passed'] else 'FAIL'),name,str(evidence)[:220] if evidence is not None else '')
    if not item['passed']: raise AssertionError(item)
def browser(expr):return js(expr)
def open_graph(name):
    goto_url(BASE+'#/graphs/'+name)
    for attempt in range(12):
        wait(0.25)
        try:
            view=browser('({id:location.hash.split("/").pop(),svg:document.querySelector("#graph-canvas svg")?.id||null,nodes:document.querySelectorAll("#graph-canvas g.node").length,error:document.querySelector("#graph-canvas .error-state")?.textContent||null})')
            if view['id']==name and view['svg']=='relay-graph-'+name and view['nodes']>0:return view
        except Exception:
            wait(0.5)
    raise AssertionError('Graph render never settled: '+name+' '+str(view))
try:
    goto_url(BASE+'#/graphs/main');wait(1)
    ids=browser('workflowGraphs.map(x=>x.id)')
    check('Canonical graph inventory',len(ids)==17 and 'main' in ids,ids)
    main=browser('({nodes:document.querySelectorAll("#graph-canvas g.node").length,links:document.querySelectorAll("#graph-canvas [role=button]").length,error:document.querySelector("#graph-canvas .error-state")?.textContent||null})')
    check('Main visible with clickable hyperlinked nodes',main['nodes']==17 and main['links']>=9 and not main['error'],main)
    capture_screenshot(str(OUT/'main.png'),full=False,max_dim=1500)
    rendered={}
    for graph in ids:
        view=open_graph(graph)
        rendered[graph]=view
        check('Rendered '+graph,view['nodes']>0 and not view['error'],view)
    check('All executable graphs and main rendered',len(rendered)==17)
    main=open_graph('main')
    check('Main ready before hyperlink',main['nodes']==17,main)
    click_result=browser('(()=>{const n=[...document.querySelectorAll("#graph-canvas [role=button]")].find(x=>x.getAttribute("aria-label")==="Explore planner");if(!n)return false;n.dispatchEvent(new MouseEvent("click",{bubbles:true}));return true})()')
    check('Main Planner hyperlink accepted',click_result)
    wait(0.7)
    check('Planner drilldown',browser('location.hash')=='#/graphs/planner-orchestration')
    capture_screenshot(str(OUT/'planner.png'),full=False,max_dim=1500)
    browser('history.back()');wait(0.5)
    check('Back returns main',browser('location.hash')=='#/graphs/main')
    browser('history.forward()');wait(0.5)
    check('Forward returns Planner',browser('location.hash')=='#/graphs/planner-orchestration')
    check('Planner has clickable action/guard/state nodes',browser('document.querySelectorAll("#graph-canvas [role=button]").length')>10)
    browser('document.querySelector("#graph-canvas [role=button]").dispatchEvent(new MouseEvent("click",{bubbles:true}))');wait(0.5)
    check('Graph symbol reference panel',browser('document.querySelector("#graph-detail")?.hidden===false && document.querySelector("#graph-detail")?.textContent.includes("Graph")'))
    browser('document.querySelector("#graph-maximize").click()');wait(0.3)
    check('Maximized modal visible',browser('document.querySelector("#graph-dialog").open===true'))
    before=browser('document.querySelector("#graph-zoom-level").textContent')
    browser('document.querySelector("#graph-zoom-in").click()')
    enlarged=browser('document.querySelector("#graph-zoom-level").textContent')
    check('Zoom in',before=='100%' and enlarged=='125%',{'before':before,'after':enlarged})
    browser('document.querySelector("#graph-zoom-out").click()')
    check('Zoom out',browser('document.querySelector("#graph-zoom-level").textContent')=='100%')
    browser('document.querySelector("#graph-zoom-reset").click()')
    check('Fit resets scale',browser('document.querySelector("#graph-zoom-level").textContent')=='100%')
    capture_screenshot(str(OUT/'planner-maximized.png'),full=False,max_dim=1500)
    browser('document.querySelector("#graph-dialog-close").click()');wait(0.3)
    check('Viewer closed and graph returned',browser('!document.querySelector("#graph-dialog").open && !!document.querySelector("#graph-canvas svg")'))
    attacks=[
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect onload="alert(1)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="https://evil.test/"/></foreignObject><use href="https://evil.test/a.svg#x"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="javascript:alert(1)"><rect width="20"/></a></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:url(https://evil.test/x)}</style><rect style="background:url(https://evil.test/x)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect marker-end="url(https://evil.test/attacker#x)" /></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect/><script></svg>'
    ]
    for i,source in enumerate(attacks):
        result=browser('(()=>{try{return {markup:sanitizeGraphSvg('+json.dumps(source)+').outerHTML}}catch(e){return {rejected:true,error:e.message}}})()')
        html=result.get('markup','').lower()
        bad=['<script','foreignobject','<iframe','<use','<a ','<style',' onload',' onclick',' href=','xlink:href','style=','https://evil.test','javascript:','url(https:']
        check('XSS rejected '+str(i+1),result.get('rejected') or not any(s in html for s in bad),result)
    record={'url':BASE,'graphInventory':ids,'rendered':rendered,'checks':checks}
    (OUT/'report.json').write_text(json.dumps(record,indent=2))
    print('TOTAL PASS',len(checks))
finally:
    pass
