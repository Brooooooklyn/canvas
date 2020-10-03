const { sync } = require('./index')

console.assert(sync(0) === 100, 'Simple test failed')

console.info('Simple test passed')
