import { Router, Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt, { SignOptions, Secret } from "jsonwebtoken";
import type { StringValue } from "ms";
import crypto from "crypto";
import { db } from "../db";

const router = Router();

const ACCESS_TOKEN_EXPIRES_IN: StringValue | number =
  (process.env.ACCESS_TOKEN_EXPIRES_IN as StringValue) || "15m";
const REFRESH_TOKEN_DAYS = Number(process.env.REFRESH_TOKEN_DAYS || 30);

const normalizeEmail = (email: string) => email.trim().toLowerCase();
const slugify = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

const requireJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET no configurado");
  }
  return secret;
};

const hashRefresh = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

const signAccessToken = (userId: number, rol: string) => {
  const secret: Secret = requireJwtSecret();
  const options: SignOptions = { expiresIn: ACCESS_TOKEN_EXPIRES_IN };
  return jwt.sign({ sub: userId, rol }, secret, options);
};

// Alinea secuencia para evitar PK duplicadas cuando hay datos precargados.
const alignSequence = async (
  client: Awaited<ReturnType<typeof db.getClient>>,
  table: string,
  column: string = "id"
) => {
  // Si la tabla está vacía, setval a 1 para evitar out-of-bounds (valor mínimo de la secuencia)
  await client.query(
    `SELECT setval(
        pg_get_serial_sequence($1, $2),
        GREATEST((SELECT COALESCE(MAX(${column}),1) FROM ${table}), 1),
        true
      )`,
    [table, column]
  );
};

const createRefreshToken = async (
  client: Awaited<ReturnType<typeof db.getClient>>,
  usuarioId: number
) => {
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);

  // Reintenta si choca el hash único (extremadamente raro).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const raw = crypto.randomBytes(64).toString("hex");
    const tokenHash = hashRefresh(raw);
    try {
      await client.query(
        `INSERT INTO refresh_tokens (usuario_id, token_hash, expires_at, revocado, revocado_en)
         VALUES ($1, $2, $3, FALSE, NULL)`,
        [usuarioId, tokenHash, expiresAt]
      );
      return { refreshToken: raw, expiresAt };
    } catch (err: any) {
      if (err.code === "23505") continue;
      throw err;
    }
  }
};

const buildUsuarioPayload = (row: any) => ({
  id: row.id,
  nombre: row.nombre,
  email: row.email,
  rol: row.rol,
});

