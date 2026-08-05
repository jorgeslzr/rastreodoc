import { createClient } from "@supabase/supabase-js";

const USER_DOMAIN = "usuarios.rastreadoc.mx";
const ALLOWED_ROLES = ["admin", "supervisor", "empleado", "consulta"];

function normalizeUsername(username) {
  return username.trim().toLocaleLowerCase("es-MX").replace(/\s+/g, "_");
}

function usernameToEmail(username) {
  return `${normalizeUsername(username)}@${USER_DOMAIN}`;
}

export async function POST(request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return Response.json({ error: "Falta configurar SUPABASE_SERVICE_ROLE_KEY en Vercel." }, { status: 500 });
  }

  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return Response.json({ error: "Sesión requerida." }, { status: 401 });

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: requesterData, error: requesterError } = await adminClient.auth.getUser(token);
  if (requesterError || !requesterData.user) {
    return Response.json({ error: "Sesión inválida." }, { status: 401 });
  }

  const { data: requesterProfile } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", requesterData.user.id)
    .maybeSingle();
  const requesterRole = requesterProfile?.role ?? "admin";
  if (!["admin", "supervisor"].includes(requesterRole)) {
    return Response.json({ error: "No tienes permiso para crear usuarios." }, { status: 403 });
  }

  const body = await request.json();
  const username = normalizeUsername(body.username ?? "");
  const password = String(body.password ?? "");
  const role = body.role ?? "consulta";

  if (!username || username.length < 3) {
    return Response.json({ error: "El usuario debe tener al menos 3 caracteres." }, { status: 400 });
  }
  if (password.length < 6) {
    return Response.json({ error: "La contraseña debe tener al menos 6 caracteres." }, { status: 400 });
  }
  if (!ALLOWED_ROLES.includes(role)) {
    return Response.json({ error: "Perfil no válido." }, { status: 400 });
  }

  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email: usernameToEmail(username),
    password,
    email_confirm: true,
    user_metadata: { username },
  });

  if (createError) {
    const errorMessage = createError.message.toLocaleLowerCase("es-MX").includes("already")
      || createError.message.toLocaleLowerCase("es-MX").includes("registered")
      ? "Ese usuario ya existe."
      : `No fue posible crear el usuario: ${createError.message}`;
    return Response.json({ error: errorMessage }, { status: 400 });
  }

  const { error: profileError } = await adminClient.from("profiles").upsert({
    id: created.user.id,
    username,
    role,
  });

  if (profileError) {
    return Response.json({ error: `El usuario se creó, pero no se pudo guardar su perfil: ${profileError.message}` }, { status: 500 });
  }

  return Response.json({ user: { id: created.user.id, username, role } });
}
