import { json } from "./http";

export function checkBearer(req: Request, token: string | undefined): Response | null {
  if (!token) return null; // No token configured — fall through to CSRF-only protection
  const header = req.headers.get("Authorization");
  if (header !== `Bearer ${token}`) return json({ ok: false, error: "Unauthorized" }, 401);
  return null;
}
