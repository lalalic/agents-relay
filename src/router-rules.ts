/**
 * Router Rules free-text parsing.
 *
 * The Execution Router rules file carries two explicit, user-authored sections:
 *
 * ```text
 * [choices]
 * openai: gpt-5.6-luna high, sol medium
 * zai: glm-5.3-flash high
 *
 * [routing-instruction]
 * Prefer zai until its quota resets; otherwise use the openai default.
 * ```
 *
 * `[choices]` is an explicit, additive list of provider/model/reasoning routes.
 * `[routing-instruction]` is opaque guidance forwarded to Laya verbatim: the
 * exact section body is preserved byte-for-byte (leading and trailing
 * whitespace, blank lines, and line endings included) so Relay never rewrites or
 * normalizes user intent. Everything outside these sections is ignored so legacy
 * free-text files remain valid and Relay never has to guess at intent.
 */

export type RouterRuleChoice = {
  worker?: string;
  provider: string;
  model: string;
  reasoning?: string;
};

export type ParsedRouterRules = {
  choices: RouterRuleChoice[];
  routingInstruction: string;
};

const SECTION_CHOICES = 'choices';
const SECTION_INSTRUCTION = 'routing-instruction';

const SECTION_HEADER = /^[ \t]*\[([a-z][a-z0-9-]*)\][ \t]*\r?$/gim;

function sectionOf(line: string): string | null {
  const match = line.match(/^\s*\[([a-z][a-z0-9-]*)\]\s*$/i);
  return match ? match[1].toLowerCase() : null;
}

function choiceKey(choice: RouterRuleChoice): string {
  return [choice.worker ?? '', choice.provider, choice.model, choice.reasoning ?? ''].join('\u0000');
}

/**
 * Return the raw body of the first section named `name`, exactly as authored.
 *
 * The body begins after the line terminator that ends the section header line
 * (the terminator belongs to the header) and ends at the start of the next
 * section header line, or at end of input. Nothing inside the body is trimmed or
 * normalized: whitespace, blank lines, and line endings are part of the
 * forwarded instruction.
 */
function rawSectionBody(text: string, name: string): string | null {
  const headers: Array<{ name: string; lineStart: number; lineEnd: number }> = [];
  for (const match of text.matchAll(SECTION_HEADER)) {
    const lineStart = match.index ?? 0;
    headers.push({ name: match[1].toLowerCase(), lineStart, lineEnd: lineStart + match[0].length });
  }
  const index = headers.findIndex(header => header.name === name);
  if (index < 0) return null;
  let bodyStart = headers[index].lineEnd;
  if (text[bodyStart] === '\r') bodyStart += 1;
  if (text[bodyStart] === '\n') bodyStart += 1;
  const bodyEnd = index + 1 < headers.length ? headers[index + 1].lineStart : text.length;
  return text.slice(bodyStart, bodyEnd);
}

/**
 * Parse explicit router choices and the routing instruction from Router Rules.
 *
 * `[choices]` entries are deduplicated deterministically (first occurrence
 * wins). The `[routing-instruction]` body is captured verbatim.
 */
export function appendRoutingInstruction(question: string, instruction: string): string {
  if (!instruction) return question;
  return question + '\n\n' + instruction;
}

export function parseRouterRules(text: string): ParsedRouterRules {
  const choices: RouterRuleChoice[] = [];
  const seen = new Set<string>();
  let section: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const header = sectionOf(rawLine);
    if (header !== null) {
      section = header;
      continue;
    }
    if (section === SECTION_INSTRUCTION) continue;
    if (section !== SECTION_CHOICES) continue;
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const route = rawLine.trim().match(/^([A-Za-z0-9._/-]+)::([A-Za-z0-9._-]+):([A-Za-z0-9._/-]+)(?:@([A-Za-z0-9._-]+))?$/);
    if (route) {
      const choice: RouterRuleChoice = {
        worker: route[1],
        provider: route[2],
        model: route[3],
        ...(route[4] ? { reasoning: route[4].toLowerCase() } : {}),
      };
      const key = choiceKey(choice);
      if (!seen.has(key)) {
        seen.add(key);
        choices.push(choice);
      }
      continue;
    }

    const match = rawLine.match(/^\s*([A-Za-z0-9._-]+)\s*:\s*(.+)$/);
    if (!match) continue;
    const provider = match[1].trim();
    for (const segment of match[2].split(',')) {
      const tokens = segment.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) continue;
      const choice: RouterRuleChoice = {
        provider,
        model: tokens[0],
        ...(tokens[1] ? { reasoning: tokens[1].toLowerCase() } : {}),
      };
      const key = choiceKey(choice);
      if (seen.has(key)) continue;
      seen.add(key);
      choices.push(choice);
    }
  }

  return { choices, routingInstruction: rawSectionBody(text, SECTION_INSTRUCTION) ?? '' };
}
