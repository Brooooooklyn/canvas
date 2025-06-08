const { createCanvas } = require('./index.js');

// Test for issue #1055 - createPattern memory leaks
console.log('Testing createPattern memory leak fix...');

// Create a source canvas
const sourceCanvas = createCanvas(100, 100);
const sourceCtx = sourceCanvas.getContext('2d');
sourceCtx.fillStyle = 'red';
sourceCtx.fillRect(0, 0, 100, 100);

// Create a destination canvas
const destCanvas = createCanvas(200, 200);
const destCtx = destCanvas.getContext('2d');

// Get initial memory usage
const initialMemory = process.memoryUsage();
console.log('Initial memory usage:', {
  rss: (initialMemory.rss / 1024 / 1024).toFixed(2) + ' MB',
  heapUsed: (initialMemory.heapUsed / 1024 / 1024).toFixed(2) + ' MB',
});

// Create patterns repeatedly (this would leak memory before the fix)
const iterations = 1000;
console.log(`Creating ${iterations} patterns...`);

for (let i = 0; i < iterations; i++) {
  const pattern = destCtx.createPattern(sourceCanvas, 'repeat');
  destCtx.fillStyle = pattern;
  destCtx.fillRect(0, 0, 200, 200);
  
  if (i % 100 === 0) {
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }
    
    const currentMemory = process.memoryUsage();
    console.log(`Iteration ${i}: RSS=${(currentMemory.rss / 1024 / 1024).toFixed(2)} MB, Heap=${(currentMemory.heapUsed / 1024 / 1024).toFixed(2)} MB`);
  }
}

// Force final garbage collection
if (global.gc) {
  global.gc();
}

// Get final memory usage
const finalMemory = process.memoryUsage();
console.log('\nFinal memory usage:', {
  rss: (finalMemory.rss / 1024 / 1024).toFixed(2) + ' MB',
  heapUsed: (finalMemory.heapUsed / 1024 / 1024).toFixed(2) + ' MB',
});

console.log('\nMemory increase:', {
  rss: ((finalMemory.rss - initialMemory.rss) / 1024 / 1024).toFixed(2) + ' MB',
  heapUsed: ((finalMemory.heapUsed - initialMemory.heapUsed) / 1024 / 1024).toFixed(2) + ' MB',
});

console.log('\nTest completed successfully!');
console.log('If memory increase is reasonable (<10MB), the memory leak has been fixed.');