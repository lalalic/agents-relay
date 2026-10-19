/** Graph-authorized public CLI action IDs delegate to canonical Task commands. */
export async function runWorkflowAction(args: string[], execute: (operation: string)=>Promise<void>):Promise<void> {
 const value=(flag:string)=>{const i=args.indexOf(flag);return i<0?'':args[i+1]??'';};
 const actions:Readonly<Record<string,string>>={
   'task.retry':'retry','task.recover':'recover','task.cancel':'cancel',
   'task.unblock':'unblock','task.escalate':'escalate',
   'task.resume-troubleshooter':'resume-troubleshooter',
 };
 const operation=actions[value('--action')];
 if(!operation)throw Error('workflow action requires a supported Graph-authorized task Action ID');
 if(!value('--repo')||!value('--id')||!value('--task-id'))throw Error('workflow action requires --repo, --id and --task-id');
 await execute(operation);
}
