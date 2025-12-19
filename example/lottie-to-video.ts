import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'


import { createCanvas, LottieAnimation } from '../index.js'
import {
  VideoEncoder,
  VideoFrame,
  Mp4Muxer,
  type EncodedVideoChunk,
  type EncodedVideoChunkMetadata,
} from '@napi-rs/webcodecs'

const __dirname = new URL('.', import.meta.url).pathname

async function main() {
  // Load the Lottie animation from extracted data
  const animation = LottieAnimation.loadFromData(readFileSync(join(__dirname, 'LoopingCircless.json'), 'utf-8'))

  console.log('Animation loaded:')
  console.log(`  Duration: ${animation.duration.toFixed(2)}s`)
  console.log(`  FPS: ${animation.fps}`)
  console.log(`  Frames: ${animation.frames}`)
  console.log(`  Size: ${animation.width}x${animation.height}`)
  console.log(`  Version: ${animation.version}`)

  // Use original animation size (ensure dimensions are even for video codecs)
  const encodedWidth = Math.round(animation.width) % 2 === 0 ? Math.round(animation.width) : Math.round(animation.width) + 1
  const encodedHeight = Math.round(animation.height) % 2 === 0 ? Math.round(animation.height) : Math.round(animation.height) + 1

  console.log(`\nOutput size: ${encodedWidth}x${encodedHeight}`)

  // Create the canvas for rendering
  const canvas = createCanvas(encodedWidth, encodedHeight)
  const ctx = canvas.getContext('2d')

  // Calculate frame duration in microseconds
  const fps = animation.fps
  const frameDurationUs = Math.round(1_000_000 / fps)
  const totalFrames = Math.round(animation.frames)

  // Collect all encoded chunks and metadata first (following webcodecs test pattern)
  const videoChunks: EncodedVideoChunk[] = []
  const videoMetadatas: (EncodedVideoChunkMetadata | undefined)[] = []

  // Create video encoder
  const encoder = new VideoEncoder({
    output: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => {
      videoChunks.push(chunk)
      videoMetadatas.push(meta)

      const count = videoChunks.length
      if (count % 30 === 0 || count === totalFrames) {
        console.log(`  Encoded ${count}/${totalFrames} frames`)
      }
    },
    error: (e: Error) => {
      console.error('Encoder error:', e)
    },
  })

  // Configure encoder for H.264 Baseline (no B-frames for smoother playback)
  encoder.configure({
    codec: 'avc1.42001f', // H.264 Baseline Profile Level 3.1
    width: encodedWidth,
    height: encodedHeight,
    bitrate: 5_000_000, // 5 Mbps
    framerate: fps,
    latencyMode: 'realtime', // Disable B-frames for smoother sequential playback
  })

  console.log('\nEncoding frames...')

  // Render and encode each frame
  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
    // Seek to exact frame for precise animation timing
    animation.seekFrame(frameIndex)

    // Clear the canvas with white background
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, encodedWidth, encodedHeight)

    // Render the animation with destination rect for proper scaling
    // Note: ctx.scale() doesn't affect Skottie rendering - must use dst rect
    animation.render(ctx, { x: 0, y: 0, width: encodedWidth, height: encodedHeight })

    // Create a VideoFrame from the canvas
    const timestamp = frameIndex * frameDurationUs
    const frame = new VideoFrame(canvas, {
      timestamp,
      duration: frameDurationUs,
    })

    // Encode the frame (request keyframe every 2 seconds)
    const isKeyFrame = frameIndex % Math.round(fps * 2) === 0
    encoder.encode(frame, { keyFrame: isKeyFrame })

    // Close the frame to release resources
    frame.close()
  }

  // Flush the encoder to ensure all frames are processed
  console.log('\nFlushing encoder...')
  await encoder.flush()
  encoder.close()

  console.log(`\nCollected ${videoChunks.length} chunks`)

  // Now create the muxer and add all chunks
  // Note: fastStart is not compatible with in-memory muxing
  const muxer = new Mp4Muxer()

  // Get codec description from the first keyframe's metadata
  const description = videoMetadatas[0]?.decoderConfig?.description

  // Add video track with the codec description (avcC box for H.264)
  muxer.addVideoTrack({
    codec: 'avc1.42001f',
    width: encodedWidth,
    height: encodedHeight,
    description,
  })

  console.log('Muxing chunks...')

  // Add all chunks to the muxer
  for (let i = 0; i < videoChunks.length; i++) {
    muxer.addVideoChunk(videoChunks[i], videoMetadatas[i])
  }

  // Flush and finalize the muxer
  console.log('Finalizing MP4...')
  await muxer.flush()
  const mp4Data = muxer.finalize()
  muxer.close()

  // Write to file
  const outputPath = join(__dirname, 'output.mp4')
  writeFileSync(outputPath, mp4Data)

  console.log(`\nVideo saved to: ${outputPath}`)
  console.log(`File size: ${(mp4Data.byteLength / 1024 / 1024).toFixed(2)} MB`)
}

main().catch(console.error)
