import { describe, expect, it } from 'vitest';
import { SpeechChunker, finishSentence } from '../src/server/session/SpeechChunker.js';

describe('SpeechChunker', () => {
  it('emits each sentence as soon as its terminator arrives', () => {
    const chunker = new SpeechChunker();
    expect(chunker.push('Hello there. How')).toEqual(['Hello there.']);
    expect(chunker.push(' are you?')).toEqual(['How are you?']);
  });

  it('holds text without a boundary until flush, then closes the sentence', () => {
    const chunker = new SpeechChunker();
    expect(chunker.push('Hello')).toEqual([]);
    expect(chunker.flush()).toEqual(['Hello.']);
    expect(chunker.flush()).toEqual([]);
  });

  it('does not split a decimal number across deltas', () => {
    const chunker = new SpeechChunker();
    chunker.push('First sentence. ');
    expect(chunker.push('It costs 3.')).toEqual([]);
    expect(chunker.push('5 lari. Ok')).toEqual(['It costs 3.5 lari.']);
  });

  it('keeps an ellipsis together', () => {
    const chunker = new SpeechChunker();
    expect(chunker.push('Well... maybe')).toEqual(['Well...']);
  });

  it('cuts the first chunk early at a clause boundary to start speaking sooner', () => {
    const chunker = new SpeechChunker();
    expect(chunker.push('Absolutely right, let me check')).toEqual(['Absolutely right,']);
    // Later chunks wait for a full sentence instead of short clauses.
    expect(chunker.push(' first, then')).toEqual([]);
    expect(chunker.push(' answer.')).toEqual(['let me check first, then answer.']);
  });

  it('sends the first complete words right away so audio starts sooner', () => {
    // Gemini's transcript arrives in bursts; waiting for the sentence end costs ~0.5 s.
    const chunker = new SpeechChunker();
    expect(chunker.push('კვირაში შვიდი ')).toEqual(['კვირაში შვიდი']);
    expect(chunker.push('დღეა. კიდევ')).toEqual(['დღეა.']);
  });

  it('holds back a possibly unfinished last word of the first chunk', () => {
    const chunker = new SpeechChunker();
    expect(chunker.push('Hello wor')).toEqual([]);
    expect(chunker.push('ld and mo')).toEqual(['Hello world and']);
    expect(chunker.flush()).toEqual(['mo.']);
  });

  it('waits for a few characters before the first eager cut', () => {
    const chunker = new SpeechChunker();
    expect(chunker.push('Ok so ')).toEqual([]);
    expect(chunker.push('here we go ')).toEqual(['Ok so here we go']);
  });

  it('cuts later chunks at a clause boundary only when they are long', () => {
    const chunker = new SpeechChunker();
    chunker.push('First sentence. ');
    const long = 'This clause is deliberately quite long so that it passes the eighty character mark,';
    expect(chunker.push(`${long} and more`)).toEqual([long]);
  });

  it('forces a word-boundary cut on very long later chunks', () => {
    const chunker = new SpeechChunker();
    chunker.push('First sentence. ');
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const [chunk] = chunker.push(words);
    expect(chunk).toBeDefined();
    expect(chunk!.length).toBeLessThanOrEqual(160);
    expect(chunk!.length).toBeGreaterThan(100);
  });

  it('treats a newline as a sentence boundary', () => {
    const chunker = new SpeechChunker();
    expect(chunker.push('Line one\nLine two')).toEqual(['Line one.']);
  });

  it('collapses whitespace inside chunks', () => {
    const chunker = new SpeechChunker();
    expect(chunker.push('Hello   world.  Next')).toEqual(['Hello world.']);
  });

  it('reset drops buffered text and restarts first-chunk behaviour', () => {
    const chunker = new SpeechChunker();
    chunker.push('First sentence. dangling');
    chunker.reset();
    expect(chunker.flush()).toEqual([]);
    expect(chunker.push('Absolutely right, again')).toEqual(['Absolutely right,']);
  });
});

describe('finishSentence', () => {
  it('keeps existing terminal punctuation', () => {
    expect(finishSentence('Done!')).toBe('Done!');
    expect(finishSentence('Really?')).toBe('Really?');
  });

  it('replaces a dangling clause mark with a period', () => {
    expect(finishSentence('and then,')).toBe('and then.');
  });

  it('infers a question mark for Georgian questions', () => {
    expect(finishSentence('რა გქვია', 'ka')).toBe('რა გქვია?');
    expect(finishSentence('ხომ კარგად ხარ', 'ka')).toBe('ხომ კარგად ხარ?');
    expect(finishSentence('რამდენი წლის ხარ', 'ka')).toBe('რამდენი წლის ხარ?');
    expect(finishSentence('კარგად ვარ', 'ka')).toBe('კარგად ვარ.');
  });

  it('does not guess questions for other languages', () => {
    expect(finishSentence('რა გქვია', 'en')).toBe('რა გქვია.');
  });
});