// POST /api/auth/register
router.post("/register", async (req: Request, res: Response, next: NextFunction) => {
  const { nombre, email, password, rol, canal_slug, titulo_canal } = req.body || {};
  const rolNormalized = typeof rol === "string" ? rol.toLowerCase() : "";

  if (!nombre || typeof nombre !== "string" || !nombre.trim())
    return res.status(400).json({ message: "nombre requerido" });
  if (!email || typeof email !== "string" || !email.trim())
    return res.status(400).json({ message: "email requerido" });
  if (!password || typeof password !== "string" || password.length < 8)
    return res.status(400).json({ message: "password minimo 8 caracteres" });
  if (!["streamer", "espectador"].includes(rolNormalized))
    return res.status(400).json({ message: "rol invalido" });

  const normalizedEmail = normalizeEmail(email);
  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const emailExists = await client.query(
      `SELECT 1 FROM usuarios WHERE email = $1`,
      [normalizedEmail]
    );
    if (emailExists.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "email ya existe" });
    }

    // Alinear secuencias que se usan en este flujo de alta
    await alignSequence(client, "usuarios");
    await alignSequence(client, "billeteras");
    await alignSequence(client, "perfiles_streamer");
    await alignSequence(client, "perfiles_viewer");

    const passwordHash = await bcrypt.hash(password, 10);
    const userRes = await client.query(
      `INSERT INTO usuarios (email, password_hash, nombre, rol)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, nombre, rol`,
      [normalizedEmail, passwordHash, nombre.trim(), rolNormalized]
    );
    const usuario = userRes.rows[0];

    const billeteraRes = await client.query(
      `INSERT INTO billeteras (usuario_id, saldo_coins)
       VALUES ($1, 0)
       RETURNING id`,
      [usuario.id]
    );

    let perfilId: number | null = null;
    let canalSlugResp: string | null = null;

    if (rolNormalized === "streamer") {
      const slugBase =
        typeof canal_slug === "string" && canal_slug.trim() ? canal_slug.trim() : nombre;
      let slug = slugify(slugBase);
      if (!slug) slug = `canal-${usuario.id}`;

      const slugExists = await client.query(
        `SELECT 1 FROM perfiles_streamer WHERE canal_slug = $1`,
        [slug]
      );
      if (slugExists.rowCount) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "canal_slug ya existe" });
      }

      const perfilStreamer = await client.query(
        `INSERT INTO perfiles_streamer (usuario_id, canal_slug, titulo_canal)
         VALUES ($1, $2, $3)
         RETURNING id, canal_slug`,
        [
          usuario.id,
          slug,
          typeof titulo_canal === "string" && titulo_canal.trim() ? titulo_canal.trim() : null,
        ]
      );
      perfilId = perfilStreamer.rows[0].id;
      canalSlugResp = perfilStreamer.rows[0].canal_slug;
    } else {
      const perfilViewer = await client.query(
        `INSERT INTO perfiles_viewer (usuario_id)
         VALUES ($1)
         RETURNING id`,
        [usuario.id]
      );
      perfilId = perfilViewer.rows[0].id;
    }

    await client.query("COMMIT");
    return res.status(201).json({
      usuarioId: usuario.id,
      rol: usuario.rol,
      perfilId,
      billeteraId: billeteraRes.rows[0].id,
      canal_slug: canalSlugResp,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/auth/login
router.post("/login", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body || {};
    if (!email || typeof email !== "string" || !email.trim())
      return res.status(400).json({ message: "email requerido" });
    if (!password || typeof password !== "string")
      return res.status(400).json({ message: "password requerido" });

    const normalizedEmail = normalizeEmail(email);
    const userRes = await db.query(
      `SELECT id, email, password_hash, nombre, rol, estado
       FROM usuarios
       WHERE email = $1`,
      [normalizedEmail]
    );
    if (!userRes.rowCount) return res.status(401).json({ message: "credenciales invalidas" });

    const user = userRes.rows[0];
    if (user.estado !== "activo")
      return res.status(403).json({ message: "usuario suspendido o inactivo" });

    const passwordOk = await bcrypt.compare(password, user.password_hash);
    if (!passwordOk) return res.status(401).json({ message: "credenciales invalidas" });

    const accessToken = signAccessToken(user.id, user.rol);
    const client = await db.getClient();
    try {
      await client.query("BEGIN");
      const { refreshToken, expiresAt } = await createRefreshToken(client, user.id);
      await client.query("COMMIT");
      return res.json({
        accessToken,
        refreshToken,
        refresh_expires_at: expiresAt.toISOString(),
        usuario: buildUsuarioPayload(user),
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/refresh
router.post("/refresh", async (req: Request, res: Response, next: NextFunction) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken || typeof refreshToken !== "string")
    return res.status(400).json({ message: "refreshToken requerido" });

  const tokenHash = hashRefresh(refreshToken);
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const tokenRes = await client.query(
      `SELECT id, usuario_id, expires_at, revocado
       FROM refresh_tokens
       WHERE token_hash = $1
       FOR UPDATE`,
      [tokenHash]
    );

    if (!tokenRes.rowCount) {
      await client.query("ROLLBACK");
      return res.status(401).json({ message: "refresh token invalido" });
    }

    const tokenRow = tokenRes.rows[0];
    const expired = new Date(tokenRow.expires_at).getTime() <= Date.now();
    if (tokenRow.revocado || expired) {
      await client.query(
        `UPDATE refresh_tokens SET revocado = TRUE, revocado_en = NOW() WHERE id = $1`,
        [tokenRow.id]
      );
      await client.query("COMMIT");
      return res.status(401).json({ message: "refresh token expirado o revocado" });
    }

    const userRes = await client.query(
      `SELECT id, email, nombre, rol, estado
       FROM usuarios
       WHERE id = $1`,
      [tokenRow.usuario_id]
    );
    if (!userRes.rowCount) {
      await client.query("ROLLBACK");
      return res.status(401).json({ message: "usuario no encontrado" });
    }
    const user = userRes.rows[0];
    if (user.estado !== "activo") {
      await client.query("ROLLBACK");
      return res.status(403).json({ message: "usuario suspendido o inactivo" });
    }

    await client.query(
      `UPDATE refresh_tokens SET revocado = TRUE, revocado_en = NOW() WHERE id = $1`,
      [tokenRow.id]
    );

    const { refreshToken: newRefresh, expiresAt } = await createRefreshToken(client, user.id);
    const accessToken = signAccessToken(user.id, user.rol);

    await client.query("COMMIT");
    return res.json({
      accessToken,
      refreshToken: newRefresh,
      refresh_expires_at: expiresAt.toISOString(),
      usuario: buildUsuarioPayload(user),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/auth/logout
router.post("/logout", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken || typeof refreshToken !== "string")
      return res.status(400).json({ message: "refreshToken requerido" });
    const tokenHash = hashRefresh(refreshToken);
    await db.query(
      `UPDATE refresh_tokens
       SET revocado = TRUE, revocado_en = NOW()
       WHERE token_hash = $1`,
      [tokenHash]
    );
    return res.status(200).json({ message: "logout ok" });
  } catch (err) {
    next(err);
  }
});

export default router;
