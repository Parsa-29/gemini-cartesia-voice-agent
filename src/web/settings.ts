import type { PublicConfig, SessionOverrides } from '../shared/protocol.js';

const STORAGE_KEY = 'voice-agent:overrides';

/**
 * Per-browser overrides from the settings panel. Only fields that differ from
 * the server defaults are stored, so edits to prompts/*.md still take effect
 * for everything the user hasn't customised here.
 */
export function loadOverrides(): SessionOverrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SessionOverrides) : {};
  } catch {
    return {};
  }
}

export function saveOverrides(values: Required<SessionOverrides>, defaults: PublicConfig): SessionOverrides {
  const overrides: SessionOverrides = {};
  if (values.systemPrompt.trim() !== defaults.systemPrompt.trim()) overrides.systemPrompt = values.systemPrompt;
  if (values.greeting.trim() !== defaults.greeting.trim()) overrides.greeting = values.greeting;
  if (values.voiceId.trim() !== defaults.voiceId) overrides.voiceId = values.voiceId.trim();
  if (values.speed !== defaults.speed) overrides.speed = values.speed;
  try {
    if (Object.keys(overrides).length > 0) localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable (private mode): overrides still apply to this page
  }
  return overrides;
}

export function clearOverrides(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Effective values: defaults with overrides applied. */
export function effectiveSettings(defaults: PublicConfig, overrides: SessionOverrides): Required<SessionOverrides> {
  return {
    systemPrompt: overrides.systemPrompt ?? defaults.systemPrompt,
    greeting: overrides.greeting ?? defaults.greeting,
    voiceId: overrides.voiceId ?? defaults.voiceId,
    speed: overrides.speed ?? defaults.speed,
  };
}
