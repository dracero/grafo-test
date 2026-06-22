import { defineMiddleware } from 'astro:middleware';
import { getSessionUser } from './lib/auth';
import { getUserByEmail } from './lib/mongodb';
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from './lib/i18n';

const PUBLIC_PATHS = ['/login', '/register', '/pending'];

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  // 1. Language Resolution
  let lang = context.cookies.get('app_lang')?.value;
  if (!lang || !SUPPORTED_LANGUAGES.includes(lang as any)) {
    const acceptLang = context.request.headers.get('accept-language');
    if (acceptLang) {
      const match = acceptLang.split(',')[0].split('-')[0];
      if (SUPPORTED_LANGUAGES.includes(match as any)) {
        lang = match;
      }
    }
    lang = lang || DEFAULT_LANGUAGE;
    context.cookies.set('app_lang', lang, { path: '/' });
  }
  context.locals.lang = lang as any;

  // Allow static assets, images, and non-auth API endpoints
  if (
    pathname.startsWith('/_astro/') ||
    (pathname.includes('.') && !pathname.startsWith('/api/')) ||
    pathname.startsWith('/api/auth/')
  ) {
    return next();
  }

  // 2. Auth Resolution
  const sessionToken = context.cookies.get('session_token')?.value;
  const user = await getSessionUser(sessionToken);

  const isPublic = PUBLIC_PATHS.includes(pathname);

  if (user) {
    context.locals.user = user;

    // Verify current user state from MongoDB
    const dbUser = await getUserByEmail(user.email);
    const isPending = !dbUser || !dbUser.isActive || dbUser.role === 'pending';

    if (isPending) {
      if (pathname === '/pending') {
        return next();
      }
      if (pathname.startsWith('/api/')) {
        return new Response(JSON.stringify({ success: false, error: 'role_pending' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return context.redirect('/pending');
    }

    // Approved user
    if (pathname === '/login' || pathname === '/register' || pathname === '/pending') {
      return context.redirect('/');
    }
    return next();
  } else {
    context.locals.user = undefined;
    if (!isPublic) {
      // For API routes, return a JSON error instead of redirecting
      if (pathname.startsWith('/api/')) {
        return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Protected page, redirect to login
      return context.redirect('/login');
    }
    return next();
  }
});
