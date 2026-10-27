// Import this first in a spec that pins Chrome's per-OS values. It switches
// the process to the system text renderer before the spec registers fonts.
import { setTextRenderer } from '../index'

setTextRenderer('system')
