// Runs regression.spec.ts again with the system font renderer, so the snapshots under
// snapshots/<os>/ stay checked. Its tests register while it is imported, so
// regression.spec.ts must not use top-level await.
import './use-system-text-renderer'
import './regression.spec'
