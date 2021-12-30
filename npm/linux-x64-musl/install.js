// Node.js 10.x, ignore
if (!process.report || typeof process.report.getReport !== 'function') {
  process.exit(0)
}

// Only GNU system has this field
const { glibcVersionRuntime } = process.report.getReport().header

if (glibcVersionRuntime) {
  process.exit(1)
} else {
  process.exit(0)
}
