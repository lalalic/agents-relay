/** A first-party model-only bridge. No shell, MCP, connectors, or event tools. */
const endpoint = 'https://api.openai.com/v1/responses';

export async function evaluateWithModelOnlyApi({ prompt, apiKey, model, fetchImpl = fetch }) {
  if (!apiKey || !model) return { status: 'NOT_RUN', reason: 'Model-only API credentials or model not configured' };
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: prompt, tools: [], tool_choice: 'none', store: false }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (error) { return { status: 'NOT_RUN', reason: `Model-only transport unavailable: ${String(error).slice(0, 160)}` }; }
  if (!response.ok) return { status: 'NOT_RUN', reason: `Model-only provider HTTP ${response.status}` };
  const data = await response.json();
  if (data.model !== model) return { status: 'NOT_RUN', reason: 'Provider model identity differs from requested model' };
  if (data.status !== 'completed') return { status: 'NOT_RUN', reason: `Model response status ${data.status ?? 'unknown'}` };
  if (!Array.isArray(data.output) || data.output.some(item => item.type !== 'message'))
    return { status: 'FAIL', reason: 'Provider emitted non-message or tool output' };
  const answer = data.output.flatMap(item => item.content ?? [])
    .filter(part => part.type === 'output_text' && typeof part.text === 'string')
    .map(part => part.text).join('\n');
  if (!answer) return { status: 'FAIL', reason: 'Model returned no text' };
  return { status: 'OK', answer, verifiedModel: data.model };
}
