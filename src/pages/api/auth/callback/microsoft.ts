import type { APIRoute } from 'astro';
import { upsertOAuthUser } from '../../../../lib/mongodb';
import { createToken } from '../../../../lib/auth';

export const GET: APIRoute = async ({ redirect, cookies, url }) => {
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    return redirect(`/login?error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return redirect('/login?error=no_code_provided');
  }

  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const tenantId = process.env.MICROSOFT_TENANT_ID || 'common';

  if (!clientId || !clientSecret) {
    return new Response(JSON.stringify({ success: false, error: 'Microsoft OAuth configuration missing on server.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const redirectUri = `${url.origin}/api/auth/callback/microsoft`;
    
    // Exchange authorization code for access token
    const tokenResponse = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      })
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      console.error('Microsoft token exchange error:', errText);
      return redirect('/login?error=token_exchange_failed');
    }

    const tokens = await tokenResponse.json();
    const accessToken = tokens.access_token;

    if (!accessToken) {
      return redirect('/login?error=no_access_token');
    }

    // Retrieve user profile information from Microsoft Graph
    const userinfoResponse = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!userinfoResponse.ok) {
      console.error('Microsoft Graph fetch failed:', await userinfoResponse.text());
      return redirect('/login?error=failed_to_fetch_profile');
    }

    const profile = await userinfoResponse.json();
    const email = profile.mail || profile.userPrincipalName;
    const name = profile.displayName || email;

    if (!email) {
      return redirect('/login?error=no_email_returned');
    }

    // Upsert the user into MongoDB
    const user = await upsertOAuthUser(email, name, 'microsoft');

    // Create session token (JWT)
    const token = createToken({
      email: user.email,
      name: user.name,
      role: user.role
    });

    // Set cookie
    cookies.set('session_token', token, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 // 24 hours
    });

    // Redirect to home page
    return redirect('/');
  } catch (err: any) {
    console.error('Microsoft OAuth error:', err);
    return redirect(`/login?error=${encodeURIComponent(err.message)}`);
  }
};
