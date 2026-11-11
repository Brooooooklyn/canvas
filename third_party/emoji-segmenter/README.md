# emoji-segmenter

`emoji_presentation_scanner.c` is copied unchanged from Chromium's
`third_party/emoji-segmenter/src/` (emoji-segmenter 0.3.0, revision
955936be8b391e00835257059607d7c5b72ce744, from
https://github.com/googlei18n/emoji-segmenter; Chromium checkout
cc3ec51d8912f2f89318b88b5f1a81fcff6506ef). Apache-2.0, see `LICENSE`.

`skia-c/shaper_segment.cpp` includes it for its SymbolsIterator, as Blink's
`symbols_iterator.cc` does. It lives outside `skia-c/` so the clang-format
check of `skia-c/*` does not reformat generated code.
