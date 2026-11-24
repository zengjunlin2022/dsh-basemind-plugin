import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// Check every runtime file with `node --check`. The file list is built here
// instead of relying on a shell glob, so the script behaves the same on Linux,
// macOS and Windows.
const root = new URL('../', import.meta.url)

/** Every runtime .js file under lib/, including nested module directories. */
function runtimeFiles(directory, prefix) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + '/' + entry.name
    if (entry.isDirectory()) files.push(...runtimeFiles(fileURLToPath(new URL(relative, root)), relative))
    else if (entry.name.endsWith('.js')) files.push(relative)
  }
  return files
}

const files = ['index.js', ...runtimeFiles(fileURLToPath(new URL('lib/', root)), 'lib')]

for (const file of files) {
  execFileSync(process.execPath, ['--check', fileURLToPath(new URL(file, root))], { stdio: 'inherit' })
}

console.log(`syntax ok: ${files.length} files`)
