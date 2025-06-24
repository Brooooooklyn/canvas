// E2E test for PDF rendering with pdfjs-dist and @napi-rs/canvas
// This test verifies that pdfjs-dist can render PDFs to canvas in a webpack bundle

import fs from 'fs';
import { createCanvas } from '@napi-rs/canvas';

const init = async () => {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  
  // Set worker source for pdfjs-dist
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdfjs-dist/legacy/build/pdf.worker.mjs';
  
  return pdfjsLib;
};

async function convertPdfToImage() {
  const pdfjsLib = await init();
  
  try {
    console.log('Loading PDF document...');
    
    // Load PDF document
    const loadingTask = pdfjsLib.getDocument('test.pdf');
    const pdfDocument = await loadingTask.promise;
    
    console.log(`PDF loaded successfully. Pages: ${pdfDocument.numPages}`);
    
    // Get first page
    const page = await pdfDocument.getPage(1);
    
    // Create viewport and canvas
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');
    
    console.log(`Canvas created: ${viewport.width}x${viewport.height}`);
    
    // Render page to canvas
    const renderContext = {
      canvasContext: context,
      viewport: viewport
    };
    
    console.log('Rendering PDF page to canvas...');
    await page.render(renderContext).promise;
    
    // Save as PNG
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync('output.png', buffer);
    
    console.log('✅ Successfully converted first page to output.png');
    console.log('🎉 PDF rendering test completed successfully!');
    
  } catch (error) {
    console.error('❌ Error converting PDF:', error);
    throw error;
  }
}

// Execute conversion
convertPdfToImage().catch(error => {
  console.error('💥 PDF conversion failed:', error);
  process.exit(1);
});