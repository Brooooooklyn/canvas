const path = require('node:path');

/**
 * @type {import('webpack').Configuration}
 */
module.exports = {
  entry: './src/index.js',
  target: 'node',
  mode: 'production',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.js',
  },
  resolve: {
    extensions: ['.js', '.json', '.node'],
  },
  module: {
    rules: [
      {
        test: /\.node$/,
        loader: 'node-loader',
      },
    ]
  },
  optimization: {
    minimize: true,
  },
  stats: 'errors-only',
};