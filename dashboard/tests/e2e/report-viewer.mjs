// Opt-in real native Dashboard + real historical Neo execution-report CLI.
// Never launch an Agent or modify a Relay Job.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const modulePath=process.env.RELAY_REPORT_PLAYWRIGHT;
const {chromium}=await import(modulePath?pathToFileURL(modulePath).href:'playwright-core');
const base=process.env.RELAY_REPORT_TEST_BASE;
const job=process.env.RELAY_REPORT_TEST_JOB;
const task=process.env.RELAY_REPORT_TEST_TASK;
assert(base&&job&&task);
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const context=await browser.newContext({serviceWorkers:'block'});
  const page=await context.newPage();
  page.setDefaultTimeout(120000);
  // The chart supports a source fallback; do not depend on a CDN for
  // testing the actual report controls.
  await page.route('https://cdn.jsdelivr.net/**',r=>r.abort());
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await page.locator('.job-row').filter({hasText:new RegExp('/'+job+':')}).click();
  await page.getByRole('button',{name:'Job execution lifecycle',exact:true}).click();
  const report=page.locator('#execution-report-dialog');
  const frame=report.frameLocator('iframe');
  const generate=async(scope,name='Report')=>{
    await scope.getByRole('button',{name,exact:true}).click();
    await report.locator('#execution-report-status').filter({hasText:'Captured '}).waitFor();
    await frame.locator('h1').waitFor();
    assert((await frame.locator('h1').textContent()).includes(job));
    return await report.locator('#execution-report-status').textContent();
  };
  await generate(page.locator('#jel-report-actions'));
  assert.equal(await frame.locator('section[id^="task-"]').count()>1,true);
  await report.getByRole('button',{name:'Close',exact:true}).click();
  await generate(page.locator('#jel-report-actions'));
  await report.getByRole('button',{name:'Close',exact:true}).click();
  await page.locator('#graph-dialog-close').click();
  await generate(page.locator('#workspace-heading').locator('..'),'Job report');
  assert.equal(await frame.locator('section[id^="task-"]').count()>1,true);
  await report.getByRole('button',{name:'Close',exact:true}).click();
  // Expand completed DAG coordinators, then select the actual Task.
  for(let i=0;i<8&&!(await page.locator('.task-row[data-task-id="'+task+'"]').isVisible());i++){
    const collapsed=page.locator('.task-fold[aria-expanded=false]:visible').first();
    if(await collapsed.count()===0)break;
    await collapsed.click();
  }
  await page.locator('.task-row[data-task-id="'+task+'"]').click();
  const detail=page.locator('#task-detail');
  await generate(detail);
  assert.equal(await frame.locator('section[id^="task-"]').count(),1);
  assert.equal(await frame.locator('#task-'+task).count(),1);
  assert.equal(await frame.getByText('Observed startup messages',{exact:true}).count()>0,true);
  await report.getByRole('button',{name:'Close',exact:true}).click();
  await generate(detail);
  assert.equal(await frame.locator('#task-'+task).count(),1);
  // The read-only report is isolated from Dashboard origin.
  assert.equal(await report.locator('iframe').getAttribute('sandbox'),'allow-scripts allow-downloads');
  console.log('PASS real single-click JEL, Job and Task reports');
}finally{await browser.close();}
