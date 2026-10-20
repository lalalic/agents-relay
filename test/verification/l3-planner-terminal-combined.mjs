import {plannerCombinedScenario} from './l3-planner-combined.mjs';
const head=plannerCombinedScenario;
export const terminalPlannerCombinedScenario={
 ...head,id:'terminal-planner-sequential-recovery',
 plannerScript:{...head.plannerScript,maxAttempts:1},
 steps:[
  {type:'planner.settle',expectStatus:'FAILED'},
  {type:'reconcile'},
  {type:'mock.claim',taskId:'recover-plan-1',executionId:'planner-troubleshoot-1'},
  {type:'task.started',taskId:'recover-plan-1',executionId:'planner-troubleshoot-1'},
  {type:'task.completed',taskId:'recover-plan-1',executionId:'planner-troubleshoot-1',
   data:{verified:true,evidence:'Isolated provider failure cause confirmed and corrected'}},
  {type:'planner.await-success'},
  ...head.steps.slice(1),
 ],
 expected:{...head.expected,plans:{'plan-1':'FAILED','plan-2':'SUCCEEDED'}},
};
