declare module 'pdf-parse';

declare namespace App {
  interface Locals {
    lang: 'es' | 'gl' | 'en' | 'pt';
    user?: {
      email: string;
      name: string;
      role: string;
    };
  }
}
