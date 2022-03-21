// Node.js < v13.12.0, v12.17.0, ignore
// https://nodejs.org/api/process.html#processreport
if (!process.report || typeof process.report.getReport !== 'function') {
  process.exit(0)
}

// Only GNU system has this field
const { glibcVersionRuntime } = process.report.getReport().header

if (glibcVersionRuntime) {
  process.exit(0)
} else {
  process.exit(1)
}
