import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const workletGlobals = {
  AudioWorkletProcessor: 'readonly',
  registerProcessor: 'readonly',
  sampleRate: 'readonly',
  currentTime: 'readonly',
  console: 'readonly',
};

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/web/public/*.js'],
    languageOptions: { globals: workletGlobals, sourceType: 'module' },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
