#!/usr/bin/env python3
import argparse, concurrent.futures, json, math, os, statistics, time, urllib.request
from pathlib import Path

NONE_DESC = "No listed skill is required. Handle the request directly without loading a specialized skill."

def load():
    return json.load(open(Path(__file__).with_name("fixtures.json")))

def h(s):
    x=2166136261
    for ch in s:
        x ^= ord(ch)
        x = (x * 16777619) & 0xffffffff
    return x

def candidates(data, f, size):
    catalog=[x for x in data["catalog"] if x["name"]!="none"]
    target=None if f["expected"]=="none" else next(x for x in catalog if x["name"]==f["expected"])
    ds=[x for x in catalog if target is None or x["name"]!=target["name"]]
    start=h(f["id"]) % len(ds)
    ds=ds[start:]+ds[:start]
    wanted=max(0,size-1-(1 if target else 0))
    xs=ds[:wanted]
    if target:
        pos=h(f["task"]) % (len(xs)+1)
        xs.insert(pos,target)
    return xs[:max(0,size-1)]

def call(key, data, f, size, rep, threshold):
    cs=candidates(data,f,size)
    criteria={x["name"]:x["description"] for x in cs}
    criteria["none"]=NONE_DESC
    body={
      "model":"typesafe/jev-1.13",
      "state":{"task":f["task"],"candidates":cs,
               "instruction":"Select exactly one skill only when its description is materially needed. Otherwise select none. Do not load merely related skills."},
      "questions":{"selected_skill":{"type":"choice","instructions":"Which candidate skill should be loaded first for this task?","criteria":criteria}}
    }
    req=urllib.request.Request("https://openrouter.ai/api/alpha/decisions",
      data=json.dumps(body).encode(),method="POST",
      headers={"Authorization":f"Bearer {key}","Content-Type":"application/json",
               "HTTP-Referer":"https://github.com/lalalic/agents-relay","X-Title":"Agents Relay Jev skill-discovery benchmark"})
    t=time.perf_counter()
    with urllib.request.urlopen(req,timeout=30) as r: obj=json.loads(r.read())
    lat=(time.perf_counter()-t)*1000
    ans=obj["answers"]["selected_skill"]
    pred=ans["choice"]; conf=float(ans.get("confidence", (ans.get("probabilities") or {}).get(pred,0)))
    return {"fixture_id":f["id"],"expected":f["expected"],"predicted":pred,"confidence":conf,
            "probabilities":ans.get("probabilities",{}),"candidate_set_size":size,"repeat":rep,
            "latency_ms":lat,"fallback":conf<threshold,"usage":obj.get("usage",{}),
            "model":obj.get("model"),"provider":obj.get("provider"),"candidates":[x["name"] for x in cs]+["none"]}

def pct(xs,p):
    if not xs:return None
    xs=sorted(xs); k=(len(xs)-1)*p; lo=int(k); hi=min(lo+1,len(xs)-1); q=k-lo
    return xs[lo]*(1-q)+xs[hi]*q

def ece(rows):
    bins=[[] for _ in range(10)]
    for r in rows: bins[min(9,int(r["confidence"]*10))].append(r)
    return sum(abs(statistics.mean(x["confidence"] for x in b)-statistics.mean(1 if x["predicted"]==x["expected"] else 0 for x in b))*len(b)/len(rows) for b in bins if b)

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--repeats",type=int,default=3); ap.add_argument("--workers",type=int,default=12)
    ap.add_argument("--threshold",type=float,default=.70); ap.add_argument("--out",default=str(Path(__file__).with_name("openrouter-results.json")))
    a=ap.parse_args(); key=os.environ.get("OPENROUTER_API_KEY")
    if not key: raise SystemExit("OPENROUTER_API_KEY is not set")
    data=load(); jobs=[(f,s,r) for r in range(1,a.repeats+1) for f in data["fixtures"] for s in data["candidateSetSizes"]]
    rows=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as ex:
      futs={ex.submit(call,key,data,f,s,r,a.threshold):(f,s,r) for f,s,r in jobs}
      for fut,meta in futs.items():
        f,s,r=meta
        try: rows.append(fut.result())
        except Exception as e: rows.append({"fixture_id":f["id"],"expected":f["expected"],"candidate_set_size":s,"repeat":r,"error":f"{type(e).__name__}: {e}"})
    rows.sort(key=lambda x:(x["fixture_id"],x["candidate_set_size"],x["repeat"]))
    ok=[r for r in rows if "predicted" in r]
    correct=sum(r["predicted"]==r["expected"] for r in ok)
    tp=sum(r["expected"]!="none" and r["predicted"]==r["expected"] for r in ok)
    nonnone_pred=sum(r["predicted"]!="none" for r in ok); nonnone_exp=sum(r["expected"]!="none" for r in ok)
    by={}
    for s in data["candidateSetSizes"]:
      g=[r for r in ok if r["candidate_set_size"]==s]
      by[str(s)]={"n":len(g),"exact_match":sum(r["predicted"]==r["expected"] for r in g)/len(g),
        "false_positive_loads":sum(r["expected"]=="none" and r["predicted"]!="none" for r in g),
        "missed_required_skills":sum(r["expected"]!="none" and r["predicted"]!=r["expected"] for r in g),
        "mean_confidence":statistics.mean(r["confidence"] for r in g),
        "fallback_rate":sum(r["fallback"] for r in g)/len(g)}
    usage=[r.get("usage") or {} for r in ok]
    summary={"provider":"OpenRouter behavioral proxy; Cloudflare transport separately blocked by HTTP 402","model":sorted({r.get("model") for r in ok if r.get("model")}),
      "requests_attempted":len(rows),"requests_succeeded":len(ok),"repeats":a.repeats,"confidence_threshold":a.threshold,
      "exact_match":correct/len(ok),"precision":tp/nonnone_pred if nonnone_pred else None,"recall":tp/nonnone_exp if nonnone_exp else None,
      "false_positive_loads":sum(r["expected"]=="none" and r["predicted"]!="none" for r in ok),
      "missed_required_skills":sum(r["expected"]!="none" and r["predicted"]!=r["expected"] for r in ok),
      "calibration_ece10":ece(ok),"fallback_rate":(sum(r.get("fallback",False) for r in ok)+(len(rows)-len(ok)))/len(rows),
      "latency_ms":{"p50":pct([r["latency_ms"] for r in ok],.5),"p95":pct([r["latency_ms"] for r in ok],.95),"mean":statistics.mean(r["latency_ms"] for r in ok)},
      "usage":{"input_tokens":sum(u.get("input_tokens",0) or 0 for u in usage),"output_tokens":sum(u.get("output_tokens",0) or 0 for u in usage),"reported_cost_usd":sum(u.get("cost",0) or 0 for u in usage)},
      "by_candidate_set_size":by,"failed_calls":len(rows)-len(ok)}
    json.dump({"summary":summary,"results":rows},open(a.out,"w"),indent=2)
    print(json.dumps(summary,indent=2))
if __name__=="__main__": main()
