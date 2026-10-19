/**
 * Turns the agent's streaming transcript into speakable chunks for Cartesia.
 *
 * Cartesia keeps prosody continuous across chunks of one context (continuations),
 * so chunks don't need to be whole sentences — but sentence-sized chunks with
 * closing punctuation give the best intonation.
 *
 * The first chunk is the exception: Gemini's transcript arrives in bursts a few
 * hundred ms apart, so the first complete words are sent at once. Their audio
 * plays while the rest of the sentence arrives, which hides that gap.
 */

export interface SpeechChunkerOptions {
  /** Language code; `ka` enables question-mark inference for unpunctuated Georgian. */
  language?: string;
  /** First chunk: minimum length before it may end at a clause mark or word boundary. */
  firstMinChars?: number;
  /** Later chunks: earliest length at which a clause mark (`,;:`) may end them. */
  clauseMinChars?: number;
  /** Later chunks: force a word-boundary cut beyond this length. */
  maxChars?: number;
}

const SENTENCE_END = new Set(['.', '!', '?', '…']);
const CLAUSE_END = new Set([',', ';', ':']);

export class SpeechChunker {
  private buffer = '';
  private emitted = 0;
  private readonly language: string | undefined;
  private readonly firstMinChars: number;
  private readonly clauseMinChars: number;
  private readonly maxChars: number;

  constructor(options: SpeechChunkerOptions = {}) {
    this.language = options.language;
    this.firstMinChars = options.firstMinChars ?? 8;
    this.clauseMinChars = options.clauseMinChars ?? 80;
    this.maxChars = options.maxChars ?? 160;
  }

  /** Add a transcript delta; returns chunks that are ready to speak. */
  push(delta: string): string[] {
    if (!delta) return [];
    this.buffer += delta;
    const chunks: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (!cut) break;
      const piece = tidy(this.buffer.slice(0, cut.end));
      this.buffer = this.buffer.slice(cut.end).replace(/^\s+/, '');
      if (!piece) continue;
      chunks.push(cut.closeSentence ? finishSentence(piece, this.language) : piece);
      this.emitted += 1;
    }
    return chunks;
  }

  /** End of the turn: return whatever is left as a closed sentence. */
  flush(): string[] {
    const rest = tidy(this.buffer);
    this.buffer = '';
    if (!rest) return [];
    this.emitted += 1;
    return [finishSentence(rest, this.language)];
  }

  /** Drop buffered text (barge-in) and start the next turn fresh. */
  reset(): void {
    this.buffer = '';
    this.emitted = 0;
  }

  private findCut(): { end: number; closeSentence: boolean } | null {
    const text = this.buffer;
    const first = this.emitted === 0;
    const clauseMin = first ? this.firstMinChars : this.clauseMinChars;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      const next = text[i + 1];
      if (ch === '\n') return { end: i, closeSentence: true };
      if (SENTENCE_END.has(ch)) {
        if (next !== undefined && /\s/.test(next)) return { end: i + 1, closeSentence: false };
        // A terminator at the very end is final unless it may be a decimal point ("3." + "5").
        if (next === undefined && !(ch === '.' && /\d/.test(text[i - 1] ?? ''))) {
          return { end: i + 1, closeSentence: false };
        }
      }
      if (CLAUSE_END.has(ch) && i + 1 >= clauseMin && next !== undefined && /\s/.test(next)) {
        return { end: i + 1, closeSentence: false };
      }
    }

    if (first) {
      // Everything up to the last whitespace is complete words; the tail may be cut mid-word.
      const space = text.search(/\s\S*$/);
      if (space >= this.firstMinChars) return { end: space, closeSentence: false };
      return null;
    }
    if (text.length > this.maxChars) {
      const space = text.slice(0, this.maxChars + 1).search(/\s\S*$/);
      if (space > 0) return { end: space, closeSentence: false };
    }
    return null;
  }
}

const KA_QUESTION_START =
  /^(რა|რატომ|სად|საიდან|სადამდე|როდის|როგორ|ვინ|ვის|რომელ\S*|რამდენ\S*|ხომ|განა|ნუთუ)(\s|$)/u;
const KA_QUESTION_PARTICLE = /(^|\s)ხომ(\s|$)/u;

/** Make sure the text ends like a finished sentence so the TTS closes its intonation. */
export function finishSentence(text: string, language?: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const last = trimmed.at(-1)!;
  if (SENTENCE_END.has(last)) return trimmed;
  const body = CLAUSE_END.has(last) ? trimmed.slice(0, -1) : trimmed;
  return `${body}${looksLikeQuestion(body, language) ? '?' : '.'}`;
}

function looksLikeQuestion(sentence: string, language?: string): boolean {
  if (language !== 'ka') return false;
  return KA_QUESTION_START.test(sentence) || KA_QUESTION_PARTICLE.test(sentence);
}

function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
