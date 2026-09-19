#!/usr/bin/env python3
import concurrent.futures, json, os, statistics, time, urllib.request
from pathlib import Path
from run_openrouter import candidates, load, pct

SYSTEM="""You independently select the first specialized skill to load for a user task.
Choose exactly one candidate skill only when its description is materially required; otherwise choose none.
Do not load merely related skills. Return JSON only."""

def call(key,data,f,size):
    cs=candidates(data,f,size)
    choices=[{"name":x["name"],"description":x["description"]} for x in cs]+[{"name":"none","description":"No specialized skill is required."}]
    payload={"model":"openai/gpt-5.6-sol","messages":[{"role":"system","content":SYSTEM},{"role":"user","content":json.dumps({"task":f["task"],"candidates":choices},separators=(",",":"))}],
      "reasoning_effort":"high","response_format":{"type":"json_schema","json_schema":{"name":"skill_choice","strict":True,"schema":{"type":"object","properties":{"skill":{"type":"string","enum":[x["name"] for x in choices]},"confidence":{"type":"number","minimum":0,"maximum":1},"rationale":{"type":"string"}},"required":["skill","confidence","rationale"],"additionalProperties":False}}}}
    req=urllib.request.Request("https://openrouter.ai/api/v1/chat/completions",data=json.dumps(payload).encode(),method="POST",headers={"Authorization":f"Bearer {key}","Content-Type":"application/json","HTTP-Referer":"https://github.com/lalalic/agents-relay","X-Title":"Agents Relay strong skill-discovery baseline"})
    t=time.perf_counter()
    with urllib.request.urlopen(req,timeout=120) as r: obj=json.loads(r.read())
    lat=(time.perf_counter()-t)*1000; ans=json.loads(obj["choices"][0]["message"]["content"])
    return {"fixture_id":f["id"],"expected":f["expected"],"predicted":ans["skill"],"confidence":ans["confidence"],"rationale":ans["rationale"],"candidate_set_size":size,"latency_ms":lat,"usage":obj.get("usage",{}),"model":obj.get("model")}

def main():
    key=os.environ.get("OPENROUTER_API_KEY")
    if not key: raise SystemExit("OPENROUTER_API_KEY is not set")
    data=load(); jobs=[(f,s) for f in data["fixtures"] for s in data["candidateSetSizes"]]; rows=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
      futs={ex.submit(call,key,data,f,s):(f,s) for f,s in jobs}
      for fut,(f,s) in futs.items():
        try: rows.append(fut.result())
        except Exception as e: rows.append({"fixture_id":f["id"],"expected":f["expected"],"candidate_set_size":s,"error":f"{type(e).__name__}: {e}"})
    rows.sort(key=lambda x:(x["fixture_id"],x["candidate_set_size"])); ok=[r for r in rows if "predicted" in r]
    by={}
    for s in data["candidateSetSizes"]:
      g=[r for r in ok if r["candidate_set_size"]==s]
      by[str(s)]={"n":len(g),"exact_match":sum(r["predicted"]==r["expected"] for r in g)/len(g),
        "false_positive_loads":sum(r["expected"]=="none" and r["predicted"]!="none" for r in g),
        "missed_required_skills":sum(r["expected"]!="none" and r["predicted"]!=r["expected"] for r in g)}
    usage=[r.get("usage") or {} for r in ok]
    summary={"model":"openai/gpt-5.6-sol","reasoning_effort":"high","requests_attempted":len(rows),"requests_succeeded":len(ok),
      "exact_match":sum(r["predicted"]==r["expected"] for r in ok)/len(ok),
      "false_positive_loads":sum(r["expected"]=="none" and r["predicted"]!="none" for r in ok),
      "missed_required_skills":sum(r["expected"]!="none" and r["predicted"]!=r["expected"] for r in ok),
      "latency_ms":{"p50":pct([r["latency_ms"] for r in ok],.5),"p95":pct([r["latency_ms"] for r in ok],.95),"mean":statistics.mean(r["latency_ms"] for r in ok)},
      "usage":{"prompt_tokens":sum(u.get("prompt_tokens",0) or 0 for u in usage),"completion_tokens":sum(u.get("completion_tokens",0) or 0 for u in usage),"total_tokens":sum(u.get("total_tokens",0) or 0 for u in usage),"reported_cost_usd":sum(u.get("cost",0) or 0 for u in usage)},
      "by_candidate_set_size":by,"failed_calls":len(rows)-len(ok)}
    json.dump({"summary":summary,"results":rows},open(Path(__file__).with_name("strong-judge-results.json"),"w"),indent=2)
    print(json.dumps(summary,indent=2))
if __name__=="__main__": main()
