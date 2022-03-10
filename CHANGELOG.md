## [0.1.21](https://github.com/Brooooooklyn/canvas/compare/v0.1.20...v0.1.21) (2022-03-10)


### Bug Fixes

* BlendMode::Source should be copy instead of source ([a010fba](https://github.com/Brooooooklyn/canvas/commit/a010fba4c8e7ae3bed2e8119c6862c98e5a466b4))
* prevent segmentation fault if mesuring empty text ([2117ddb](https://github.com/Brooooooklyn/canvas/commit/2117ddbb413df47df8a716eb66e79eb552b2a986))
* should not throw if fill/stroke style is invalid ([0d12337](https://github.com/Brooooooklyn/canvas/commit/0d12337e8ed6590a4788fd7758e30a77db312577))
* stroke/fill text should treat \n as space ([4c9ac1e](https://github.com/Brooooooklyn/canvas/commit/4c9ac1e60b8a16b5209d83e115947cd7cbbf273e))



## [0.1.20](https://github.com/Brooooooklyn/canvas/compare/v0.1.19...v0.1.20) (2022-02-15)

### Bug Fixes

- Fix the issue of arc to + bezier to + quad to at empty path case ([33f8558](https://github.com/Brooooooklyn/canvas/commit/33f8558f447842521213f5c685a932ac1412a530))
- scoot method for path empty case ([a1eb529](https://github.com/Brooooooklyn/canvas/commit/a1eb5292c4d3a5d2a500cdaab3ff5f0dc410ddd9))
- the quality default value case of encode(type, quality) method ([#418](https://github.com/Brooooooklyn/canvas/issues/418)) ([c4950ea](https://github.com/Brooooooklyn/canvas/commit/c4950ea88d75a5437aa85a48b1f1ca087a9784f7))

### Features

- skia chrome/m99 ([c0687c5](https://github.com/Brooooooklyn/canvas/commit/c0687c58b45eafc657d19e9b6a3643fce7003bce))
- upgrade to napi2 ([#422](https://github.com/Brooooooklyn/canvas/issues/422)) ([4a553c7](https://github.com/Brooooooklyn/canvas/commit/4a553c711a2d2f2fd6d71a58404884bff4fe57ad))

## [0.1.19](https://github.com/Brooooooklyn/canvas/compare/v0.1.18...v0.1.19) (2021-12-31)

### Bug Fixes

- text align and font fallback ([d80ac6b](https://github.com/Brooooooklyn/canvas/commit/d80ac6befc8861ebebc5855c1a5714b7f55e1d55))

## [0.1.18](https://github.com/Brooooooklyn/canvas/compare/v0.1.17...v0.1.18) (2021-12-30)

### Bug Fixes

- reduce install size for linux glibc/musl ([8e6c7e8](https://github.com/Brooooooklyn/canvas/commit/8e6c7e8f2aeceb2598c24f8b37faa39a961739f9))

### Features

- upgrade skia to chrome/m98 ([99e3635](https://github.com/Brooooooklyn/canvas/commit/99e363540db1572a832d65e1593721ad3b051493))

## [0.1.17](https://github.com/Brooooooklyn/canvas/compare/v0.1.16...v0.1.17) (2021-12-12)

## [0.1.16](https://github.com/Brooooooklyn/canvas/compare/v0.1.15...v0.1.16) (2021-12-12)

### Bug Fixes

- make methods on ctx configurable & writable ([affe82d](https://github.com/Brooooooklyn/canvas/commit/affe82d0b8880441737497403d790f4d39a217c3))

### Features

- chrome/m97 ([66c900f](https://github.com/Brooooooklyn/canvas/commit/66c900f4307f8204b55912659874a83513220460))

## [0.1.15](https://github.com/Brooooooklyn/canvas/compare/v0.1.14...v0.1.15) (2021-11-11)

### Bug Fixes

- `vercel/nft` and `webpack` compatible issue ([f2e23f5](https://github.com/Brooooooklyn/canvas/commit/f2e23f5d763795c1e499e1eda5b70078a6de501a))

## [0.1.14](https://github.com/Brooooooklyn/canvas/compare/v0.1.13...v0.1.14) (2021-10-26)

### Bug Fixes

- Now generating avif images is 10x+ faster. ([407d1d1](https://github.com/Brooooooklyn/canvas/commit/407d1d1f09dce622426b71ee800480534c8e0888))
- Use different quality for WebP and JPEG formats, which is more in line with the browser's default values. ([fdefa5d](https://github.com/Brooooooklyn/canvas/commit/fdefa5dd278fcc911cb74524388ec7960d9cd1f6))

### Features

- The option to generate avif removes alphaQuality and calculates it internally. ([8de6e95](https://github.com/Brooooooklyn/canvas/commit/8de6e95d23383897870c66e59698a71cd0e73631))
- Add a new SVG generation avif example. ([04d401a](https://github.com/Brooooooklyn/canvas/commit/04d401aaf3d35d13223e32af9e13b829f13170fc))

## [0.1.13](https://github.com/Brooooooklyn/canvas/compare/v0.1.12...v0.1.13) (2021-10-20)

### Bug Fixes

- text align position ([435e102](https://github.com/Brooooooklyn/canvas/commit/435e102e526e206a89f6a1bae2e9f8a1d1646b9f))

### Features

- update rust toolchain ([1cda93b](https://github.com/Brooooooklyn/canvas/commit/1cda93b9ade402893ca1e192a35522eb5b13190a))
- upgrade to chrome/m96 ([a7b3ffe](https://github.com/Brooooooklyn/canvas/commit/a7b3ffe68e4125e2ab63e42c09409cd9cc49dc9f))

## [0.1.12](https://github.com/Brooooooklyn/canvas/compare/v0.1.11...v0.1.12) (2021-10-15)

### Features

- support avif format output ([f35b6ff](https://github.com/Brooooooklyn/canvas/commit/f35b6ffc28b40147b97244526f25173292453db8))

## [0.1.11](https://github.com/Brooooooklyn/canvas/compare/v0.1.10...v0.1.11) (2021-09-30)

### Features

- support colorSpace: 'display-p3' ([4b64310](https://github.com/Brooooooklyn/canvas/commit/4b64310ff3adb41888e7f4bfae7f3557c062620c))

## [0.1.10](https://github.com/Brooooooklyn/canvas/compare/v0.1.9...v0.1.10) (2021-09-27)

### Bug Fixes

- image_filter to Image SamplingOptions conversion ([0719022](https://github.com/Brooooooklyn/canvas/commit/0719022a78a40577a73db0376ca21a547828396f))

### Features

- implement filter for Context ([6079927](https://github.com/Brooooooklyn/canvas/commit/6079927f7ca814a9d3af8efa463938e67ab93d0f))

## [0.1.9](https://github.com/Brooooooklyn/canvas/compare/v0.1.8...v0.1.9) (2021-09-24)

### Bug Fixes

- aarch64-apple-darwin (macOS m1 chips) build [skip skia] ([4deee73](https://github.com/Brooooooklyn/canvas/commit/4deee739a1299006f3ab7b1a14975deb2809f7d4))

## [0.1.8](https://github.com/Brooooooklyn/canvas/compare/v0.1.7...v0.1.8) (2021-09-19)

## [0.1.7](https://github.com/Brooooooklyn/canvas/compare/v0.1.6...v0.1.7) (2021-09-14)

### Bug Fixes

- **deps:** update rust crate cssparser to 0.29 ([36ff54f](https://github.com/Brooooooklyn/canvas/commit/36ff54f25545ddb9cedc61903f591f84ca861959))
- transform state between save/restore ([d313b80](https://github.com/Brooooooklyn/canvas/commit/d313b8084d6f9dce5962ed64cc966cd78427d45b))

## [0.1.6](https://github.com/Brooooooklyn/canvas/compare/v0.1.5...v0.1.6) (2021-08-25)

### Bug Fixes

- example to png ([90edf49](https://github.com/Brooooooklyn/canvas/commit/90edf499f5ad1961f59e7609ae131328b6912a59))
- pass the fabric.js visual tests ([ec55b3a](https://github.com/Brooooooklyn/canvas/commit/ec55b3a5ad4d905f060ddf0aa7d047849369bb82))
- strip start and end ' from font family ([177e4f6](https://github.com/Brooooooklyn/canvas/commit/177e4f625d1cd0e93913cd0309e89fab8c3b0a6f))

### Features

- chrome/m94 ([887a950](https://github.com/Brooooooklyn/canvas/commit/887a95054af022690ad6ee249f56d789c1a85a36))
- load fonts from user dir ([fd6fb78](https://github.com/Brooooooklyn/canvas/commit/fd6fb7837ff5544e6139d9f219476194676bdaa2))

## [0.1.5](https://github.com/Brooooooklyn/canvas/compare/v0.1.4...v0.1.5) (2021-08-13)

### Bug Fixes

- default value of FilterQuality in SamplingOptions should be high ([389aa26](https://github.com/Brooooooklyn/canvas/commit/389aa26fda79dfca15b6f2d87fbd03fe92f28758))

### Features

- add resize SVG demo ([bf8388d](https://github.com/Brooooooklyn/canvas/commit/bf8388ddab06474a01362829437bcfc7df4bd248))

## [0.1.4](https://github.com/Brooooooklyn/canvas/compare/v0.1.3...v0.1.4) (2021-08-11)

### Features

- scale svg image if need ([72c404c](https://github.com/Brooooooklyn/canvas/commit/72c404c5049a0a0898bb91ab4ad1cd36fb71a4e4))

## [0.1.3](https://github.com/Brooooooklyn/canvas/compare/v0.1.2...v0.1.3) (2021-08-06)

### Bug Fixes

- icudtl.dat download logic in publish job ([f2bb048](https://github.com/Brooooooklyn/canvas/commit/f2bb048d0dde9e4703b5c0030011ba0c47a5038c))

## [0.1.2](https://github.com/Brooooooklyn/canvas/compare/v0.1.1...v0.1.2) (2021-08-05)

### Bug Fixes

- Windows icudtl.data version and path ([5c81eb7](https://github.com/Brooooooklyn/canvas/commit/5c81eb7d3edb7acaaf831233199eddecda834074))

### Features

- implement convertSVGTextToPath function ([9c7ca98](https://github.com/Brooooooklyn/canvas/commit/9c7ca989a54c40cf4eb949f651a91bfb629fc716))

## [0.1.1](https://github.com/Brooooooklyn/canvas/compare/v0.1.0...v0.1.1) (2021-08-02)

### Bug Fixes

- use viewbox as svg_container_size if width & height is empty ([406a298](https://github.com/Brooooooklyn/canvas/commit/406a298800ebe3807349d15d4ffa536db1f96afc))

### Features

- upgrade to skia/chrome/m93 latest ([6ca9526](https://github.com/Brooooooklyn/canvas/commit/6ca952651e24d6c7dbf730ebed0f13d9de07ffe3))

# [0.1.0](https://github.com/Brooooooklyn/canvas/compare/v0.0.12...v0.1.0) (2021-07-30)

### Bug Fixes

- canvas.png() to canvas.encode('png') ([b2d5afe](https://github.com/Brooooooklyn/canvas/commit/b2d5afeee91245fe226212e418fe62e16a238f91))
- multi font families ([2e934a5](https://github.com/Brooooooklyn/canvas/commit/2e934a5837f51b62b46172e608a6d34e4413d9f9))
- sample image size update ([8b0b147](https://github.com/Brooooooklyn/canvas/commit/8b0b1475112dd409c9e2652a5cd0bbdac3d772be))

### Features

- add .asWinding() to convert the sample image of SVG filltype ([f9f0d2b](https://github.com/Brooooooklyn/canvas/commit/f9f0d2bdf452a54c2606d55e47387371f37697ab))
- add basic measureText setup ([e1fc0bf](https://github.com/Brooooooklyn/canvas/commit/e1fc0bf2647c3e76cff8089d15078f4e9d200e97))
- measureText with all textAlign and textBaseline ([1891d76](https://github.com/Brooooooklyn/canvas/commit/1891d76090ec093430d63a217fbe4515c758b2c7))
- support register font with family name alias ([4860c80](https://github.com/Brooooooklyn/canvas/commit/4860c80aa6dac4ca073e20a5d2654ef6535e54c2))
- support woff/woff2 fonts ([70b7aa2](https://github.com/Brooooooklyn/canvas/commit/70b7aa2430ed04251c0d5016658a8147a13c167b))
- svg canvas backend ([f95f67a](https://github.com/Brooooooklyn/canvas/commit/f95f67afd5c051c1cf33e783e452d477a9430cad))

## [0.0.12](https://github.com/Brooooooklyn/canvas/compare/v0.0.11...v0.0.12) (2021-07-14)

### Features

- support raw pixels output ([f502548](https://github.com/Brooooooklyn/canvas/commit/f502548dc0c271710602a7363693540487056776))
- support toDataURL and toDataURLAsync on canvas element ([1d8c790](https://github.com/Brooooooklyn/canvas/commit/1d8c790777656ec1104fa465b2c9dcb929ead451))

## [0.0.11](https://github.com/Brooooooklyn/canvas/compare/v0.0.10...v0.0.11) (2021-07-13)

### Features

- support maxWidth in fillText and strokeText ([ccf33f3](https://github.com/Brooooooklyn/canvas/commit/ccf33f30b26aacab636791f3efb92a86ca7a6871))

## [0.0.10](https://github.com/Brooooooklyn/canvas/compare/v0.0.9...v0.0.10) (2021-07-12)

### Bug Fixes

- missing registerFromPath implementation ([8bac515](https://github.com/Brooooooklyn/canvas/commit/8bac515eac3c8bf5db026f701a57ee839fedb42d))

## [0.0.9](https://github.com/Brooooooklyn/canvas/compare/v0.0.8...v0.0.9) (2021-07-11)

### Features

- upgrade skia to chrome/m92 latest ([584a02a](https://github.com/Brooooooklyn/canvas/commit/584a02aef28516dd18d675a8f90c1f25dceae129))

## [0.0.8](https://github.com/Brooooooklyn/canvas/compare/v0.0.7...v0.0.8) (2021-06-23)

### Features

- support conic gradient ([850b6ee](https://github.com/Brooooooklyn/canvas/commit/850b6ee4f7df8ce440574fc41c16e8559ef1f232))
- support webp output ([4948c49](https://github.com/Brooooooklyn/canvas/commit/4948c49f89ea4e423dc14b240c82cb4d5e917248))

## [0.0.7](https://github.com/Brooooooklyn/canvas/compare/v0.0.6...v0.0.7) (2021-06-21)

### Bug Fixes

- **deps:** update rust crate once_cell to 1.8 ([c859162](https://github.com/Brooooooklyn/canvas/commit/c859162650590648d45e64782a104a5144a033bf))
- **deps:** update rust crate regex to 1.5 ([1915c60](https://github.com/Brooooooklyn/canvas/commit/1915c608fcb7318ce778f687c3ca08543203820f))
- JsArrayBuffer usage ([b58e987](https://github.com/Brooooooklyn/canvas/commit/b58e987bc7e92d5547e749b377720e1900454172))

### Features

- support jpeg output ([76adbdc](https://github.com/Brooooooklyn/canvas/commit/76adbdc04cd02f868fde9da21851694f10f15ce5))
- support svg source in image ([8df688f](https://github.com/Brooooooklyn/canvas/commit/8df688f702967fb60c75fceda52cbcf08a72be37))

## [0.0.6](https://github.com/Brooooooklyn/canvas/compare/v0.0.5...v0.0.6) (2021-05-06)

### Bug Fixes

- windows setAssetFontManager crash ([54861e9](https://github.com/Brooooooklyn/canvas/commit/54861e9b3b5fe18cbcd791b65b05c98b40087d42))

### Features

- add .editorconfig file ([62dcf35](https://github.com/Brooooooklyn/canvas/commit/62dcf35b6cdc11e3154af178b04e091aa09e3ac9))
- add font collection singleton scaffold ([9b7a00a](https://github.com/Brooooooklyn/canvas/commit/9b7a00a1eb2cef311cce8409fb37df359d3ab39e))
- support GlobalFonts.families ([00be237](https://github.com/Brooooooklyn/canvas/commit/00be237c08eff287ce706b30dd3ceda3e40727f6))
- support GlobalFonts.has ([0461afc](https://github.com/Brooooooklyn/canvas/commit/0461afcf8efc6ec49e2722f5f124c4bada45a48b))
- support GlobalFonts.register ([295d507](https://github.com/Brooooooklyn/canvas/commit/295d5072de571f1c6b04b930c99f6290f20149a4))

## [0.0.5](https://github.com/Brooooooklyn/canvas/compare/v0.0.4...v0.0.5) (2021-05-04)

### Bug Fixes

- **path:** wrong Stroke type cast and miterLimit default value ([5f1761b](https://github.com/Brooooooklyn/canvas/commit/5f1761b602c992639ab511336fc0551d061c8d5c))
- add stroke to trim test to make it more visually recognizable ([bddb3c6](https://github.com/Brooooooklyn/canvas/commit/bddb3c6ef96f588f36760f69e5077db56417d7cb))

### Features

- add getFillTypeString() for PathKit ([44719de](https://github.com/Brooooooklyn/canvas/commit/44719de4d119ffe370b0c6df26072303d8707a85))
- add PathKit.dash() ([#238](https://github.com/Brooooooklyn/canvas/issues/238)) ([c238113](https://github.com/Brooooooklyn/canvas/commit/c238113ef1feafd179d6c190e2a29e51326737d3))

## [0.0.4](https://github.com/Brooooooklyn/canvas/compare/v0.0.3...v0.0.4) (2021-04-19)

### Bug Fixes

- parse error for single font size rules ([aa80fb7](https://github.com/Brooooooklyn/canvas/commit/aa80fb7109584b32bf6a66ae7d70753ec53882b6))

### Features

- **path2d:** implement pathkit functions ([eea95bf](https://github.com/Brooooooklyn/canvas/commit/eea95bf627a8c643155618fa5e662c6060f73365))
- skia chrome/m91, add back mimalloc ([0420c14](https://github.com/Brooooooklyn/canvas/commit/0420c14339b2ef9c886d0495bddeb30c0af31f1d))

## [0.0.3](https://github.com/Brooooooklyn/canvas/compare/v0.0.2...v0.0.3) (2021-03-27)

### Bug Fixes

- wrong package name in index.js ([e3c35bb](https://github.com/Brooooooklyn/canvas/commit/e3c35bb0611f5d75f52d481738affdd530e1ac5a))

## [0.0.2](https://github.com/Brooooooklyn/canvas/compare/v0.0.1-alpha.3...v0.0.2) (2021-03-27)

### Bug Fixes

- bitmap destructor ([b138da2](https://github.com/Brooooooklyn/canvas/commit/b138da228286f560fe7aebe4e12ef5fc2ddf8e25))
- build on windows ([b731ea8](https://github.com/Brooooooklyn/canvas/commit/b731ea84d529d0a971b2fe34c20eb654f1fa9f34))
- compat with Node.js readonly error messages ([c7e1764](https://github.com/Brooooooklyn/canvas/commit/c7e176440b4d167b03e988059a9e8a34169da9a7))
- eslint & vscode config ignore ([f7dd018](https://github.com/Brooooooklyn/canvas/commit/f7dd018a81ff8dee0845258ef13e488c985f160f))
- image shadow ([8396b93](https://github.com/Brooooooklyn/canvas/commit/8396b93f4634705d1f0dfdb2028afb6fa3b25a99))
- image src getter ([336549d](https://github.com/Brooooooklyn/canvas/commit/336549d8f56b3e93687760b485d4a9d8cd72c6b4))
- setters on readonly properties ([adac797](https://github.com/Brooooooklyn/canvas/commit/adac797e5af7dd1407e05f6c3084dfa725161b6b))
- sync lock file ([340bfb5](https://github.com/Brooooooklyn/canvas/commit/340bfb571187635d041129eaf0c9e365bc7c336d))
- transform matrix config ([9dcddf2](https://github.com/Brooooooklyn/canvas/commit/9dcddf293c25c19a3d93b058d3ba78b43d52a281))

### Features

- add drawImage poc ([a5e5ddf](https://github.com/Brooooooklyn/canvas/commit/a5e5ddf52fc1be006590dcd63aad1ac53d2f5a1d))
- add image class poc ([11e04a5](https://github.com/Brooooooklyn/canvas/commit/11e04a597d2d0153bd5a15da2aabd6bec08efb0e))
- add image SkData field poc ([bb0c108](https://github.com/Brooooooklyn/canvas/commit/bb0c108d80da525efdb61a9b8653041f862933f7))
- ImageData relates API and tests ([24c7990](https://github.com/Brooooooklyn/canvas/commit/24c7990f9c83a1fa81aa9b23d7712980ac556467))
- implement image pattern ([2efbb18](https://github.com/Brooooooklyn/canvas/commit/2efbb18b6f80eadd5f457048c149cc50076fe2a2))
- scale and rotate ([f6c761f](https://github.com/Brooooooklyn/canvas/commit/f6c761f4ebbb57c23dbec1f9be5c80ab7be38b95))
- skia m89 ([e9c1cc9](https://github.com/Brooooooklyn/canvas/commit/e9c1cc94d33204e68ebe72ae94e934bf686d3e28))
- support all drawImage variants ([8d5ded6](https://github.com/Brooooooklyn/canvas/commit/8d5ded624f5e915907ece2696f0f5e350e244b4c))
- support context alpha ([929bdc0](https://github.com/Brooooooklyn/canvas/commit/929bdc092374ee8d196cc7fa5c56a057acfa2cfa))
- support creating SkImage ([3945321](https://github.com/Brooooooklyn/canvas/commit/39453214b2793d40f16c6229e6444d713c0904cc))
- support getContextAttributes ([4c0586b](https://github.com/Brooooooklyn/canvas/commit/4c0586b39cd923217c7db5bdd5bc620d3c438131))
- support isPointInPath ([2150788](https://github.com/Brooooooklyn/canvas/commit/2150788b01103f25a272d8c89cf3cea2e2d5851b))
- support isPointInStroke ([2a14513](https://github.com/Brooooooklyn/canvas/commit/2a14513c4a06ab9d6eeefcc31827b3a6e06d80a1))
- support naturalWidth/naturalHeight/complete/alt ([1bb1042](https://github.com/Brooooooklyn/canvas/commit/1bb104206450d440991cdd6cc093ad31696be489))
- sync skia m89 ([9748c44](https://github.com/Brooooooklyn/canvas/commit/9748c44658f4507dcb86e463a1e68117d05f057b))
- text states and font styles ([a175cf7](https://github.com/Brooooooklyn/canvas/commit/a175cf729f4340ec49cec464e8e10c3561c20ebb))

### Performance Improvements

- disable image data copy ([ccc8630](https://github.com/Brooooooklyn/canvas/commit/ccc8630906afaf573e7f46877efbb6ed652212f8))

## [0.0.1-alpha.3](https://github.com/Brooooooklyn/canvas/compare/v0.0.1-alpha.2...v0.0.1-alpha.3) (2021-01-06)

### Features

- properties in CanvasRenderContext2D ([12727a7](https://github.com/Brooooooklyn/canvas/commit/12727a795e75c6873a900dba0755e7e9471f85ef))
- testing for context2d functions ([107a650](https://github.com/Brooooooklyn/canvas/commit/107a650213ba3f13038955c2b8a7875b9b571449))

## [0.0.1-alpha.2](https://github.com/Brooooooklyn/canvas/compare/v0.0.1-alpha.1...v0.0.1-alpha.2) (2020-12-26)

### Features

- implement Path2D ([91124d6](https://github.com/Brooooooklyn/canvas/commit/91124d6ba143c2c0728f8725c24443b58ef3fa06))
- support gradient in fill/stroke style ([12e061c](https://github.com/Brooooooklyn/canvas/commit/12e061cdbd2ab4849a846cef2d5077bd00793613))

## [0.0.1-alpha.1](https://github.com/Brooooooklyn/canvas/compare/v0.0.1-alpha.0...v0.0.1-alpha.1) (2020-12-24)

### Features

- async/sync get png data from Canvas ([f6d8cd6](https://github.com/Brooooooklyn/canvas/commit/f6d8cd60a6d336822a885bb0302a1ae2b8eafa9b))

## [0.0.1-alpha.0](https://github.com/Brooooooklyn/canvas/compare/5b09b4b92712bbce9468f0b874aed3ec7b87a716...v0.0.1-alpha.0) (2020-12-17)

### Features

- simple example ([5b09b4b](https://github.com/Brooooooklyn/canvas/commit/5b09b4b92712bbce9468f0b874aed3ec7b87a716))
- strokeStyle ([e185ca3](https://github.com/Brooooooklyn/canvas/commit/e185ca3faa1a13a22af37a20284a00114b9669ae))
- upgrade everything ([5d27f63](https://github.com/Brooooooklyn/canvas/commit/5d27f6355ffe0ef8abcda5a7e14871cccfcdd71b))
