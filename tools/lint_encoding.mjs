// Source builds already require Node.js; keep the BOM gate shell-independent.
import { readFileSync, readdirSync } from 'node:fs';

const source = new URL('../src/', import.meta.url);
for (const name of readdirSync(source).filter(name => name.endsWith('.pb'))) {
  const bytes = readFileSync(new URL(name, source));
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    console.log(`  OK   ${name}`);
  } else {
    console.error(`  FAIL ${name} - missing UTF-8 BOM (BOM-less UTF-8 mojibakes on the PB compilers)`);
    process.exitCode = 1;
  }
}
