import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ redirect, url }) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return new Response(JSON.stringify({ success: false, error: 'Google OAuth is not configured on this server.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const redirectUri = `${url.origin}/api/auth/callback/google`;
  const scope = 'openid email profile';
  
  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scope)}`;

  return redirect(googleAuthUrl);
};
