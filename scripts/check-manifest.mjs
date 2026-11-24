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

// The managed download is a startup side effect: keep it visible in the bundle
// patch (and therefore in `dsh` profile review) instead of burying it in a default.
const patchPath = manifest.dsh?.bundle?.patch
if (typeof patchPath === 'string' && fs.existsSync(new URL(`../${patchPath}`, import.meta.url))) {
  const patchText = fs.readFileSync(new URL(`../${patchPath}`, import.meta.url), 'utf8')
  // A commented-out line must not satisfy the audit: strip comments and look for
  // the real YAML entry.
  const rows = patchText
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
    .filter((line) => line !== '')
  if (!rows.includes('binaryDownload: true')) {
    problems.push(`${patchPath} must declare binaryDownload: true explicitly (managed download is auditable in the bundle patch)`)
  }
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
