import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { deflateSync, strToU8 } from "fflate";
import { columnLabel, decodeDelimitedBytes, parseDelimited } from "../../plugins/structured-preview/src/delimited-model";
import { normalizeDrawio } from "../../plugins/structured-preview/src/drawio-model";

const dom = new JSDOM();
Object.assign(globalThis, { DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer });

test("CSV retains exact text, quotes, CRLF, multiline cells, empty fields and formula-looking literals", () => {
  assert.deepEqual(parseDelimited('\uFEFFName,Amount,Note\r\n"中文,数据",00125,"one\r\ntwo"\r\nQ,=1+1,"He said ""hello"""\r\n,,\r\n', ','), [
    ['Name','Amount','Note'],['中文,数据','00125','one\r\ntwo'],['Q','=1+1','He said "hello"'],['','',''],
  ]);
  assert.deepEqual(parseDelimited('a,b,', ','), [['a','b','']]);
  assert.deepEqual(parseDelimited('', ','), []);
  assert.deepEqual(parseDelimited('""', ','), [['']]);
});
test("TSV honors quoted tabs and rejects unclosed or malformed quoted cells", () => {
  assert.deepEqual(parseDelimited('a\t"b\tc"\n', '\t'), [['a','b\tc']]);
  assert.throws(() => parseDelimited('a,"oops', ','), /Unclosed/);
  assert.throws(() => parseDelimited('"a"oops', ','), /Unexpected/);
  assert.throws(() => parseDelimited('x,'.repeat(4096), ','), /limits/);
});
test("UTF-8, UTF-16 BOM and GB18030 Chinese input decode without numeric coercion", () => {
  assert.equal(decodeDelimitedBytes(new TextEncoder().encode('中文,001')), '中文,001');
  assert.equal(decodeDelimitedBytes(Uint8Array.from([0xff,0xfe,0x2d,0x4e,0x87,0x65])), '中文');
  assert.equal(decodeDelimitedBytes(Uint8Array.from([0xd6,0xd0,0xce,0xc4])), '中文');
  assert.deepEqual([0,25,26,51,52,701,702].map(columnLabel), ['A','Z','AA','AZ','BA','ZZ','AAA']);
});
test("Draw.io accepts model and multi-page wrappers and expands compressed DIO pages", () => {
  const model='<mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>';
  assert.match(normalizeDrawio(model), /mxGraphModel/);
  const compressed=Buffer.from(deflateSync(strToU8(encodeURIComponent(model)))).toString('base64');
  const expanded=normalizeDrawio(`<mxfile><diagram name="one">${compressed}</diagram><diagram name="two">${model}</diagram></mxfile>`);
  const doc=new dom.window.DOMParser().parseFromString(expanded,'application/xml');
  assert.equal(doc.querySelectorAll('diagram > mxGraphModel').length,2);
  assert.equal(doc.documentElement.getAttribute('compressed'),'false');
});
test("Draw.io rejects malformed XML, entities, invalid pages and bounded expansion", () => {
  for (const xml of ['<html/>','<!DOCTYPE a><mxfile/>','<mxfile/>','<mxfile><diagram><html/></diagram></mxfile>','<mxfile><diagram>bad data</diagram></mxfile>']) assert.throws(()=>normalizeDrawio(xml));
  const bomb=Buffer.from(deflateSync(strToU8('a'.repeat(17*1024*1024)))).toString('base64');
  assert.throws(()=>normalizeDrawio(`<mxfile><diagram>${bomb}</diagram></mxfile>`),/limits/);
});
