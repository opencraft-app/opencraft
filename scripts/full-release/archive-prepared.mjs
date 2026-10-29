#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { archivePreparedPackage } from './producer.mjs';
const spec = JSON.parse(await readFile(process.argv[2], 'utf8'));
console.log(JSON.stringify(await archivePreparedPackage(spec)));
