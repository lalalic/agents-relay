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
 * `[routing-instruction]` is opaque guidance forwarded to Laya verbatim.
 * Everything outside these sections is ignored so legacy free-text files remain
 * valid and Relay never has to guess at intent.
 */

export type RouterRuleChoice = {
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

function sectionOf(line: string): string | null {
  const match = line.match(/^\s*\[([a-z][a-z0-9-]*)\]\s*$/i);
  return match ? match[1].toLowerCase() : null;
}

function choiceKey(choice: RouterRuleChoice): string {
  return [choice.provider, choice.model, choice.reasoning ?? ''].join('\u0000');
}

/**
 * Parse explicit router choices and the routing instruction from Router Rules.
 * Duplicate choices are collapsed deterministically (first occurrence wins).
 */
export function parseRouterRules(text: string): ParsedRouterRules {
  const choices: RouterRuleChoice[] = [];
  const seen = new Set<string>();
  const instructionLines: string[] = [];
  let section: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const header = sectionOf(rawLine);
    if (header !== null) {
      section = header;
      continue;
    }
    if (section === SECTION_INSTRUCTION) {
      instructionLines.push(rawLine);
      continue;
    }
    if (section !== SECTION_CHOICES) continue;
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
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

  return { choices, routingInstruction: instructionLines.join('\n').trim() };
}
