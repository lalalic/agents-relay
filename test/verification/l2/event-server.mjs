#!/usr/bin/env node
/** Isolated L2 capture MCP server, never connected to the production Events Bus. */
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const [output,jobId,taskId,executionId]=process.argv.slice(2);
if(!output||!jobId||!taskId||!executionId)throw Error('L2 MCP requires private sink and exact execution identity');
const expectedSource=`job/${jobId}/task/${taskId}/execution/${executionId}`;
const write=value=>process.stdout.write(JSON.stringify(value)+'\n');
const reply=(id,result)=>write({jsonrpc:'2.0',id,result});
const fail=(id,code,message)=>write({jsonrpc:'2.0',id,error:{code,message}});
const schema={type:'object',additionalProperties:false,properties:{
  type:{type:'string'}, source:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:true},
  data:{type:'object',additionalProperties:true},
},required:['type','source','data']};
let count=0;
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
 let request;
 try{request=JSON.parse(line)}catch{continue}
 if(request.jsonrpc!=='2.0')continue;
 if(request.id===undefined)continue;
 const id=request.id;
 try{
  if(request.method==='initialize'){
   reply(id,{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'agents-relay-l2-isolated-events',version:'1.0.0'}});continue;
  }
  if(request.method==='ping'){reply(id,{});continue;}
  if(request.method==='tools/list'){
   reply(id,{tools:[{name:'publish',description:`Publish exactly one canonical Agents Relay event for Job ${jobId}, Task ${taskId}. Exact source.id: ${expectedSource}. This is the ONLY allowed event sink for this isolated L2 execution.`,inputSchema:schema}]});continue;
  }
  if(request.method==='tools/call'){
    if(request.params?.name!=='publish')throw Error('Unknown tool');
    const event=request.params?.arguments;
    // Preserve raw model output; never repair incorrect payload/identity.
    const validation=[];
    if(!event||typeof event!=='object')validation.push('invalid envelope');
    else {
      if(event.source?.id!==expectedSource)validation.push('source.id');
      if(typeof event.type!=='string'||!event.type.startsWith('task.'))validation.push('type');
      if(!event.data||typeof event.data!=='object'||Array.isArray(event.data))validation.push('data');
    }
    appendFileSync(output,JSON.stringify({raw:event??null,validation,sequence:++count})+'\n',{encoding:'utf8',mode:0o600});
    reply(id,{content:[{type:'text',text:validation.length?`Event rejected: ${validation.join(', ')}`:`Isolated event accepted for transport, sequence ${count}; Relay will independently validate lifecycle semantics.`}],isError:validation.length>0});continue;
  }
  fail(id,-32601,'Unknown MCP method');
 }catch(error){fail(id,-32000,error instanceof Error?error.message:String(error))}
}
