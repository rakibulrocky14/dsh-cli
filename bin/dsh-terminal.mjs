#!/usr/bin/env node
/**
 * Thin launcher: ensure the dsh CLI exists, then boot the terminal profile.
 * Prefer: dsh --profile terminal
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')

const result = spawnSync('dsh', ['--profile', 'terminal', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
})
if (result.error?.code === 'ENOENT') {
  console.error('dsh CLI not found. Install DeepSeek Harness first:')
  console.error('  npm i -g @deepseek-ai/dsh')
  console.error('Then: dsh plugin --profile terminal add ' + pkgRoot)
  process.exit(1)
}
process.exit(result.status ?? 1)
