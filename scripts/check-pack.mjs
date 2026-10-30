import fs from 'node:fs'

// Check the tarball npm would publish: the runtime files must be present and
// tests, docs and dependency trees must stay out of the package.
const packPath = process.argv[2] ?? 'pack.json'
const [packed] = JSON.parse(fs.readFileSync(packPath, 'utf8'))
const files = packed.files.map((file) => file.path)
const have = new Set(files)

const required = [
  'package.json',
  'index.js',
  'cordis.patch.yml',
  'icon.svg',
  'README.md',
  'README.zh.md',
  'LICENSE',
  'locale/en.json',
  'locale/zh.json',
  'lib/config.js',
  'lib/workspace-pool.js',
]

const missing = required.filter((name) => !have.has(name))
const forbidden = files.filter(
  (name) => name.startsWith('test/') || name.startsWith('docs/') || name.startsWith('scripts/') || name.includes('node_modules/'),
)

if (missing.length > 0 || forbidden.length > 0) {
  console.error(JSON.stringify({ missing, forbidden }, null, 2))
  process.exit(1)
}

console.log(`pack contents ok: ${files.length} files`)
