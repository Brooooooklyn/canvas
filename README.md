# `@napi-rs/package-template`

![https://github.com/napi-rs/package-template/actions](https://github.com/napi-rs/package-template/workflows/CI/badge.svg)

> Template project for writing node package with napi-rs.

## Install this test package

```
yarn add @napi-rs/package-template
```

## Support matrix

> ⚠️ Linux musl has not been supported now.

### Operating Systems

| Linux | macOS | Windows x64 MSVC |
| ----- | ----- | ---------------- |
| ✓     | ✓     | ✓                |

### NodeJS

| Node10 | Node 12 | Node14 |
| ------ | ------- | ------ |
| ✓      | ✓       | ✓      |

## Ability

### Build

After `yarn build/npm run build` command, you can see `index.[darwin|win32|linux].node` file in project root. This is the native addon built from [lib.rs](./src/lib.rs).

### Test

With [ava](https://github.com/avajs/ava), run `yarn test/npm run test` to testing native addon. You can also switch to another testing framework if you want.

### CI

With github actions, every commits and pull request will be built and tested automatically in [`node@10`, `node@12`, `@node14`] x [`macOS`, `Linux`, `Windows`] matrix. You will never be afraid of the native addon broken in these platforms.

### Release

Release native package is very difficult in old days. Native packages may ask developers who use its to install `build toolchains` like `gcc/llvm` , `node-gyp` or something more.

With `Github actions`, we can easily prebuild `binary` for major platforms. And with `N-API`, we should never afraid of **ABI Compatible**.

The other problem is how to deliver prebuild `binary` to users. Download it in `postinstall` script is a common way which most packages do it right now. The problem of this solution is it introduced many other packages to download binary which has not been used by `runtime codes`. The other problem is some user may not easily download the binary from `github/CDN` if they are behind private network (But in most case, they have a private NPM mirror).

In this package we choose a better way to solve this problem. We release different `npm packages` for different platform. And add it to `optionalDependencies` before release the `Major` package to npm.

`NPM` will choose which native package should download from `registry` automatically. You can see [npm](./npm) dir for details. And you can also run `yarn add @napi-rs/package-template` to see how it works.

## Develop requirements

- Install latest `Rust`
- Install `NodeJS@8.9+` which supported `N-API`
- Install `yarn@1.x`

## Test in local

- yarn
- yarn build
- yarn test

And you will see:

```bash
$ ava --verbose

  ✔ sync function from native code
  ✔ sleep function from native code (201ms)
  ─

  2 tests passed
✨  Done in 1.12s.
```

## Release package

Ensure you have set you **NPM_TOKEN** in `Github` project setting.

In `Settings -> Secrets`, add **NPM_TOKEN** into it.

When you want release package:

```
yarn version [xxx]

git push --follow-tags
```

Github actions will do the rest job for you.
