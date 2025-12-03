import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { db } from "../db";

const router = Router();

const alignSequence = async (
  client: Awaited<ReturnType<typeof db.getClient>>,
  table: string,
  column: string = "id"
) => {
  await client.query(
    `SELECT setval(pg_get_serial_sequence($1, $2),
                   (SELECT COALESCE(MAX(${column}),0) FROM ${table}),
                   true)`,
    [table, column]
  );
};

const parseDateOrNow = (value?: unknown) => {
  if (typeof value === "string") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
};

const buildVdoLinks = (key: string) => ({
  pushUrl: `https://vdo.ninja/?push=${key}&webcam&quality=0&proaudio`,
  viewUrl: `https://vdo.ninja/?view=${key}&cleanoutput`,
});

// POST /api/streams/:streamId/start
// Marca inicio de una sesion RTMP; idempotente si ya existe una sesion abierta.
router.post(
  "/streams/:streamId/start",
  async (req: Request, res: Response, next: NextFunction) => {
    const streamId = Number(req.params.streamId);
    const { streamerId, startedAt } = req.body || {};
    if (Number.isNaN(streamId)) return res.status(400).json({ message: "streamId invalido" });
    if (Number.isNaN(Number(streamerId)))
      return res.status(400).json({ message: "streamerId invalido" });

    const client = await db.getClient();
    try {
      await client.query("BEGIN");

      const streamRes = await client.query(
        `SELECT id, streamer_id, estado, inicio_en, fin_en
         FROM streams
         WHERE id = $1
         FOR UPDATE`,
        [streamId]
      );
      if (!streamRes.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "stream no encontrado" });
      }
      const stream = streamRes.rows[0];
      if (stream.streamer_id !== Number(streamerId)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "stream no pertenece a streamer" });
      }

      const openSession = await client.query(
        `SELECT id, inicio
         FROM sesiones_stream
         WHERE stream_id = $1 AND fin IS NULL
         ORDER BY inicio DESC
         LIMIT 1`,
        [streamId]
      );
      if (openSession.rowCount) {
        await client.query("COMMIT");
        const s = openSession.rows[0];
        const vdoRes = await client.query(
          `SELECT vdo_stream_key, vdo_push_url, vdo_view_url FROM streams WHERE id = $1`,
          [streamId]
        );
        const vdo = vdoRes.rows[0];
        return res.json({
          sessionId: s.id,
          streamId,
          inicio: s.inicio,
          estado_stream: stream.estado,
          mensaje: "sesion ya abierta",
          vdo_stream_key: vdo?.vdo_stream_key ?? null,
          vdo_push_url: vdo?.vdo_push_url ?? null,
          vdo_view_url: vdo?.vdo_view_url ?? null,
        });
      }

      await alignSequence(client, "sesiones_stream");
      const inicioDate = parseDateOrNow(startedAt);

      const streamKey = stream.vdo_stream_key || crypto.randomBytes(6).toString("hex");
      const { pushUrl, viewUrl } = buildVdoLinks(streamKey);

      await client.query(
        `UPDATE streams
         SET vdo_stream_key = $1,
             vdo_push_url = $2,
             vdo_view_url = $3
         WHERE id = $4`,
        [streamKey, pushUrl, viewUrl, streamId]
      );

      const sessionRes = await client.query(
        `INSERT INTO sesiones_stream (stream_id, inicio)
         VALUES ($1, $2)
         RETURNING id, inicio`,
        [streamId, inicioDate]
      );

      await client.query(
        `UPDATE streams
         SET estado = 'en_vivo',
             inicio_en = COALESCE(inicio_en, $1)
         WHERE id = $2`,
        [inicioDate, streamId]
      );

      await client.query("COMMIT");
      return res.status(201).json({
        sessionId: sessionRes.rows[0].id,
        streamId,
        inicio: sessionRes.rows[0].inicio,
        estado_stream: "en_vivo",
        vdo_stream_key: streamKey,
        vdo_push_url: pushUrl,
        vdo_view_url: viewUrl,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      next(err);
    } finally {
      client.release();
    }
  }
);

