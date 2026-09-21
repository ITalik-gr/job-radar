import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { facts } from '../db/schema.js';
import { log } from '../lib/log.js';
import { callModelWith, extractJson, noteLlmCall, remainingBudget } from './classify.js';
import type { DraftCandidate, Language } from './outreach.js';

/**
 * Personalising the first paragraph of a letter, section 4 of OUTREACH.md.
 *
 * The model proposes, the code decides. Everything it returns goes through a deterministic
 * check, and any suspicion means falling back to the static paragraph from the template. The
 * system never sends a letter without a first paragraph and is never blocked by the model: a
 * made-up fact in a cold letter costs more than template text instead of a personalised one.
 *
 * ONLY the first paragraph is personalised. The second holds facts about the owner, and
 * generating it would risk made-up experience in a letter to a stranger.
 */

/** v3 moved the prompt itself to English; the output language is still set per letter. */
export const AI_PROMPT_VERSION = 'outreach-intro-v3';

export const paragraphSchema = z.object({
  paragraph: z.string(),
  facts_used: z.array(z.string()).default([]),
  confidence: z.number(),
});

export type ParagraphResponse = z.infer<typeof paragraphSchema>;

export const MIN_WORDS = 20;
export const MAX_WORDS = 60;
export const MIN_CONFIDENCE = 60;

/** Words that make a letter read like a mass mailing. The list comes from OUTREACH.md. */
export const STOP_PHRASES = [
  'excited',
  'passionate',
  'thrilled',
  'reach out',
  'i hope this finds you well',
  'delighted',
  'game changer',
  'cutting edge',
];

export interface CompanyFacts {
  name: string;
  domain: string;
  city: string | null;
  country: string | null;
  size: string | null;
  tech_hints: string[];
  tags: string[];
  description: string | null;
  vacancy_title: string | null;
  vacancy_stack: string[];
}

/**
 * Model input: only what the database already has on this company.
 *
 * The description is cut to 400 characters on purpose. Longer text adds no understanding for
 * the model, but gives it more material to start inventing from.
 */
export function companyFacts(candidate: DraftCandidate): CompanyFacts {
  return {
    name: candidate.company,
    domain: candidate.domain,
    city: candidate.city,
    country: candidate.country,
    size: candidate.sizeHint ?? null,
    tech_hints: candidate.techHints.slice(0, 10),
    tags: (candidate.tags ?? []).slice(0, 10),
    description: candidate.description ? candidate.description.slice(0, 400) : null,
    vacancy_title: candidate.vacancyTitle,
    vacancy_stack: candidate.vacancyStack,
  };
}

export function buildPrompt(language: Language, ownerFacts: string[]): string {
  return [
    'You write the first paragraph of a cold letter from a developer to a company.',
    '',
    'The LETTER block holds the whole letter, where the {{intro}} marker is the place for your paragraph.',
    'Read it: further on the sender says who they are and what they offer. Your paragraph',
    'must lead into exactly that text and must not repeat what it already says.',
    '',
    'What this paragraph is:',
    '1. The reason the letter is written to this particular company. One or two sentences.',
    '2. Address the reader directly ("you", "your"; in Ukrainian "ви" or "ти"), this is a letter to a person, not a reference entry.',
    '3. Do NOT retell the company description from their site. A sentence like "X is a web development',
    '   company based in London that specializes in..." is not a letter, it is a catalog excerpt,',
    '   and the reader knows more about themselves than you do. Instead of a description, name what makes',
    '   the approach relevant: their stack, type of work, market, team size.',
    '4. No compliments and no judgement of their work ("great work", "love your site"):',
    '   you have not seen their projects, and it shows.',
    '',
    'Constraints:',
    '5. Use ONLY facts from the COMPANY block. If there are few facts, write more generally,',
    '   but do NOT invent projects, clients, awards, numbers or news.',
    '6. Forbidden: em dash, exclamation mark, the words excited, passionate, thrilled,',
    '   reach out, I hope this finds you well, and "not X but Y" constructions.',
    '7. No greeting and no signature, the letter already has them.',
    `8. Language: ${language}.`,
    ...(ownerFacts.length > 0
      ? ['', 'About the sender you may mention only this:', ...ownerFacts.map((item) => `- ${item}`)]
      : []),
    '',
    'Return STRICTLY JSON with no markdown and no preamble:',
    '{"paragraph": "...", "facts_used": ["..."], "confidence": 0-100}',
  ].join('\n');
}

