module.exports = [
    {
        output: {
            filename: 'jsspeccy/jsspeccy.js',
        },
        name: 'jsspeccy',
        entry: './runtime/jsspeccy.js',
        mode: 'production',
        module: {
            rules: [
                {
                    test: /\.svg$/,
                    loader: 'svg-inline-loader',
                },
                {
                    test: /\.(jpg|jpeg|png|gif)$/,
                    type: 'asset/resource',
                    generator: {
                        filename: 'jsspeccy/[name][ext]'
                    }
                }
            ],
        }
    },
    {
        output: {
            filename: 'jsspeccy/jsspeccy-worker.js',
        },
        name: 'worker',
        entry: './runtime/worker.js',
        mode: 'production',
    },
];