// POST /api/streams/:streamId/stop
// Cierra la sesion abierta, calcula duracion y actualiza horas_totales del streamer.
router.post(
  "/streams/:streamId/stop",
  async (req: Request, res: Response, next: NextFunction) => {
    const streamId = Number(req.params.streamId);
    const { streamerId, endedAt } = req.body || {};
    if (Number.isNaN(streamId)) return res.status(400).json({ message: "streamId invalido" });
    if (Number.isNaN(Number(streamerId)))
      return res.status(400).json({ message: "streamerId invalido" });

    const client = await db.getClient();
    try {
      await client.query("BEGIN");

      const streamRes = await client.query(
        `SELECT id, streamer_id, estado, inicio_en
         FROM streams
         WHERE id = $1
         FOR UPDATE`,
        [streamId]
      );
      if (!streamRes.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "stream no encontrado" });
      }
      const stream = streamRes.rows[0];
      if (stream.streamer_id !== Number(streamerId)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "stream no pertenece a streamer" });
      }

      const sessionRes = await client.query(
        `SELECT id, inicio
         FROM sesiones_stream
         WHERE stream_id = $1 AND fin IS NULL
         ORDER BY inicio DESC
         LIMIT 1
         FOR UPDATE`,
        [streamId]
      );
      if (!sessionRes.rowCount) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "no hay sesion abierta para cerrar" });
      }
      const session = sessionRes.rows[0];
      const finDate = parseDateOrNow(endedAt);
      const finSafe = finDate.getTime() < new Date(session.inicio).getTime() ? new Date(session.inicio) : finDate;

      const closeRes = await client.query(
        `UPDATE sesiones_stream
         SET fin = $1,
             duracion_horas = GREATEST(EXTRACT(EPOCH FROM ($1 - inicio)) / 3600, 0)
         WHERE id = $2
         RETURNING duracion_horas, inicio, fin`,
        [finSafe, session.id]
      );

      await client.query(
        `UPDATE streams
         SET estado = 'finalizado',
             fin_en = $1
         WHERE id = $2`,
        [finSafe, streamId]
      );

      await client.query(
        `UPDATE perfiles_streamer
         SET horas_totales = horas_totales + $1,
             ultimo_stream_en = $2
         WHERE id = $3`,
        [Number(closeRes.rows[0].duracion_horas), finSafe, stream.streamer_id]
      );

      await client.query("COMMIT");
      return res.json({
        sessionId: session.id,
        streamId,
        inicio: closeRes.rows[0].inicio,
        fin: closeRes.rows[0].fin,
        duracion_horas: Number(closeRes.rows[0].duracion_horas),
        estado_stream: "finalizado",
      });
    } catch (err) {
      await client.query("ROLLBACK");
      next(err);
    } finally {
      client.release();
    }
  }
);

// GET /api/streamers/:streamerId/progreso-nivel
// Devuelve horas totales y lo que falta para el siguiente nivel del streamer.
router.get(
  "/streamers/:streamerId/progreso-nivel",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const streamerId = Number(req.params.streamerId);
      if (Number.isNaN(streamerId)) return res.status(400).json({ message: "streamerId invalido" });

      const perfilRes = await db.query(
        `SELECT id, nivel_actual, horas_totales
         FROM perfiles_streamer
         WHERE id = $1`,
        [streamerId]
      );
      if (!perfilRes.rowCount) return res.status(404).json({ message: "streamer no encontrado" });
      const perfil = perfilRes.rows[0];

      const nextLevelRes = await db.query(
        `SELECT nivel, horas_requeridas
         FROM reglas_nivel_streamer
         WHERE activo = TRUE AND streamer_id = $1 AND nivel > $2
         ORDER BY nivel ASC
         LIMIT 1`,
        [streamerId, perfil.nivel_actual]
      );

      if (!nextLevelRes.rowCount) {
        return res.json({
          streamerId: perfil.id,
          nivel_actual: perfil.nivel_actual,
          horas_totales: Number(perfil.horas_totales),
          es_nivel_maximo: true,
          siguiente_nivel: null,
          horas_requeridas: null,
          falta_horas: 0,
          progreso_porcentaje: 100,
        });
      }

      const nextLevel = nextLevelRes.rows[0];
      const horasReq = Number(nextLevel.horas_requeridas);
      const horasTotales = Number(perfil.horas_totales);
      const falta = Math.max(horasReq - horasTotales, 0);
      const progresoPct = Math.min(100, Number(((horasTotales / horasReq) * 100).toFixed(2)));

      return res.json({
        streamerId: perfil.id,
        nivel_actual: perfil.nivel_actual,
        horas_totales: horasTotales,
        es_nivel_maximo: false,
        siguiente_nivel: nextLevel.nivel,
        horas_requeridas: horasReq,
        falta_horas: falta,
        progreso_porcentaje: progresoPct,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/streams/en-vivo
// Lista streams en estado 'en_vivo' con datos bA!sicos para el feed.
router.get("/streams/en-vivo", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows } = await db.query(
      `SELECT s.id,
              s.streamer_id,
              s.titulo,
              s.estado,
              s.inicio_en,
              s.vdo_view_url,
              s.vdo_push_url,
              u.nombre AS streamer_nombre,
              u.avatar_url
       FROM streams s
       JOIN perfiles_streamer ps ON ps.id = s.streamer_id
       JOIN usuarios u ON u.id = ps.usuario_id
       WHERE s.estado = 'en_vivo'
       ORDER BY s.inicio_en DESC NULLS LAST, s.id DESC
       LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/streams/:streamId
// Devuelve datos base del stream (urls VDO, estado, titulo).
router.get("/streams/:streamId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const streamId = Number(req.params.streamId);
    if (Number.isNaN(streamId)) return res.status(400).json({ message: "streamId invalido" });

    const { rows } = await db.query(
      `SELECT s.id,
              s.streamer_id,
              s.titulo,
              s.estado,
              s.inicio_en,
              s.fin_en,
              s.vdo_view_url,
              s.vdo_push_url,
              u.nombre AS streamer_nombre,
              u.avatar_url
       FROM streams s
       JOIN perfiles_streamer ps ON ps.id = s.streamer_id
       JOIN usuarios u ON u.id = ps.usuario_id
       WHERE s.id = $1`,
      [streamId]
    );
    if (!rows.length) return res.status(404).json({ message: "stream no encontrado" });
    return res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;
