import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ redirect, url }) => {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const tenantId = process.env.MICROSOFT_TENANT_ID || 'common';
  
  if (!clientId) {
    return new Response(JSON.stringify({ success: false, error: 'Microsoft OAuth is not configured on this server.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const redirectUri = `${url.origin}/api/auth/callback/microsoft`;
  const scope = 'openid email profile User.Read';
  
  const microsoftAuthUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?` +
    `client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&response_mode=query` +
    `&scope=${encodeURIComponent(scope)}`;

  return redirect(microsoftAuthUrl);
};
