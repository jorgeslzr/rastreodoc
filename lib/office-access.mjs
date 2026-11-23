const OFFICE_ROLES = new Set(["admin", "supervisor", "empleado", "consulta"]);

export class OfficeAccessError extends Error {
  constructor() {
    super("Tu cuenta no tiene un perfil autorizado. Solicita al administrador de la oficina que revise tu acceso.");
    this.name = "OfficeAccessError";
  }
}

export function requireOfficeProfile(profile, userId) {
  if (!userId || profile?.id !== userId || !OFFICE_ROLES.has(profile.role)) {
    throw new OfficeAccessError();
  }
  return profile;
}

// The factory is server-only. Never create a privileged client until the
// request contains a bearer token; never infer privileges from Auth metadata.
export async function authorizeUserAdministration(request, createAdminClient) {
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const deny = (status, error) => ({ response: Response.json({ error }, { status }) });
  if (!token) return deny(401, "Sesión requerida.");
  try {
    const adminClient = createAdminClient();
    const { data, error } = await adminClient.auth.getUser(token);
    if (error || !data?.user?.id) return deny(401, "Sesión inválida.");
    const { data: profile, error: profileError } = await adminClient.from("profiles")
      .select("id, role").eq("id", data.user.id).maybeSingle();
    if (profileError) return deny(503, "No fue posible validar tus permisos. Intenta de nuevo.");
    requireOfficeProfile(profile, data.user.id);
    if (!["admin", "supervisor"].includes(profile.role)) throw new OfficeAccessError();
    return { adminClient, requesterId: data.user.id };
  } catch (error) {
    return error instanceof OfficeAccessError
      ? deny(403, "No tienes permiso para administrar usuarios.")
      : deny(503, "No fue posible validar tus permisos. Intenta de nuevo.");
  }
}
