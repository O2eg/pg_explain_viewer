'use strict';

// One deliberately small bridge between the Python packager and the
// lockfile-pinned JavaScript minifier. Source arrives on stdin and code leaves
// on stdout, so build.py never creates intermediate artifacts.
const fs = require('node:fs');
const { minify } = require('terser');

async function main() {
  const source = fs.readFileSync(0, 'utf8');
  const result = await minify(source, {
    compress: { passes: 2 },
    mangle: true,
    ecma: 2018,
    format: {
      comments: false,
      // Prevent an optimized string from closing its own HTML script element.
      inline_script: true,
    },
  });
  if (!result.code) throw new Error('Terser returned no code');
  process.stdout.write(result.code);
}

main().catch(error => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + '\n');
  process.exitCode = 1;
});
