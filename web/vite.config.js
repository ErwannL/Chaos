import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API = 'http://127.0.0.1:8090';
const routes = [
  '/auth',
  '/catalog',
  '/expectation-types',
  '/targets',
  '/plan',
  '/runs',
  '/abort-all',
  '/scenarios',
  '/journal',
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: Object.fromEntries(routes.map((r) => [r, API])) },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{js,jsx}'],
    setupFiles: ['test/setup.js'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{js,jsx}'],
      exclude: ['src/main.jsx'],
      reporter: ['text', 'json-summary'],
      thresholds: { perFile: true, lines: 95, statements: 95, functions: 95, branches: 95 },
    },
  },
});
