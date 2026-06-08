import type { APIRoute } from 'astro';
import { listUsers, updateUser, deleteUser } from '../../../lib/mongodb';

export const GET: APIRoute = async (context) => {
  const currentUser = context.locals.user;
  if (!currentUser || currentUser.role !== 'admin') {
    return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const users = await listUsers();
    return new Response(JSON.stringify({ success: true, users }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const PUT: APIRoute = async (context) => {
  const currentUser = context.locals.user;
  if (!currentUser || currentUser.role !== 'admin') {
    return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { email, role, isActive } = await context.request.json();
    if (!email) {
      return new Response(JSON.stringify({ success: false, error: 'Falta email de usuario' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const updates: any = {};
    if (role !== undefined) updates.role = role;
    if (isActive !== undefined) updates.isActive = isActive;

    await updateUser(email, updates);
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

export const DELETE: APIRoute = async (context) => {
  const currentUser = context.locals.user;
  if (!currentUser || currentUser.role !== 'admin') {
    return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const url = new URL(context.request.url);
    const email = url.searchParams.get('email');
    if (!email) {
      return new Response(JSON.stringify({ success: false, error: 'Falta email de usuario' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (email.toLowerCase() === currentUser.email.toLowerCase()) {
      return new Response(JSON.stringify({ success: false, error: 'No puede eliminarse a sí mismo' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const success = await deleteUser(email);
    return new Response(JSON.stringify({ success }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
