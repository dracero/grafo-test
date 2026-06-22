import { generateCorrectedProgramPDF } from '../src/services/pdf-generator';
import pdfParse from 'pdf-parse';

async function test() {
  try {
    console.log('Generating PDF...');
    const programName = 'RESCS_2023_1600_PETROLEO_Plan_de_Estudios_Texto_ordenado_681ce83c8e.pdf';
    const pdfBuffer = await generateCorrectedProgramPDF(programName, null, [], '{"corrections": []}');
    console.log(`Generated buffer of size: ${pdfBuffer.length} bytes`);
    
    console.log('Parsing PDF...');
    const parsed = await pdfParse(pdfBuffer);
    console.log('Parsed successfully! Pages:', parsed.numpages);
  } catch (err: any) {
    console.error('Error during test:', err);
  }
}

test();
