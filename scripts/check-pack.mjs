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
  'lib/upstream.js',
  'lib/binary/manager.js',
  'lib/skills/provider.js',
  // The optional Dashboard: its Host route family and its browser half. The
  // browser half is what the dsh.client declaration in package.json names, so a
  // tarball without it would install a plugin whose Dashboard never appears.
  'lib/dashboard/client.js',
  'lib/dashboard/contracts.js',
  'lib/dashboard/history.js',
  'lib/dashboard/routes.js',
  'lib/dashboard/run.js',
  'lib/dashboard/service.js',
  'lib/dashboard/workspaces.js',
  'skills/UPSTREAM.json',
  'skills/LICENSE-basemind.txt',
  'skills/.dsh-adapt.json',
]

const missing = required.filter((name) => !have.has(name))
const forbidden = files.filter(
  (name) =>
    name.startsWith('test/') ||
    name.startsWith('docs/') ||
    name.startsWith('scripts/') ||
    name.startsWith('fixtures/') ||
    name.startsWith('.github/') ||
    name === 'pack.json' ||
    name.includes('node_modules/') ||
    /\.(exe|zip|tar\.gz)$/i.test(name),
)

// A binary must never ride along, whatever its extension or location.
for (const name of files) {
  if (/(^|\/)basemind(\.exe)?$/i.test(name)) forbidden.push(name)
}

// Vendored skills may only contain the known content files: an extensionless
// `basemind` under skills/ would otherwise slip past the extension check.
const ALLOWED_SKILL_FILE = /^skills\/(?:[^/]+\/(?:SKILL|index)\.md|UPSTREAM\.json|LICENSE-basemind\.txt|\.dsh-adapt\.json)$/
for (const name of files) {
  if (name.startsWith('skills/') && !ALLOWED_SKILL_FILE.test(name)) forbidden.push(name)
}

// Every vendored skill directory must ship with both files, and none of the ten
// official names may be missing from the tarball.
const skillDirs = files.filter((name) => /^skills\/[^/]+\/SKILL\.md$/.test(name))
const skillNames = skillDirs.map((name) => name.split('/')[1])
if (skillNames.length !== 10) missing.push(`skills/** must contain 10 SKILL.md files (found ${skillNames.length})`)
for (const name of skillNames) {
  if (!have.has(`skills/${name}/index.md`)) missing.push(`skills/${name}/index.md`)
}
if (files.some((name) => /^skills\/.+\/(references|scripts|assets)\//.test(name))) {
  missing.push('skills/** must not ship sub-resources (upstream has none)')
}

if (missing.length > 0 || forbidden.length > 0) {
  console.error(JSON.stringify({ missing, forbidden }, null, 2))
  process.exit(1)
}

console.log(`pack contents ok: ${files.length} files`)