export interface Validation {
  ok: boolean;
  /** Fallback reason. Logged and counted in the per-reason statistics. */
  reason?: string;
  /** The text after the allowed automatic fixes. Empty on fallback. */
  paragraph?: string;
}

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function sentences(text: string): number {
  return text.split(/[.!?]+(?:\s|$)/).filter((part) => part.trim().length > 0).length;
}

/**
 * Proper names and numbers from the paragraph. Each must appear in the input, otherwise the
 * model made it up.
 *
 * The first word of a sentence is skipped: a capital letter there marks the start of a
 * sentence, not a name, and without this every other valid paragraph would fall back.
 */
export function coinedTokens(paragraph: string, source: string): string[] {
  const haystack = source.toLowerCase();
  const coined: string[] = [];

  for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
    const tokens = sentence.trim().split(/\s+/);
    tokens.forEach((rawToken, index) => {
      const token = rawToken.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (!token) return;

      const isNumber = /^\d[\d.,%]*$/.test(token);
      const isProper = index > 0 && /^\p{Lu}/u.test(token) && token.length > 2;
      if (!isNumber && !isProper) return;
      if (!haystack.includes(token.toLowerCase())) coined.push(token);
    });
  }

  return [...new Set(coined)];
}

/**
 * Deterministic check of the model response. Ordered from cheapest to most expensive.
 *
 * An em dash does not cause a fallback, it is replaced with a comma: that is the only fix after
 * which the text stays the same text. Every other violation means a fallback, because code
 * cannot repair someone else's invention.
 */
/** Whether the paragraph addresses the reader. A letter without that is a reference entry about the company. */
export function addressesReader(paragraph: string, language: Language): boolean {
  const lower = paragraph.toLowerCase();
  const markers =
    language === 'uk'
      ? [/\bви\b/, /\bвас\b/, /\bвам\b/, /\bваш/, /\bти\b/, /\bтво/]
      : [/\byou\b/, /\byour\b/, /\byou're\b/, /\byouve\b/, /\byou've\b/];
  return markers.some((marker) => marker.test(lower));
}

/** The longest shared run of words between the paragraph and the company description. */
export function longestSharedRun(paragraph: string, description: string | null): number {
  if (!description) return 0;
  const clean = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);

  const a = clean(paragraph);
  const b = clean(description);
  let best = 0;

  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      let run = 0;
      while (i + run < a.length && j + run < b.length && a[i + run] === b[j + run]) run += 1;
      if (run > best) best = run;
    }
  }

  return best;
}

/** A longer match means the paragraph was copied from the company description rather than written. */
export const MAX_SHARED_RUN = 7;

export function validateParagraph(
  response: ParagraphResponse,
  sourceJson: string,
  context: { language?: Language; description?: string | null } = {},
): Validation {
  const paragraph = response.paragraph.replace(/\s*—\s*/g, ', ').trim();

  if (!paragraph) return { ok: false, reason: 'empty paragraph' };
  if (response.confidence < MIN_CONFIDENCE) {
    return { ok: false, reason: `low confidence: ${response.confidence}` };
  }

  const count = sentences(paragraph);
  if (count < 1 || count > 3) return { ok: false, reason: `${count} sentences, need 1-3` };

  const length = words(paragraph);
  if (length < MIN_WORDS || length > MAX_WORDS) {
    return { ok: false, reason: `${length} words, need ${MIN_WORDS}-${MAX_WORDS}` };
  }

  if (paragraph.includes('!')) return { ok: false, reason: 'exclamation mark' };

  const lower = paragraph.toLowerCase();
  const stop = STOP_PHRASES.find((phrase) => lower.includes(phrase));
  if (stop) return { ok: false, reason: `stop word: ${stop}` };

  if (/\bnot\s+[\w\s]{1,20}\bbut\b/i.test(paragraph)) {
    return { ok: false, reason: 'not X but Y construction' };
  }

  const coined = coinedTokens(paragraph, sourceJson);
  if (coined.length > 0) {
    return { ok: false, reason: `invented entities: ${coined.join(', ')}` };
  }

  /*
   * Two checks against the most common defect: a paragraph that retells the catalog
   * description of the company. Formally it is flawless, invents nothing and passes every
   * earlier check, but it does not work as a letter: the reader knows more about themselves
   * than is written there, and sees autofill.
   */
  if (context.language && !addressesReader(paragraph, context.language)) {
    return { ok: false, reason: 'the paragraph does not address the reader, it describes the company' };
  }

  const shared = longestSharedRun(paragraph, context.description ?? null);
  if (shared > MAX_SHARED_RUN) {
    return { ok: false, reason: `retells the company description, ${shared} words in a row` };
  }

  return { ok: true, paragraph };
}

