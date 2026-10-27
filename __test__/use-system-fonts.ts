// Import this first in a spec that pins Chrome's per-OS values. It switches
// the process to the system font renderer before the spec registers fonts.
import { useSystemFontRenderer } from './font-renderer'

useSystemFontRenderer()
