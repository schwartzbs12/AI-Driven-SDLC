import Anthropic from '@anthropic-ai/sdk';
import { ProductBrief } from '../types/index';
import { ask, askMultiline, section, info } from '../utils/cli';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a senior product manager and requirements analyst. Your job is to deeply understand what a user wants to build and extract a comprehensive product brief.

Given the user's raw goal, you will:
1. Generate 5-7 targeted follow-up questions that will uncover: personas, core workflows, constraints, edge cases, risks, and technical preferences.
2. After receiving answers, synthesize everything into a structured ProductBrief JSON.

Always ask about failure modes, scale expectations, security requirements, and integration needs.`;

export async function runIntakeAgent(
  rawGoal: string,
  followUpAnswers: string
): Promise<ProductBrief> {
  section('Intake Agent â€” Synthesizing product brief...');

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 8192,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Original goal: ${rawGoal}\n\nFollow-up answers:\n${followUpAnswers}\n\nNow synthesize a complete ProductBrief. Return ONLY valid JSON matching this exact structure:\n{\n  "userGoal": string,\n  "personas": string[],\n  "coreFlows": string[],\n  "constraints": string[],\n  "edgeCases": string[],\n  "risks": string[],\n  "techPreferences": string,\n  "successCriteria": string[]\n}`,
      },
    ],
  });

  const raw = (response.content[0] as { type: string; text: string }).text;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Intake Agent did not return valid JSON');

  return JSON.parse(jsonMatch[0]) as ProductBrief;
}

export async function generateFollowUpQuestions(rawGoal: string): Promise<string[]> {
  section('Intake Agent â€” Generating follow-up questions...');

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `The user wants to build: "${rawGoal}"\n\nGenerate 5-7 targeted follow-up questions to extract personas, workflows, constraints, edge cases, risks, and tech preferences. Return ONLY a JSON array of question strings. No explanations.`,
      },
    ],
  });

  const raw = (response.content[0] as { type: string; text: string }).text;
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('Intake Agent did not return valid questions JSON');

  return JSON.parse(jsonMatch[0]) as string[];
}

export async function runIntakeFlow(rawGoal: string): Promise<ProductBrief> {
  const questions = await generateFollowUpQuestions(rawGoal);

  console.log('\nTo build the best architecture, please answer the following:');
  const answers: string[] = [];

  for (let i = 0; i < questions.length; i++) {
    const answer = await ask(`Q${i + 1}: ${questions[i]}`);
    answers.push(`Q: ${questions[i]}\nA: ${answer}`);
  }

  const followUpAnswers = answers.join('\n\n');
  const brief = await runIntakeAgent(rawGoal, followUpAnswers);

  info('Product brief complete.');
  return brief;
}
