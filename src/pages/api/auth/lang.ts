import type { APIRoute } from 'astro';
import { SUPPORTED_LANGUAGES } from '../../../lib/i18n';

export const POST: APIRoute = async ({ request, cookies }) => {
  try {
    const { lang } = await request.json();
    if (!lang || !SUPPORTED_LANGUAGES.includes(lang)) {
      return new Response(JSON.stringify({ success: false, error: 'Idioma no soportado' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    cookies.set('app_lang', lang, {
      path: '/',
      maxAge: 365 * 24 * 60 * 60, // 1 year
      httpOnly: false, // Accessible from client js if needed
      sameSite: 'lax'
    });

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
