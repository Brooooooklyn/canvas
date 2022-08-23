const { existsSync, readFileSync } = require('fs')
const { join } = require('path')

const { platform, arch } = process

let nativeBinding = null
let localFileExisted = false
let isMusl = false
let loadError = null

switch (platform) {
  case 'android':
    if (arch !== 'arm64') {
      throw new Error(`Unsupported architecture on Android ${arch}`)
    }
    localFileExisted = existsSync(join(__dirname, 'skia.android-arm64.node'))
    try {
      if (localFileExisted) {
        nativeBinding = require('./skia.android-arm64.node')
      } else {
        nativeBinding = require('@napi-rs/canvas-android-arm64')
      }
    } catch (e) {
      loadError = e
    }
    break
  case 'win32':
    // eslint-disable-next-line sonarjs/no-nested-switch
    switch (arch) {
      case 'x64':
        localFileExisted = existsSync(join(__dirname, 'skia.win32-x64-msvc.node'))
        try {
          if (localFileExisted) {
            nativeBinding = require('./skia.win32-x64-msvc.node')
          } else {
            nativeBinding = require('@napi-rs/canvas-win32-x64-msvc')
          }
        } catch (e) {
          loadError = e
        }
        break
      case 'ia32':
        localFileExisted = existsSync(join(__dirname, 'skia.win32-ia32-msvc.node'))
        try {
          if (localFileExisted) {
            nativeBinding = require('./skia.win32-ia32-msvc.node')
          } else {
            nativeBinding = require('@napi-rs/canvas-win32-ia32-msvc')
          }
        } catch (e) {
          loadError = e
        }
        break
      case 'arm64':
        localFileExisted = existsSync(join(__dirname, 'skia.win32-arm64-msvc.node'))
        try {
          if (localFileExisted) {
            nativeBinding = require('./skia.win32-arm64-msvc.node')
          } else {
            nativeBinding = require('@napi-rs/canvas-win32-arm64-msvc')
          }
        } catch (e) {
          loadError = e
        }
        break
      default:
        throw new Error(`Unsupported architecture on Windows: ${arch}`)
    }
    break
  case 'darwin':
    // eslint-disable-next-line sonarjs/no-nested-switch
    switch (arch) {
      case 'x64':
        localFileExisted = existsSync(join(__dirname, 'skia.darwin-x64.node'))
        try {
          if (localFileExisted) {
            nativeBinding = require('./skia.darwin-x64.node')
          } else {
            nativeBinding = require('@napi-rs/canvas-darwin-x64')
          }
        } catch (e) {
          loadError = e
        }
        break
      case 'arm64':
        localFileExisted = existsSync(join(__dirname, 'skia.darwin-arm64.node'))
        try {
          if (localFileExisted) {
            nativeBinding = require('./skia.darwin-arm64.node')
          } else {
            nativeBinding = require('@napi-rs/canvas-darwin-arm64')
          }
        } catch (e) {
          loadError = e
        }
        break
      default:
        throw new Error(`Unsupported architecture on macOS: ${arch}`)
    }
    break
  case 'freebsd':
    if (arch !== 'x64') {
      throw new Error(`Unsupported architecture on FreeBSD: ${arch}`)
    }
    localFileExisted = existsSync(join(__dirname, 'skia.freebsd-x64.node'))
    try {
      if (localFileExisted) {
        nativeBinding = require('./skia.freebsd-x64.node')
      } else {
        nativeBinding = require('@napi-rs/canvas-freebsd-x64')
      }
    } catch (e) {
      loadError = e
    }
    break
  case 'linux':
    // eslint-disable-next-line sonarjs/no-nested-switch
    switch (arch) {
      case 'x64':
        isMusl = readFileSync('/usr/bin/ldd', 'utf8').includes('musl')
        if (isMusl) {
          localFileExisted = existsSync(join(__dirname, 'skia.linux-x64-musl.node'))
          try {
            if (localFileExisted) {
              nativeBinding = require('./skia.linux-x64-musl.node')
            } else {
              nativeBinding = require('@napi-rs/canvas-linux-x64-musl')
            }
          } catch (e) {
            loadError = e
          }
        } else {
          localFileExisted = existsSync(join(__dirname, 'skia.linux-x64-gnu.node'))
          try {
            if (localFileExisted) {
              nativeBinding = require('./skia.linux-x64-gnu.node')
            } else {
              nativeBinding = require('@napi-rs/canvas-linux-x64-gnu')
            }
          } catch (e) {
            loadError = e
          }
        }
        break
      case 'arm64':
        isMusl = readFileSync('/usr/bin/ldd', 'utf8').includes('musl')
        if (isMusl) {
          localFileExisted = existsSync(join(__dirname, 'skia.linux-arm64-musl.node'))
          try {
            if (localFileExisted) {
              nativeBinding = require('./skia.linux-arm64-musl.node')
            } else {
              nativeBinding = require('@napi-rs/canvas-linux-arm64-musl')
            }
          } catch (e) {
            loadError = e
          }
        } else {
          localFileExisted = existsSync(join(__dirname, 'skia.linux-arm64-gnu.node'))
          try {
            if (localFileExisted) {
              nativeBinding = require('./skia.linux-arm64-gnu.node')
            } else {
              nativeBinding = require('@napi-rs/canvas-linux-arm64-gnu')
            }
          } catch (e) {
            loadError = e
          }
        }
        break
      case 'arm':
        localFileExisted = existsSync(join(__dirname, 'skia.linux-arm-gnueabihf.node'))
        try {
          if (localFileExisted) {
            nativeBinding = require('./skia.linux-arm-gnueabihf.node')
          } else {
            nativeBinding = require('@napi-rs/canvas-linux-arm-gnueabihf')
          }
        } catch (e) {
          loadError = e
        }
        break
      default:
        throw new Error(`Unsupported architecture on Linux: ${arch}`)
    }
    break
  default:
    throw new Error(`Unsupported OS: ${platform}, architecture: ${arch}`)
}

if (!nativeBinding) {
  if (loadError) {
    throw loadError
  }
  throw new Error(`Failed to load native binding`)
}

const {
  clearAllCache,
  CanvasRenderingContext2D,
  CanvasElement,
  SVGCanvas,
  Path,
  ImageData,
  Image,
  CanvasPattern,
  GlobalFonts,
  convertSVGTextToPath,
  PathOp,
  FillType,
  StrokeJoin,
  StrokeCap,
} = nativeBinding

module.exports.clearAllCache = clearAllCache
module.exports.CanvasRenderingContext2D = CanvasRenderingContext2D
module.exports.CanvasElement = CanvasElement
module.exports.SVGCanvas = SVGCanvas
module.exports.Path2D = Path
module.exports.ImageData = ImageData
module.exports.Image = Image
module.exports.CanvasPattern = CanvasPattern
module.exports.GlobalFonts = GlobalFonts
module.exports.convertSVGTextToPath = convertSVGTextToPath
module.exports.PathOp = PathOp
module.exports.FillType = FillType
module.exports.StrokeJoin = StrokeJoin
module.exports.StrokeCap = StrokeCap
