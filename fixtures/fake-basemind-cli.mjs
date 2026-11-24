// Test-only CLI stand-in for the fake BaseMind launcher: echoes its argv so the
// CLI adapter tests can assert exactly what was passed without a shell.
const argv = process.argv.slice(2)
process.stdout.write('fake-basemind ' + argv.join(' ') + '\n')
process.exit(0)
