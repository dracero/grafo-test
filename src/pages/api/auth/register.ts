import type { APIRoute } from 'astro';
import { getUserByEmail, createUser, hasAnyUser } from '../../../lib/mongodb';
import { hashPassword } from '../../../lib/auth';

export const POST: APIRoute = async ({ request }) => {
  try {
    const { email, name, password } = await request.json();
    if (!email || !name || !password) {
      return new Response(JSON.stringify({ success: false, error: 'Campos requeridos vacíos' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const existing = await getUserByEmail(email);
    if (existing) {
      return new Response(JSON.stringify({ success: false, error: 'El correo electrónico ya está registrado' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const hasUsers = await hasAnyUser();
    const role = hasUsers ? 'pending' : 'admin';
    const isActive = !hasUsers;
    const passwordHash = hashPassword(password);

    await createUser({
      email,
      name,
      provider: 'local',
      passwordHash,
      role,
      isActive
    });

    return new Response(JSON.stringify({ success: true, role, isActive }), {
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
