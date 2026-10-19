import { describe, expect, it } from 'vitest';
import { buildSystemInstruction } from '../src/server/prompts.js';

describe('buildSystemInstruction', () => {
  const base = { systemPrompt: 'You are Nino.', voiceRules: '## How you speak\nShort.', greeting: '', language: 'en' };

  it('joins the system prompt and voice rules', () => {
    const text = buildSystemInstruction(base);
    expect(text.startsWith('You are Nino.\n\n## How you speak\nShort.')).toBe(true);
  });

  it('pins the reply language to the voice language', () => {
    const text = buildSystemInstruction({ ...base, language: 'ka' });
    expect(text).toContain('Always reply in Georgian');
    expect(text).toContain('even if the user seems to speak another language');
  });

  it('falls back to the language code for unknown languages', () => {
    expect(buildSystemInstruction({ ...base, language: 'xx' })).toContain('Always reply in xx');
  });

  it('tells Gemini the greeting was already spoken', () => {
    const text = buildSystemInstruction({ ...base, greeting: 'Hi, I am Nino.' });
    expect(text).toContain('you opened it by saying "Hi, I am Nino."');
    expect(text).toContain('Do not greet again');
  });

  it('omits the greeting section when there is no greeting', () => {
    expect(buildSystemInstruction(base)).not.toContain('Conversation start');
  });
});
