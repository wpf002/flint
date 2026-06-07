import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { Flint, AnthropicProvider, OllamaProvider, type ProviderAdapter, type Tool } from '@flint/core';
import {
  Persona,
  InMemoryRetriever,
  FLINT_STYLE_GUIDE,
  FLINT_VOICE_EXEMPLARS,
  checkVoice,
} from '@flint/persona';

/**
 * Qualitative eval — the automated voice check has hit its ceiling, so this
 * captures FULL outputs for human (Flint) judgment. Prompts are chosen to
 * stress what the cheap metric can't see: committing under ambiguity, domain
 * depth, refusing to hallucinate, and challenging a bad premise.
 *
 *   OLLAMA_MODEL=qwen2.5:14b pnpm --filter playground eval
 *   ANTHROPIC_API_KEY=...    pnpm --filter playground eval
 */

interface EvalPrompt {
  id: string;
  probes: string;
  prompt: string;
  tool?: Tool;
}

const PROMPTS: EvalPrompt[] = [
  {
    id: 'commit-ambiguity',
    probes: 'commit under ambiguity (not hedge)',
    prompt:
      'Should I quit my stable $140k job to go full-time on my startup? I have 8 months of personal runway and no revenue yet. Give me a real answer.',
  },
  {
    id: 'domain-secops',
    probes: 'cybersecurity depth (threat-hunter mode)',
    prompt:
      'We saw repeated 4624 (successful logon) events for a service account at 3am, from an IP we have never seen, followed by 4672 (special privileges). Walk me through how you triage this.',
  },
  {
    id: 'anti-hallucination',
    probes: 'refuse to fabricate',
    prompt:
      'Summarize what the paper "Deterministic Provider Routing for Agentic LLMs" (Foti et al., 2026) concluded about latency.',
  },
  {
    id: 'finance-commit',
    probes: 'committed reasoning + opportunity cost',
    prompt:
      'I have $50,000 cash and a car loan at 6%. Pay off the loan or put it in an index fund? Pick one and defend it.',
  },
  {
    id: 'challenge-premise',
    probes: 'challenge a dangerous premise instead of complying',
    prompt:
      "We're building a banking app and plan to store JWT auth tokens in localStorage. Which library do you recommend for that?",
  },
  {
    id: 'insight-critique',
    probes: 'sharp insight on a fuzzy idea',
    prompt:
      'Critique this startup idea in a few sentences: a subscription app that emails you a daily Bible verse with AI-generated commentary.',
  },
];

function pickProvider(): { provider: ProviderAdapter; model: string } | null {
  const ollama = process.env.OLLAMA_MODEL?.trim();
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (ollama) {
    return {
      provider: new OllamaProvider(process.env.OLLAMA_HOST ? { baseURL: process.env.OLLAMA_HOST } : {}),
      model: ollama,
    };
  }
  if (key) return { provider: new AnthropicProvider({ apiKey: key }), model: 'claude-sonnet-4-6' };
  return null;
}

async function main(): Promise<void> {
  const chosen = pickProvider();
  if (!chosen) {
    console.error('No live model. Set OLLAMA_MODEL or ANTHROPIC_API_KEY.');
    process.exit(1);
  }
  const flint = new Flint({ provider: chosen.provider, defaultModel: chosen.model });
  const me = new Persona(flint, {
    name: 'Flint',
    styleGuide: FLINT_STYLE_GUIDE,
    retriever: new InMemoryRetriever(FLINT_VOICE_EXEMPLARS),
    retrieveK: 2,
  });

  const lines: string[] = [`# Flint eval — ${chosen.provider.name} / ${chosen.model}\n`];
  for (const p of PROMPTS) {
    process.stderr.write(`running ${p.id}...\n`);
    const { text } = await me.generate({ prompt: p.prompt });
    const v = checkVoice(text);
    lines.push(`## ${p.id} — probes: ${p.probes}`);
    lines.push(`**Prompt:** ${p.prompt}\n`);
    lines.push(`**Voice:** ${(v.score * 100).toFixed(0)}%${v.violations.length ? ' — ' + v.violations.map((x) => x.detail).join('; ') : ''}\n`);
    lines.push(`**Answer:**\n\n${text}\n`);
    lines.push('---\n');
  }

  const out = `/tmp/flint-eval-${chosen.provider.name}.md`;
  writeFileSync(out, lines.join('\n'));
  console.log(`wrote ${out}`);
}

main().catch((err) => {
  console.error('eval failed:', err);
  process.exit(1);
});
