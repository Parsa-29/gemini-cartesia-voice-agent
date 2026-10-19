import type { PublicConfig, SessionOverrides } from '../shared/protocol.js';
import type { AppConfig } from './config.js';
import { buildSystemInstruction, loadPrompts } from './prompts.js';
import { CartesiaVoice } from './session/CartesiaVoice.js';
import { GeminiBrain } from './session/GeminiBrain.js';
import { VoiceSession } from './session/VoiceSession.js';
import type { SessionOutput } from './session/types.js';

/** Wire one call: prompts + overrides → Gemini brain + Cartesia voice → session. */
export function createVoiceSession(
  config: AppConfig,
  overrides: SessionOverrides | undefined,
  output: SessionOutput,
  log: (message: string) => void,
): VoiceSession {
  const prompts = loadPrompts();
  const allowed = config.allowClientOverrides ? overrides : undefined;

  const systemPrompt = allowed?.systemPrompt?.trim() || prompts.system;
  const greeting = (allowed?.greeting ?? prompts.greeting).trim();
  const systemInstruction = buildSystemInstruction({
    systemPrompt,
    voiceRules: prompts.voiceRules,
    greeting,
    language: config.cartesia.language,
  });

  const voice = new CartesiaVoice({
    ...config.cartesia,
    voiceId: allowed?.voiceId?.trim() || config.cartesia.voiceId,
    speed: allowed?.speed ?? config.cartesia.speed,
    log: (message) => log(`[cartesia] ${message}`),
  });

  return new VoiceSession({
    brainFactory: (events) =>
      new GeminiBrain(
        {
          apiKey: config.gemini.apiKey,
          model: config.gemini.model,
          systemInstruction,
          inputLanguage: config.gemini.inputLanguage,
          vad: config.gemini.vad,
          log: (message) => log(`[gemini] ${message}`),
        },
        events,
      ),
    voice,
    output,
    greeting,
    outputSampleRate: config.cartesia.sampleRate,
    language: config.cartesia.language,
    bargeInMinChars: config.bargeInMinChars,
    log,
  });
}

export function publicConfig(config: AppConfig): PublicConfig {
  const prompts = loadPrompts();
  return {
    systemPrompt: prompts.system,
    greeting: prompts.greeting,
    voiceId: config.cartesia.voiceId,
    speed: config.cartesia.speed,
    language: config.cartesia.language,
    geminiModel: config.gemini.model,
    cartesiaModel: config.cartesia.model,
    outputSampleRate: config.cartesia.sampleRate,
    allowOverrides: config.allowClientOverrides,
  };
}
