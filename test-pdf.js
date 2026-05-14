const fs = require('fs');
const pdf = require('pdf-parse');
const files = fs.readdirSync('./pdfs').filter(f => f.endsWith('.pdf'));
if (files.length > 0) {
  const buf = fs.readFileSync('./pdfs/' + files[0]);
  if (typeof pdf.PDFParse === 'function') {
    try {
      // Trying PDFParse as a function
      const res = pdf.PDFParse(buf);
      console.log('PDFParse is a function. Returns promise?', res instanceof Promise);
      if (res instanceof Promise) {
        res.then(data => console.log('Text length:', data.text.length)).catch(e => console.error('Promise error', e));
      } else {
        console.log('Text length:', res.text ? res.text.length : 'no text');
      }
    } catch (e) {
      console.error('Call failed:', e.message);
    }
  }
} else {
  console.log('No pdfs found');
}
