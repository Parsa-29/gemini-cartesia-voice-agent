import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `prompts/` at the project root (same relative path from src/server and dist/server). */
const PROMPTS_DIR = fileURLToPath(new URL('../../prompts/', import.meta.url));

export interface Prompts {
  /** prompts/system.md — who the agent is and what it does. */
  system: string;
  /** prompts/voice-rules.md — how to talk so the TTS sounds natural. Always appended. */
  voiceRules: string;
  /** prompts/greeting.txt — first line the agent speaks; empty = wait for the user. */
  greeting: string;
}

/** Read fresh on every call, so prompt edits apply to the next call without a restart. */
export function loadPrompts(): Prompts {
  return {
    system: readPrompt('system.md'),
    voiceRules: readPrompt('voice-rules.md'),
    greeting: readPrompt('greeting.txt'),
  };
}

const LANGUAGE_NAMES: Record<string, string> = {
  ka: 'Georgian',
  en: 'English',
  ru: 'Russian',
  uk: 'Ukrainian',
  tr: 'Turkish',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  ar: 'Arabic',
  he: 'Hebrew',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  hi: 'Hindi',
};

export function buildSystemInstruction(parts: {
  systemPrompt: string;
  voiceRules: string;
  greeting: string;
  /** The TTS voice's language code; the agent must answer in it. */
  language: string;
}): string {
  const language = LANGUAGE_NAMES[parts.language.split('-')[0] ?? ''] ?? parts.language;
  const sections = [
    parts.systemPrompt.trim(),
    parts.voiceRules.trim(),
    [
      '## Language',
      `Always reply in ${language}, even if the user seems to speak another language: the voice can only speak ${language}.`,
    ].join('\n'),
  ];
  const greeting = parts.greeting.trim();
  if (greeting) {
    sections.push(
      [
        '## Conversation start',
        `The call has already started: you opened it by saying "${greeting}".`,
        'Do not greet again. Wait for the user and continue naturally from there.',
      ].join('\n'),
    );
  }
  return sections.filter(Boolean).join('\n\n');
}

function readPrompt(name: string): string {
  try {
    return readFileSync(join(PROMPTS_DIR, name), 'utf8').trim();
  } catch {
    return '';
  }
}
