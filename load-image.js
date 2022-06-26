const fs = require('fs')
const { Image } = require('./js-binding')

let http, https

const MAX_REDIRECTS = 20,
  REDIRECT_STATUSES = [301, 302],
  DATA_URI = /^\s*data:/

/**
 * Loads the given source into canvas Image
 * @param {string|URL|Image|Buffer} source The image source to be loaded
 * @param {object} options Options passed to the loader
 */
module.exports = async function loadImage(source, options = {}) {
  // use the same buffer without copying if the source is a buffer
  if (Buffer.isBuffer(source)) return createImage(source)
  // construct a buffer if the source is buffer-like
  if (isBufferLike(source)) return createImage(Buffer.from(source))
  // if the source is Image instance, copy the image src to new image
  if (source instanceof Image) return createImage(source.src)
  // if source is string and in data uri format, construct image using data uri
  if (typeof source === 'string' && DATA_URI.test(source)) {
    const commaIdx = source.indexOf(',')
    const encoding = source.lastIndexOf('base64', commaIdx) < 0 ? 'utf-8' : 'base64'
    const data = Buffer.from(source.slice(commaIdx + 1), encoding)
    return createImage(data)
  }
  // if source is a string or URL instance
  if (typeof source === 'string' || source instanceof URL) {
    // if the source exists as a file, construct image from that file
    if (fs.existsSync(source)) {
      return createImage(await fs.promises.readFile(source))
    } else {
      // the source is a remote url here
      source = !(source instanceof URL) ? new URL(source) : source
      // attempt to download the remote source and construct image
      const data = await new Promise((resolve, reject) =>
        makeRequest(source, resolve, reject, options.maxRedirects ?? MAX_REDIRECTS, options.requestOptions),
      )
      return createImage(data)
    }
  }

  // throw error as dont support that source
  throw new TypeError('unsupported image source')
}

function makeRequest(url, resolve, reject, redirectCount, requestOptions) {
  const isHttps = url.protocol === 'https:'
  // lazy load the lib
  const lib = isHttps ? (!https ? (https = require('https')) : https) : !http ? (http = require('http')) : http

  lib.get(url, requestOptions ?? {}, (res) => {
    const shouldRedirect = REDIRECT_STATUSES.includes(res.statusCode) && typeof res.headers.location === 'string'
    if (shouldRedirect && redirectCount > 0)
      return makeRequest(res.headers.location, resolve, reject, redirectCount - 1, requestOptions)
    if (typeof res.statusCode === 'number' && res.statusCode < 200 && res.statusCode >= 300) {
      return reject(new Error(`remote source rejected with status code ${res.statusCode}`))
    }

    consumeStream(res).then(resolve, reject)
  })
}

// use stream/consumers in the future?
function consumeStream(res) {
  return new Promise((resolve, reject) => {
    const chunks = []

    res.on('data', (chunk) => chunks.push(chunk))
    res.on('end', () => resolve(Buffer.concat(chunks)))
    res.on('error', reject)
  })
}

function createImage(src) {
  const image = new Image()
  image.src = src
  return image
}

function isBufferLike(src) {
  return (
    Array.isArray(src) ||
    src instanceof ArrayBuffer ||
    src instanceof SharedArrayBuffer ||
    src instanceof Object.getPrototypeOf(Uint8Array)
  )
}