export interface ParagraphResult {
  /** Ready text, or null on fallback to the template. */
  paragraph: string | null;
  used: boolean;
  reason: string | null;
  confidence: number | null;
}

export type ModelCaller = (system: string, user: string) => Promise<string>;

async function defaultCaller(system: string, user: string): Promise<string> {
  /*
   * Temperature 0.7: the paragraph should sound like a person wrote it, not like a database
   * excerpt. The model is separate and stronger than the classifier: one call per company that
   * really gets a letter, and a person will read it.
   */
  const raw = await callModelWith(system, user, 0.7, config.llm.outreachModel);
  await noteLlmCall(raw.inputTokens, raw.outputTokens);
  return raw.text;
}

/** Active facts about the owner that the model may mention. */
export async function activeFacts(language: Language): Promise<string[]> {
  const rows = await getDb().select().from(facts).where(eq(facts.isActive, true));
  return rows.map((row) => (language === 'uk' ? row.textUk : row.textEn)).filter(Boolean);
}

/**
 * One call per company. The result is cached in `outreach.ai_paragraph`, and regeneration
 * happens only on an explicit button: background regenerations are a bill that grows by itself
 * and improves nothing.
 */
export interface ParagraphContext {
  /** Template body with the {{intro}} marker. The model has to see what the paragraph fits into. */
  letter?: string | null;
  subject?: string | null;
}

export async function generateParagraph(
  candidate: DraftCandidate,
  language: Language,
  context: ParagraphContext = {},
  caller: ModelCaller = defaultCaller,
): Promise<ParagraphResult> {
  if ((await remainingBudget()) <= 0) {
    return { paragraph: null, used: false, reason: 'daily model call limit', confidence: null };
  }

  const sourceJson = JSON.stringify(companyFacts(candidate), null, 2);
  const system = buildPrompt(language, await activeFacts(language));

  /*
   * The whole letter is passed in. Without it the model saw only the company card and wrote a
   * reference entry about it: formally by the rules, and useless as the first paragraph of a
   * letter. The paragraph has to lead into the text that follows, and the only way to see that
   * text is to show it.
   */
  const user = [
    context.subject ? `SUBJECT:\n${context.subject}` : null,
    context.letter ? `LETTER:\n${context.letter}` : null,
    `COMPANY:\n${sourceJson}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  // One retry on invalid JSON, then fallback. Running the model in circles is expensive.
  let lastReason = 'the model did not answer';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const parsed = paragraphSchema.safeParse(extractJson(await caller(system, user)));
      if (!parsed.success) {
        lastReason = 'invalid JSON';
        continue;
      }

      const validation = validateParagraph(parsed.data, sourceJson, {
        language,
        description: candidate.description,
      });
      if (validation.ok) {
        return {
          paragraph: validation.paragraph!,
          used: true,
          reason: null,
          confidence: parsed.data.confidence,
        };
      }

      // Validation is not a connection failure: a second call gives the same class of problem.
      log.info({ company: candidate.company, reason: validation.reason }, 'AI paragraph fallback');
      return {
        paragraph: null,
        used: false,
        reason: validation.reason ?? 'unknown reason',
        confidence: parsed.data.confidence,
      };
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
  }

  log.warn({ company: candidate.company, reason: lastReason }, 'AI paragraph fallback');
  return { paragraph: null, used: false, reason: lastReason, confidence: null };
}
