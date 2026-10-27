import { useSystemFontRenderer as setSystemFontRenderer } from '../index'

// The font renderer mode of this test process. It starts as index.js does.
let system = true

export const isSystemFontRenderer = () => system

export function useSystemFontRenderer(enabled = true) {
  setSystemFontRenderer(enabled)
  system = enabled
}
