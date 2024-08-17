## [0.1.54](https://github.com/Brooooooklyn/canvas/compare/v0.1.53...v0.1.54) (2024-08-17)


### Bug Fixes

* **deps:** update rust crate libavif to 0.14 ([d5db090](https://github.com/Brooooooklyn/canvas/commit/d5db090d03bbe3ec7a689c4d6431b992e7f335d8))
* handle relative and invalid URLs in redirects when passing URL to loadImage() ([#866](https://github.com/Brooooooklyn/canvas/issues/866)) ([1666a33](https://github.com/Brooooooklyn/canvas/commit/1666a33d23c779bf5cb6b9fcd4d0cace1ada609b)), closes [#865](https://github.com/Brooooooklyn/canvas/issues/865) [#865](https://github.com/Brooooooklyn/canvas/issues/865)
* image decode should be async ([#872](https://github.com/Brooooooklyn/canvas/issues/872)) ([713ca40](https://github.com/Brooooooklyn/canvas/commit/713ca40d0ec36052a201269dab155b3e07fd7dab))


### Features

* chrome/m118 ([#875](https://github.com/Brooooooklyn/canvas/issues/875)) ([f209603](https://github.com/Brooooooklyn/canvas/commit/f2096037d5b4e05b7676fe65e7506285c52a4370))
* update skia to m127 ([#853](https://github.com/Brooooooklyn/canvas/issues/853)) ([3d60556](https://github.com/Brooooooklyn/canvas/commit/3d60556b2c22fd5f6c6639cbede566bd8b233747))



## [0.1.53](https://github.com/Brooooooklyn/canvas/compare/v0.1.52...v0.1.53) (2024-06-09)


### Bug Fixes

* armv7 segmentfault ([#830](https://github.com/Brooooooklyn/canvas/issues/830)) ([e17e6b6](https://github.com/Brooooooklyn/canvas/commit/e17e6b69c752e738d69896605a7dea2690417ede))
* **deps:** update rust crate infer to 0.16 ([3859fe4](https://github.com/Brooooooklyn/canvas/commit/3859fe43d410e8a7e98884123336e1b19bcd1146))
* **loadImage:** use promise ([#841](https://github.com/Brooooooklyn/canvas/issues/841)) ([e85ceee](https://github.com/Brooooooklyn/canvas/commit/e85ceeea9e21b76dc46bc712bf38557f1bcb8428))
* trigger onerror while svg image is invalid ([#840](https://github.com/Brooooooklyn/canvas/issues/840)) ([31bd832](https://github.com/Brooooooklyn/canvas/commit/31bd832ba9ed17b2f07463f8f788edbdf21683d2))


### Features

* chrome/m116 ([#839](https://github.com/Brooooooklyn/canvas/issues/839)) ([23276d7](https://github.com/Brooooooklyn/canvas/commit/23276d7ccb8c904b4b558767a16d1af1850fa5b7))



## [0.1.52](https://github.com/Brooooooklyn/canvas/compare/v0.1.51...v0.1.52) (2024-04-17)


### Bug Fixes

* drawImage with exif orientation ([#814](https://github.com/Brooooooklyn/canvas/issues/814)) ([a54cd33](https://github.com/Brooooooklyn/canvas/commit/a54cd33cb86d3670c31defdb2d2bd1ecdbba1a31))
* negative letter spacing ([#813](https://github.com/Brooooooklyn/canvas/issues/813)) ([11ab7e2](https://github.com/Brooooooklyn/canvas/commit/11ab7e2f4239e0456e5b4169f744b71d504cfce0))


### Features

* chrome/m125 ([#815](https://github.com/Brooooooklyn/canvas/issues/815)) ([7edc894](https://github.com/Brooooooklyn/canvas/commit/7edc894dd531313f0a75ebafca1f1448a1829baf))



## [0.1.51](https://github.com/Brooooooklyn/canvas/compare/v0.1.50...v0.1.51) (2024-03-04)


### Bug Fixes

* **deps:** update rust crate base64 to 0.22 ([84fd52f](https://github.com/Brooooooklyn/canvas/commit/84fd52fa448607ce4cbdf45dc3513b0baa2479a5))
* remove postinstall script for gnu/musl platform ([#797](https://github.com/Brooooooklyn/canvas/issues/797)) ([d37da08](https://github.com/Brooooooklyn/canvas/commit/d37da08b8c2620d9895ac9b0050ab1bf654f284e))



## [0.1.50](https://github.com/Brooooooklyn/canvas/compare/v0.1.49...v0.1.50) (2024-02-26)


### Features

* support ctx.letterSpacing and ctx.wordSpacing ([#794](https://github.com/Brooooooklyn/canvas/issues/794)) ([793d2a0](https://github.com/Brooooooklyn/canvas/commit/793d2a0e02728ce9de224b1d03061b30f00f901d))



## [0.1.49](https://github.com/Brooooooklyn/canvas/compare/v0.1.48...v0.1.49) (2024-02-22)


### Bug Fixes

* memory leak while encoding png from Canvas ([#791](https://github.com/Brooooooklyn/canvas/issues/791)) ([3f17b38](https://github.com/Brooooooklyn/canvas/commit/3f17b384445868a37062d7e2b42d558c03d24586))


### Features

* chrome/m123 ([#790](https://github.com/Brooooooklyn/canvas/issues/790)) ([a70a8d4](https://github.com/Brooooooklyn/canvas/commit/a70a8d4edc2c5aa48122a34edc4f69fe48e24bd0))



## [0.1.48](https://github.com/Brooooooklyn/canvas/compare/v0.1.47...v0.1.48) (2024-02-21)


### Bug Fixes

* isPointInPath/isPointInStroke should respect transform ([#787](https://github.com/Brooooooklyn/canvas/issues/787)) ([9b068f1](https://github.com/Brooooooklyn/canvas/commit/9b068f17448c97df7315dd4ac75528edc9952537))
* map points args order ([#788](https://github.com/Brooooooklyn/canvas/issues/788)) ([72d3d35](https://github.com/Brooooooklyn/canvas/commit/72d3d35a8f98be0ba5cb4a8c5f98b202984403e9))
* memory leak in Canvas encode ([#786](https://github.com/Brooooooklyn/canvas/issues/786)) ([9a4ade5](https://github.com/Brooooooklyn/canvas/commit/9a4ade5f965e43896894dbac64a8e2b358313305))



## [0.1.47](https://github.com/Brooooooklyn/canvas/compare/v0.1.46...v0.1.47) (2024-02-19)


### Bug Fixes

* DOMMatrix#transformPoint ([#782](https://github.com/Brooooooklyn/canvas/issues/782)) ([dfc2224](https://github.com/Brooooooklyn/canvas/commit/dfc2224b99ec23952cfb43ea35f7c4f8714c813b))
* font css parser should handle the font height ([#783](https://github.com/Brooooooklyn/canvas/issues/783)) ([382c304](https://github.com/Brooooooklyn/canvas/commit/382c304176beee304eed7569d4c965dcb2042804))



## [0.1.46](https://github.com/Brooooooklyn/canvas/compare/v0.1.45...v0.1.46) (2024-02-19)


### Bug Fixes

* **deps:** update rust crate libavif to 0.13 ([08f3ff4](https://github.com/Brooooooklyn/canvas/commit/08f3ff4e8b522b3fb7c9204f08689a02d49b5218))
* draw text on svg ([#780](https://github.com/Brooooooklyn/canvas/issues/780)) ([b6928f2](https://github.com/Brooooooklyn/canvas/commit/b6928f2976624a598f79e7724119b0888a0859d8))



## [0.1.45](https://github.com/Brooooooklyn/canvas/compare/v0.1.44...v0.1.45) (2024-02-05)


### Bug Fixes

* use `drawPicture` in some blending modes such as `destination-in` ([#755](https://github.com/Brooooooklyn/canvas/issues/755)) ([35f7f72](https://github.com/Brooooooklyn/canvas/commit/35f7f7261424e64c63f07a829331980ec2feb76f)), closes [#695](https://github.com/Brooooooklyn/canvas/issues/695)


### Features

* upgrade Rust toolchain ([#776](https://github.com/Brooooooklyn/canvas/issues/776)) ([6ce93d8](https://github.com/Brooooooklyn/canvas/commit/6ce93d8e0402f9627e6b5d1b18199c5225cfa2fc))
* upgrade skia to chrome/122 ([#775](https://github.com/Brooooooklyn/canvas/issues/775)) ([48c2f88](https://github.com/Brooooooklyn/canvas/commit/48c2f88799c4f07480d76af24e96b0f0a58682a4))



## [0.1.44](https://github.com/Brooooooklyn/canvas/compare/v0.1.43...v0.1.44) (2023-08-22)

### Bug Fixes

- file extensions in `loadFontsFromDir()` are no longer case-sensitive ([9342e33](https://github.com/Brooooooklyn/canvas/commit/9342e3386f575f3864c1bfa0036caa0956f1a914))

## [0.1.43](https://github.com/Brooooooklyn/canvas/compare/v0.1.42...v0.1.43) (2023-08-11)

## [0.1.42](https://github.com/Brooooooklyn/canvas/compare/v0.1.41...v0.1.42) (2023-08-08)

### Bug Fixes

- add `ctx.canvas` property on svg context ([#697](https://github.com/Brooooooklyn/canvas/issues/697)) ([968e501](https://github.com/Brooooooklyn/canvas/commit/968e501e5d09d5b11fb02829b6ba402ffc3575d1))
- **deps:** update rust crate infer to 0.15 ([376b19e](https://github.com/Brooooooklyn/canvas/commit/376b19ebc53640a89e1dad73b8281922675cf834))
- url is string type ([#671](https://github.com/Brooooooklyn/canvas/issues/671)) ([31a8ff9](https://github.com/Brooooooklyn/canvas/commit/31a8ff9a5295697b965ba4e48a19a30dc0f0b1d6))

### Features

- upgrade skia to m116 ([#702](https://github.com/Brooooooklyn/canvas/issues/702)) ([926c472](https://github.com/Brooooooklyn/canvas/commit/926c47249b77894eb96fd002755ad73e50e602d6))

## [0.1.41](https://github.com/Brooooooklyn/canvas/compare/v0.1.40...v0.1.41) (2023-05-22)

### Bug Fixes

- adjust order of generating bitmap ([#675](https://github.com/Brooooooklyn/canvas/issues/675)) ([8df17af](https://github.com/Brooooooklyn/canvas/commit/8df17af589bf48a14a5fa36cefa9984c3d8aeb5e))

## [0.1.40](https://github.com/Brooooooklyn/canvas/compare/v0.1.39...v0.1.40) (2023-04-09)

### Features

- chrome/m113 ([#656](https://github.com/Brooooooklyn/canvas/issues/656)) ([0141b20](https://github.com/Brooooooklyn/canvas/commit/0141b205c98802f879946a7b58c9761dc7d238cc))

## [0.1.39](https://github.com/Brooooooklyn/canvas/compare/v0.1.38...v0.1.39) (2023-03-14)

### Bug Fixes

- set empty src to Image ([#649](https://github.com/Brooooooklyn/canvas/issues/649)) ([d7e14cf](https://github.com/Brooooooklyn/canvas/commit/d7e14cf4fff6fb92fafc03877b0976f71a2fc5e4))

## [0.1.38](https://github.com/Brooooooklyn/canvas/compare/v0.1.37...v0.1.38) (2023-03-11)

### Bug Fixes

- **deps:** update rust crate infer to 0.13 ([bad913c](https://github.com/Brooooooklyn/canvas/commit/bad913cb4a85b563fd02212269e2801956271a86))

### Features

- skia/m112 ([#648](https://github.com/Brooooooklyn/canvas/issues/648)) ([439a3c5](https://github.com/Brooooooklyn/canvas/commit/439a3c59beb0cc111d8de46048f3a131aec4337b))

## [0.1.37](https://github.com/Brooooooklyn/canvas/compare/v0.1.36...v0.1.37) (2023-02-27)

### Bug Fixes

- reject if image is not supported ([#642](https://github.com/Brooooooklyn/canvas/issues/642)) ([e4f4930](https://github.com/Brooooooklyn/canvas/commit/e4f49306c03ed0cdac6e9fa17fb8a59b3b9ef70f))

## [0.1.36](https://github.com/Brooooooklyn/canvas/compare/v0.1.35...v0.1.36) (2023-02-21)

### Bug Fixes

- recalc paint_x according to align if maxWidth is set ([#639](https://github.com/Brooooooklyn/canvas/issues/639)) ([7f74567](https://github.com/Brooooooklyn/canvas/commit/7f7456743b65b0f7aee365ff7d9aa3a6b613a9d2))

## [0.1.35](https://github.com/Brooooooklyn/canvas/compare/v0.1.34...v0.1.35) (2023-02-16)

### Bug Fixes

- canvas instance check ([#632](https://github.com/Brooooooklyn/canvas/issues/632)) ([08ee680](https://github.com/Brooooooklyn/canvas/commit/08ee6803a9339d0e8c9c53a1fc920c4850ce4842))
- **deps:** update rust crate libavif to 0.11 ([fd1515b](https://github.com/Brooooooklyn/canvas/commit/fd1515be6eab70ec1928888545e21592b00c6aa4))
- DOMMatrix object to skia Transform convert ([#633](https://github.com/Brooooooklyn/canvas/issues/633)) ([c82d41d](https://github.com/Brooooooklyn/canvas/commit/c82d41d33e4c98700a49aadf66e4c23f0fe50500))
- DOMMatrix to skia Transform ([#634](https://github.com/Brooooooklyn/canvas/issues/634)) ([f43ccbd](https://github.com/Brooooooklyn/canvas/commit/f43ccbdb93a5a312d92793b60c00801f0f8b75b1))

## [0.1.34](https://github.com/Brooooooklyn/canvas/compare/v0.1.33...v0.1.34) (2023-01-12)

### Bug Fixes

- wrong text baseline calculation in drawText and measureText ([#606](https://github.com/Brooooooklyn/canvas/issues/606)) ([bba0296](https://github.com/Brooooooklyn/canvas/commit/bba0296d659c559fad1337fe963712fb91bc6407))

## [0.1.33](https://github.com/Brooooooklyn/canvas/compare/v0.1.32...v0.1.33) (2023-01-08)

### Bug Fixes

- maxWidth overflow paint_x position should power the scale ratio ([#603](https://github.com/Brooooooklyn/canvas/issues/603)) ([17c7902](https://github.com/Brooooooklyn/canvas/commit/17c7902327d51ee6a044bad909b51d23e6a66805))

## [0.1.32](https://github.com/Brooooooklyn/canvas/compare/v0.1.31...v0.1.32) (2023-01-07)

### Bug Fixes

- getTransform should return DOMMatrix ([#602](https://github.com/Brooooooklyn/canvas/issues/602)) ([fc576e9](https://github.com/Brooooooklyn/canvas/commit/fc576e974c320f08a54f07b5665795b6c8b0d857))

### Features

- chrome/m110 [skip skia] ([#599](https://github.com/Brooooooklyn/canvas/issues/599)) ([e1efc1d](https://github.com/Brooooooklyn/canvas/commit/e1efc1d5b1f8e8dda18553a754dfd7d4232631b6))
- roundRect ([#601](https://github.com/Brooooooklyn/canvas/issues/601)) ([0823325](https://github.com/Brooooooklyn/canvas/commit/08233257bb814fc82c4aa6a994f6200ea5a55819))

## [0.1.31](https://github.com/Brooooooklyn/canvas/compare/v0.1.30...v0.1.31) (2023-01-02)

### Bug Fixes

- missing canvas property on Context2D ([#597](https://github.com/Brooooooklyn/canvas/issues/597)) ([b0a351a](https://github.com/Brooooooklyn/canvas/commit/b0a351a8a8c1693ca2edcf009e77ec56df616fb5))
- multiple define on cached native object in jest ([88f5ee9](https://github.com/Brooooooklyn/canvas/commit/88f5ee9893ed55ab3bb41947feb133507914acef))

### Features

- chrome/m107 ([9f02e86](https://github.com/Brooooooklyn/canvas/commit/9f02e869cf11f8346f65500009cba8e69b722d31))
- chrome/m108 ([04f5a41](https://github.com/Brooooooklyn/canvas/commit/04f5a414fb45ff7e25c6d0fb3400aef969ef919b))

## [0.1.30](https://github.com/Brooooooklyn/canvas/compare/v0.1.29...v0.1.30) (2022-09-22)

### Bug Fixes

- add Mutex guard to GlobalFont ([7e0a51a](https://github.com/Brooooooklyn/canvas/commit/7e0a51a63aa443871e0a7efd45c27998162e944a))
- ctx.globalAlpha should effect drawImage ([#561](https://github.com/Brooooooklyn/canvas/issues/561)) ([9c505e2](https://github.com/Brooooooklyn/canvas/commit/9c505e2530a6c526b1e338a785115edeeafae267))
- error listening to req ([#555](https://github.com/Brooooooklyn/canvas/issues/555)) ([8491685](https://github.com/Brooooooklyn/canvas/commit/8491685defb651b591b1db7c2c484cd8a5a858df))
- resize canvas should clear the context ([8ece352](https://github.com/Brooooooklyn/canvas/commit/8ece352cf242ad0be0f5ebd05a0c7fbde4f5ab37))
- TypeScript types for avif config ([29b17f8](https://github.com/Brooooooklyn/canvas/commit/29b17f88c12daa3d0f3d8f6860428ab8d079cb52))
- **types:** do not use `reference` tags ([#563](https://github.com/Brooooooklyn/canvas/issues/563)) ([9e5cc29](https://github.com/Brooooooklyn/canvas/commit/9e5cc29807949045cdfb3cca74cb42f7b14709fc))

## [0.1.29](https://github.com/Brooooooklyn/canvas/compare/v0.1.28...v0.1.29) (2022-08-26)

### Bug Fixes

- data url should be standard base64 ([a59cb40](https://github.com/Brooooooklyn/canvas/commit/a59cb40058448c0f59c4f3904e43bfe56a4a4afd))
- drawImage alpha should not effect by fillStyle ([41a6f29](https://github.com/Brooooooklyn/canvas/commit/41a6f2905281268e1847b2b38704ae0da9108ea5))
- isBufferLike in load-image.js ([#536](https://github.com/Brooooooklyn/canvas/issues/536)) ([c6ad306](https://github.com/Brooooooklyn/canvas/commit/c6ad306ee1b2c2e486e5aceb8592060b4ddb17a6))

### Features

- chrome m106 ([45f425c](https://github.com/Brooooooklyn/canvas/commit/45f425c5d7f8561ed8c2b781d32bd6b5c8236271))

## [0.1.28](https://github.com/Brooooooklyn/canvas/compare/v0.1.27...v0.1.28) (2022-08-16)

### Bug Fixes

- adjust Node.js external memory while creating Canvas ([77ecc52](https://github.com/Brooooooklyn/canvas/commit/77ecc52a8259cfe959e23f615eee2a4484c72ed5))

## [0.1.27](https://github.com/Brooooooklyn/canvas/compare/v0.1.26...v0.1.27) (2022-08-14)

### Bug Fixes

- segfault while drawing empty text ([#528](https://github.com/Brooooooklyn/canvas/issues/528)) ([88f736c](https://github.com/Brooooooklyn/canvas/commit/88f736ce058fea085450f3a7ea9c51ac18f81beb))

## [0.1.26](https://github.com/Brooooooklyn/canvas/compare/v0.1.25...v0.1.26) (2022-08-07)

### Bug Fixes

- **loadImage:** redirect handler ([dbbf826](https://github.com/Brooooooklyn/canvas/commit/dbbf826652f512bfd9afb14d9719e85c13bbc453))
- miss applying image_smoothing_enabled and image_smoothing_quality ([815bc91](https://github.com/Brooooooklyn/canvas/commit/815bc91e219b6d0173954843030737114baf2d16))
- shadow color was not applied correctly ([4054e44](https://github.com/Brooooooklyn/canvas/commit/4054e4458df2b0b99fa8edbc679484328b95a61d))
- test snapshots diff on arm64 ([21983c2](https://github.com/Brooooooklyn/canvas/commit/21983c2f25e7a99e63606f58de626d0f65530d24))
- the quality of toDataURL should between 0 and 1 ([27e87df](https://github.com/Brooooooklyn/canvas/commit/27e87dffcb6e49efcc48b85885c4d76ef89f5edb))

### Features

- chrome/m105 ([ade8f64](https://github.com/Brooooooklyn/canvas/commit/ade8f6452b0cdad2ee5b8c7107a667372f7fdb2f))

## [0.1.25](https://github.com/Brooooooklyn/canvas/compare/v0.1.24...v0.1.25) (2022-06-30)

### Bug Fixes

- missing load-image.js in package.json ([ddb2419](https://github.com/Brooooooklyn/canvas/commit/ddb2419d02dae6f71745fb081a654f044af5148d))

## [0.1.24](https://github.com/Brooooooklyn/canvas/compare/v0.1.23...v0.1.24) (2022-06-30)

### Bug Fixes

- ctx.filter should store in state and be able to save/restore ([b85ee7b](https://github.com/Brooooooklyn/canvas/commit/b85ee7bd7093a6ab00b5806fdfdb0b13bcc438da))
- parameters for drawImage(canvas) ([2392263](https://github.com/Brooooooklyn/canvas/commit/23922636605d3a3ededa7006532327bfa36a7ebf))
- skia async prop deprecated in future release ([088e628](https://github.com/Brooooooklyn/canvas/commit/088e628dfe8b73abf777dda97ba057df1a8f340e))
- use premultiplied surface as default ([f13c1a3](https://github.com/Brooooooklyn/canvas/commit/f13c1a3fd0e3d2718fa1fd7c32c2a7979d98c5c5))
- wrong text metrics if text contains chars not including in current font-family ([cfcca26](https://github.com/Brooooooklyn/canvas/commit/cfcca2677facdd51ceb68e59e964b25ae75d211a))

### Features

- add stream and alt support for Image ([#486](https://github.com/Brooooooklyn/canvas/issues/486)) ([671c4b1](https://github.com/Brooooooklyn/canvas/commit/671c4b1535ddd6b38c644ed2c0e8aacccf4abc8c))
- implement loadImage function ([#483](https://github.com/Brooooooklyn/canvas/issues/483)) ([fa0d857](https://github.com/Brooooooklyn/canvas/commit/fa0d857ec90fb5357516487776b9ab7b1f851ae9))
- skia chrome/m104 ([0b2c865](https://github.com/Brooooooklyn/canvas/commit/0b2c865187027aedcebd7c9a49eac50c4b73ce23))

## [0.1.23](https://github.com/Brooooooklyn/canvas/compare/v0.1.22...v0.1.23) (2022-06-23)

## [0.1.22](https://github.com/Brooooooklyn/canvas/compare/v0.1.21...v0.1.22) (2022-06-02)

### Bug Fixes

- do nothing if lineTo parameters invalid ([0ddeb7c](https://github.com/Brooooooklyn/canvas/commit/0ddeb7cf8e97aff54f2fb315da8a3cc34a19ba48))
- svg image transparent background should be preserved ([531bde8](https://github.com/Brooooooklyn/canvas/commit/531bde88f219fd4b7f72f550a2bb647ed859f9c2))
- width in TextMetrics when text is ending with spaces ([5961fd2](https://github.com/Brooooooklyn/canvas/commit/5961fd2228c3f0965f25ab6f8b78ebb1a0220974))
- y offset when textBaseline is bottom ([26fdc3c](https://github.com/Brooooooklyn/canvas/commit/26fdc3c003d4e49ef4a4e45a1faebe34fdb29089))

### Features

- chrome/m101 ([0b77261](https://github.com/Brooooooklyn/canvas/commit/0b77261a4bcc24a8ecf0b526afa1583cf6679118))
- upgrade to chrome/m103 ([#465](https://github.com/Brooooooklyn/canvas/issues/465)) ([1f73a77](https://github.com/Brooooooklyn/canvas/commit/1f73a774b586c1e91fa9a36b1c9c478be4149571))

## [0.1.21](https://github.com/Brooooooklyn/canvas/compare/v0.1.20...v0.1.21) (2022-03-10)

### Bug Fixes

- BlendMode::Source should be copy instead of source ([a010fba](https://github.com/Brooooooklyn/canvas/commit/a010fba4c8e7ae3bed2e8119c6862c98e5a466b4))
- prevent segmentation fault if mesuring empty text ([2117ddb](https://github.com/Brooooooklyn/canvas/commit/2117ddbb413df47df8a716eb66e79eb552b2a986))
- should not throw if fill/stroke style is invalid ([0d12337](https://github.com/Brooooooklyn/canvas/commit/0d12337e8ed6590a4788fd7758e30a77db312577))
- stroke/fill text should treat \n as space ([4c9ac1e](https://github.com/Brooooooklyn/canvas/commit/4c9ac1e60b8a16b5209d83e115947cd7cbbf273e))

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
