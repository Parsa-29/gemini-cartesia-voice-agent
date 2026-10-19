import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());
const withDefault = <T extends z.ZodType>(schema: T, fallback: z.input<T>) =>
  z.preprocess(blankToUndefined, schema.default(fallback as never));

const sensitivity = z.enum(['LOW', 'HIGH']);

const envSchema = z.object({
  NODE_ENV: withDefault(z.string(), 'development'),
  PORT: withDefault(z.coerce.number().int().min(0), 4000),
  ALLOW_CLIENT_OVERRIDES: withDefault(z.enum(['true', 'false']), 'true'),

  GEMINI_API_KEY: optional(z.string()),
  GOOGLE_API_KEY: optional(z.string()),
  GEMINI_LIVE_MODEL: withDefault(z.string(), 'gemini-3.8-live'),
  GEMINI_INPUT_LANGUAGE: optional(z.string()),
  GEMINI_VAD_SILENCE_MS: optional(z.coerce.number().int().min(0)),
  GEMINI_VAD_PREFIX_PADDING_MS: optional(z.coerce.number().int().min(0)),
  GEMINI_VAD_START_SENSITIVITY: optional(sensitivity),
  GEMINI_VAD_END_SENSITIVITY: optional(sensitivity),

  CARTESIA_API_KEY: optional(z.string()),
  CARTESIA_VOICE_ID: optional(z.string()),
  CARTESIA_MODEL: withDefault(z.string(), 'sonic-3.6'),
  CARTESIA_LANGUAGE: withDefault(z.string(), 'ka'),
  CARTESIA_SAMPLE_RATE: withDefault(
    z.coerce.number().refine((rate) => [8000, 16000, 22050, 24000, 44100, 48000].includes(rate), {
      message: 'must be one of 8000, 16000, 22050, 24000, 44100, 48000',
    }),
    24000,
  ),
  CARTESIA_SPEED: withDefault(z.coerce.number().min(0.6).max(1.5), 1),
  CARTESIA_VOLUME: withDefault(z.coerce.number().min(0.5).max(2), 1),
  CARTESIA_PRONUNCIATION_DICT_ID: optional(z.string()),
  CARTESIA_MAX_BUFFER_DELAY_MS: withDefault(z.coerce.number().int().min(0).max(5000), 0),

  BARGE_IN_MIN_CHARS: withDefault(z.coerce.number().int().min(1), 3),
});

export interface AppConfig {
  dev: boolean;
  port: number;
  allowClientOverrides: boolean;
  bargeInMinChars: number;
  gemini: {
    apiKey: string;
    model: string;
    /** Language hint for the user transcript; undefined = auto-detect. */
    inputLanguage?: string;
    vad: {
      silenceDurationMs?: number;
      prefixPaddingMs?: number;
      startSensitivity?: 'LOW' | 'HIGH';
      endSensitivity?: 'LOW' | 'HIGH';
    };
  };
  cartesia: {
    apiKey: string;
    model: string;
    voiceId: string;
    language: string;
    sampleRate: number;
    speed: number;
    volume: number;
    pronunciationDictId?: string;
    maxBufferDelayMs: number;
  };
}

/** Reads and validates the environment; throws a readable error listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment:\n${problems.join('\n')}`);
  }
  const e = parsed.data;

  const missing: string[] = [];
  const geminiKey = e.GEMINI_API_KEY ?? e.GOOGLE_API_KEY;
  if (!geminiKey) missing.push('GEMINI_API_KEY');
  if (!e.CARTESIA_API_KEY) missing.push('CARTESIA_API_KEY');
  if (!e.CARTESIA_VOICE_ID) missing.push('CARTESIA_VOICE_ID');
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(', ')}. Copy .env.example to .env and fill them in.`);
  }

  return {
    dev: e.NODE_ENV !== 'production',
    port: e.PORT,
    allowClientOverrides: e.ALLOW_CLIENT_OVERRIDES === 'true',
    bargeInMinChars: e.BARGE_IN_MIN_CHARS,
    gemini: {
      apiKey: geminiKey!,
      model: e.GEMINI_LIVE_MODEL,
      // Default: the user speaks the agent's language. `auto` lets Gemini detect it.
      inputLanguage:
        e.GEMINI_INPUT_LANGUAGE === 'auto' ? undefined : (e.GEMINI_INPUT_LANGUAGE ?? e.CARTESIA_LANGUAGE),
      vad: {
        silenceDurationMs: e.GEMINI_VAD_SILENCE_MS,
        prefixPaddingMs: e.GEMINI_VAD_PREFIX_PADDING_MS,
        startSensitivity: e.GEMINI_VAD_START_SENSITIVITY,
        endSensitivity: e.GEMINI_VAD_END_SENSITIVITY,
      },
    },
    cartesia: {
      apiKey: e.CARTESIA_API_KEY!,
      model: e.CARTESIA_MODEL,
      voiceId: e.CARTESIA_VOICE_ID!,
      language: e.CARTESIA_LANGUAGE,
      sampleRate: e.CARTESIA_SAMPLE_RATE,
      speed: e.CARTESIA_SPEED,
      volume: e.CARTESIA_VOLUME,
      pronunciationDictId: e.CARTESIA_PRONUNCIATION_DICT_ID,
      maxBufferDelayMs: e.CARTESIA_MAX_BUFFER_DELAY_MS,
    },
  };
}
