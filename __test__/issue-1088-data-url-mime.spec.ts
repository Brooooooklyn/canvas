import test from 'ava'
import { Image } from '../index'

test('should handle data URL with non-image MIME type containing JPEG data (issue #1088)', async (t) => {
  // This is a simple test case using a small PNG image with wrong MIME type
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII='
  
  const image = new Image()
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  
  image.onload = () => {
    t.pass('Image loaded successfully')
    resolve()
  }
  
  image.onerror = (err) => {
    t.fail(`Should not fail to load data URL with non-image MIME type: ${err.message}`)
    reject(err)
  }
  
  // This should work but previously failed with "File name too long" error
  image.src = `data:application/octet-stream;base64,${pngBase64}`
  
  await promise
  
  // Verify the image has valid dimensions
  t.true(image.width > 0, 'Image width should be greater than 0')
  t.true(image.height > 0, 'Image height should be greater than 0')
})

test('should handle data URL with text MIME type containing PNG data', async (t) => {
  // This tests the exact pattern from the issue - any data: URL should work
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII='
  
  const image = new Image()
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  
  image.onload = () => {
    t.pass('Image loaded successfully')
    resolve()
  }
  
  image.onerror = (err) => {
    t.fail(`Should not fail to load data URL with text MIME type: ${err.message}`)
    reject(err)
  }
  
  // Before the fix, only "data:image/*" was recognized, now any "data:" URL is parsed
  image.src = `data:text/plain;base64,${pngBase64}`
  
  await promise
  
  // Verify the image has valid dimensions  
  t.true(image.width > 0, 'Image width should be greater than 0')
  t.true(image.height > 0, 'Image height should be greater than 0')
})

test('data URL with correct image MIME type should still work', async (t) => {
  // This should continue to work as before
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII='
  
  const image = new Image()
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  
  image.onload = () => {
    t.pass('Image loaded successfully')
    resolve()
  }
  
  image.onerror = (err) => {
    t.fail(`Should not fail to load data URL with image MIME type: ${err.message}`)
    reject(err)
  }
  
  image.src = `data:image/png;base64,${pngBase64}`
  
  await promise
  
  // Verify the image has valid dimensions
  t.true(image.width > 0, 'Image width should be greater than 0')
  t.true(image.height > 0, 'Image height should be greater than 0')
})