import { defineConfig } from 'vitest/config'
// Share React across client packages. Native Windows tests start nested PowerShell/Node processes;
// bound their file-level concurrency to avoid exhausting the desktop's process and I/O resources.
export default defineConfig({ resolve: { dedupe: ['react', 'react-dom'] }, test: {
  include: ['tests/**/*.spec.{ts,tsx}'],
  ...(process.platform === 'win32' ? { maxWorkers: 4, testTimeout: 15_000 } : {}),
} })
