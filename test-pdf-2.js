const fs = require('fs');
const pdf = require('pdf-parse');
const files = fs.readdirSync('./pdfs').filter(f => f.endsWith('.pdf'));
const buf = fs.readFileSync('./pdfs/' + files[0]);
const p = new pdf.PDFParse();
console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(p)));
