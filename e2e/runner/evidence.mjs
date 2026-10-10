export function reviewHeadSha(event={}){
  const data=event && typeof event.data==='object' && event.data && !Array.isArray(event.data) ? event.data : {};
  const outcome=data && typeof data.outcome==='object' && data.outcome && !Array.isArray(data.outcome) ? data.outcome : {};
  const review=data && typeof data.review==='object' && data.review && !Array.isArray(data.review) ? data.review : {};
  for(const value of [
    outcome.head_sha,outcome.headSha,
    review.head_sha,review.headSha,
    data.head_sha,data.headSha,
    event.head_sha,event.headSha,
  ]) if(typeof value==='string'&&value.length>0) return value;
  return null;
}
