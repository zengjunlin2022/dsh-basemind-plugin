import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// Check every runtime file with `node --check`. The file list is built here
// instead of relying on a shell glob, so the script behaves the same on Linux,
// macOS and Windows.
const root = new URL('../', import.meta.url)
const libDir = fileURLToPath(new URL('lib/', root))
const files = [
  'index.js',
  ...fs
    .readdirSync(libDir)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => `lib/${name}`),
]

for (const file of files) {
  execFileSync(process.execPath, ['--check', fileURLToPath(new URL(file, root))], { stdio: 'inherit' })
}

console.log(`syntax ok: ${files.length} files`)
