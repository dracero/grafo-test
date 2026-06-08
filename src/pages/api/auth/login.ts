import type { APIRoute } from 'astro';
import { getUserByEmail } from '../../../lib/mongodb';
import { verifyPassword, createToken } from '../../../lib/auth';

export const POST: APIRoute = async ({ request, cookies }) => {
  try {
    const { email, password } = await request.json();
    if (!email || !password) {
      return new Response(JSON.stringify({ success: false, error: 'Campos requeridos vacíos' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const user = await getUserByEmail(email);
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Credenciales inválidas' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (user.provider !== 'local' || !user.passwordHash) {
      return new Response(JSON.stringify({ success: false, error: 'Por favor, inicie sesión con su proveedor social' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const isValid = verifyPassword(password, user.passwordHash);
    if (!isValid) {
      return new Response(JSON.stringify({ success: false, error: 'Credenciales inválidas' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!user.isActive) {
      return new Response(JSON.stringify({ success: false, error: 'account_disabled' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (user.role === 'pending') {
      return new Response(JSON.stringify({ success: false, error: 'role_pending' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const token = createToken({
      email: user.email,
      name: user.name,
      role: user.role
    });

    cookies.set('session_token', token, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 // 24 hours
    });

    return new Response(JSON.stringify({ success: true, user: { email: user.email, name: user.name, role: user.role } }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    let msg = error.message;
    if (msg.includes('ECONNREFUSED') || msg.includes('connect ECONNREFUSED') || msg.includes('topology') || msg.includes('Server selection timed out')) {
      msg = 'No se pudo conectar a la base de datos de usuarios (MongoDB). Por favor, asegúrese de que MongoDB esté ejecutándose localmente en el puerto 27017 o configure MONGODB_URI en su archivo .env';
    }
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
