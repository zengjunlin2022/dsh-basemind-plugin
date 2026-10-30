import fs from 'node:fs'

// Guard the fields DSH actually reads at install and startup, plus the
// publishing metadata the release workflow depends on.
const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const problems = []

if (manifest.private) problems.push('package.json must not be private')

if (!manifest.dsh?.bundle?.patch) {
  problems.push('missing dsh.bundle.patch')
} else if (!fs.existsSync(new URL(`../${manifest.dsh.bundle.patch}`, import.meta.url))) {
  problems.push(`missing bundle patch file ${manifest.dsh.bundle.patch}`)
}

if (typeof manifest.engines?.dsh !== 'string') problems.push('missing engines.dsh')
if (manifest.dsh?.compatibility) problems.push('dsh.compatibility is not read by DSH; use engines.dsh')
if (manifest.publishConfig?.access !== 'public') problems.push('publishConfig.access must be public')
if (!manifest.repository?.url) problems.push('missing repository.url (npm provenance needs it)')

if (problems.length > 0) {
  for (const problem of problems) console.error(problem)
  process.exit(1)
}

console.log('bundle manifest ok')
