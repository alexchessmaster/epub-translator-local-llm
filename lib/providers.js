// lib/providers.js — LLM provider factory. The UI settings panel is the primary
// configuration path (data/settings.json, gitignored); env vars are startup
// overrides so secrets/Docker still work without touching the file.
//   provider  — 'ollama' | 'openai'
//   baseUrl   — adapter base URL; per-provider default applied when empty
//   apiKey    — LLM_API_KEY env wins over the stored key

const { makeOllamaProvider } = require('./providers/ollama');
const { makeOpenAiProvider } = require('./providers/openai');

const PROVIDER_DEFAULTS = {
  ollama: 'http://localhost:11434',
  openai: 'https://api.openai.com/v1',
};

// settings may be a SettingsStore or a plain object (the test endpoint passes a
// plain object of form values).
function resolveConfig(settings) {
  const s = settings && settings.get ? settings.get() : (settings || {});
  const provider = s.provider === 'openai' ? 'openai' : 'ollama';
  const envBase = process.env.LLM_BASE_URL || (provider === 'ollama' ? process.env.OLLAMA_HOST : null);
  const baseUrl = (envBase || s.baseUrl || PROVIDER_DEFAULTS[provider]).replace(/\/+$/, '');
  const apiKey = process.env.LLM_API_KEY || s.apiKey || null;
  return {
    provider,
    baseUrl,
    apiKey,
    apiKeyFromEnv: !!process.env.LLM_API_KEY,
    baseUrlFromEnv: !!envBase,
  };
}

function makeProvider(cfg) {
  return cfg.provider === 'openai' ? makeOpenAiProvider(cfg) : makeOllamaProvider(cfg);
}

// Adapter instance with name + resolved config attached.
function getProvider(settings) {
  const cfg = resolveConfig(settings);
  return { ...makeProvider(cfg), name: cfg.provider, config: cfg };
}

// What the UI shows as "effective" config: env-resolved values + which sources
// supplied them (badges in the settings panel).
function effectiveConfig(settings) {
  const cfg = resolveConfig(settings);
  const s = settings.get ? settings.get() : (settings || {});
  return {
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    apiKeySet: !!cfg.apiKey,
    apiKeyFromEnv: cfg.apiKeyFromEnv,
    baseUrlFromEnv: cfg.baseUrlFromEnv,
    host: process.env.HOST || s.host || '0.0.0.0',
    port: parseInt(process.env.PORT || s.port || 8765, 10),
    env: {
      PORT: process.env.PORT || null,
      HOST: process.env.HOST || null,
      LLM_API_KEY: !!process.env.LLM_API_KEY,
      LLM_BASE_URL: process.env.LLM_BASE_URL || null,
      OLLAMA_HOST: process.env.OLLAMA_HOST || null,
    },
  };
}

module.exports = { PROVIDER_DEFAULTS, resolveConfig, makeProvider, getProvider, effectiveConfig };
