import { genkit } from 'genkit';
import { googleAI } from '@genkit-ai/google-genai';
require('dotenv').config();

async function test() {
  const ai = genkit({ plugins: [googleAI({ apiKey: process.env.GOOGLE_GENAI_API_KEY })] });
  try {
    const res = await ai.generate({ model: 'gemini-1.5-flash', prompt: 'hi' });
    console.log('1.5 works');
  } catch(e: any) { console.log('1.5 failed', e.message); }
  
  try {
    const res = await ai.generate({ model: 'gemini-2.0-flash', prompt: 'hi' });
    console.log('2.0 works');
  } catch(e: any) { console.log('2.0 failed', e.message); }
  
  try {
    const res = await ai.generate({ model: 'gemini-2.5-flash', prompt: 'hi' });
    console.log('2.5 works');
  } catch(e: any) { console.log('2.5 failed', e.message); }
  
  try {
    const res = await ai.generate({ model: 'googleai/gemini-2.5-flash', prompt: 'hi' });
    console.log('googleai/2.5 works');
  } catch(e: any) { console.log('googleai/2.5 failed', e.message); }
}
test();
