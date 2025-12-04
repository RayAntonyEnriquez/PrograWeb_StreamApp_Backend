import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { db } from "../db";
import { broadcastStreamEvent } from "../sse";

const router = Router();

const alignSequence = async (
  client: Awaited<ReturnType<typeof db.getClient>>,
  table: string,
  column: string = "id"
) => {
  await client.query(
    `SELECT setval(pg_get_serial_sequence($1, $2),
                   GREATEST(
                     1,
                     (SELECT COALESCE(MAX(${column}),1) FROM ${table}),
                     (SELECT last_value FROM pg_get_serial_sequence($1, $2))
                   ),
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

const generateAlphaNumToken = (length = 12) => {
  const buf = crypto.randomBytes(length);
  return buf
    .toString("base64")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, length);
};

const buildVdoLinks = (streamId: number, token: string) => {
  const base = (process.env.VDO_NINJA_BASE || "https://vdo.ninja").replace(/\/+$/, "");
  const room = `stream${streamId}`; // alfanumerico: sin guiones
  return {
    room,
    streamer: {
      // Link del emisor (usa push + room). Ej: https://vdo.ninja/?push=TOKEN&room=stream123
      push: `${base}/?push=${token}&room=${room}`,
      // Link simple a la sala por si se quiere entrar sin push token
      room: `${base}/?room=${room}`,
    },
    viewer: {
      // Escena que auto-carga todas las fuentes de la sala. Ej: https://vdo.ninja/?scene&room=stream123
      scene: `${base}/?scene&room=${room}`,
    },
  };
};

// GET /api/streams
// Feed básico para el home: lista de streams con título y slug del canal.
router.get("/streams", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows } = await db.query(
      `SELECT s.id,
              s.titulo,
              s.estado,
              s.streamer_id,
              ps.titulo_canal,
              ps.canal_slug
       FROM streams s
       LEFT JOIN perfiles_streamer ps ON ps.id = s.streamer_id
       WHERE s.estado = 'en_vivo'
       ORDER BY s.id DESC
       LIMIT 20`
    );
    const mapped = rows.map((r) => ({
      id: r.id,
      titulo: r.titulo || `Stream ${r.id}`,
      streamer: r.canal_slug || `streamer-${r.streamer_id}`,
      streamerId: r.streamer_id,
      viewers: 0,
      imagen: null,
    }));
    res.json(mapped);
  } catch (err) {
    next(err);
  }
});

// GET /api/streams/:streamId
// Devuelve datos básicos del stream (incluye streamer_id) para vistas que necesiten derivar room/streamer.
router.get("/streams/:streamId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const streamId = Number(req.params.streamId);
    if (Number.isNaN(streamId)) return res.status(400).json({ message: "streamId invalido" });

    const { rows } = await db.query(
      `SELECT s.id,
              s.titulo,
              s.estado,
              s.streamer_id,
              ps.titulo_canal,
              ps.canal_slug
       FROM streams s
       LEFT JOIN perfiles_streamer ps ON ps.id = s.streamer_id
       WHERE s.id = $1`,
      [streamId]
    );
    if (!rows.length) return res.status(404).json({ message: "stream no encontrado" });
    const r = rows[0];
    return res.json({
      id: r.id,
      titulo: r.titulo,
      estado: r.estado,
      streamerId: r.streamer_id,
      canal_slug: r.canal_slug,
      room: `stream${r.id}`,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/streams/:streamId/vdo-link
// Genera un token efAmero para VDO Ninja y devuelve links push/view/room.
router.post(
  "/streams/:streamId/vdo-link",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const streamId = Number(req.params.streamId);
      const { streamerId } = req.body || {};
      if (Number.isNaN(streamId)) return res.status(400).json({ message: "streamId invalido" });
      if (Number.isNaN(Number(streamerId)))
        return res.status(400).json({ message: "streamerId invalido" });

      const streamRes = await db.query(
        `SELECT id, streamer_id
         FROM streams
         WHERE id = $1`,
        [streamId]
      );
      if (!streamRes.rowCount) return res.status(404).json({ message: "stream no encontrado" });
      if (streamRes.rows[0].streamer_id !== Number(streamerId))
        return res.status(400).json({ message: "stream no pertenece a streamer" });

      const token = generateAlphaNumToken(12);
      const links = buildVdoLinks(streamId, token);

      return res.status(201).json({
        streamId,
        streamerId: Number(streamerId),
        token,
        links,
      });
    } catch (err) {
      next(err);
    }
  }
);

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
        return res.json({
          sessionId: s.id,
          streamId,
          inicio: s.inicio,
          estado_stream: stream.estado,
          mensaje: "sesion ya abierta",
        });
      }

      await alignSequence(client, "sesiones_stream");
      const inicioDate = parseDateOrNow(startedAt);

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

      const perfilRes = await client.query(
        `UPDATE perfiles_streamer
         SET horas_totales = horas_totales + $1,
             ultimo_stream_en = $2
         WHERE id = $3
         RETURNING horas_totales, nivel_actual`,
        [Number(closeRes.rows[0].duracion_horas), finSafe, stream.streamer_id]
      );

      const horasTotales = Number(perfilRes.rows[0].horas_totales);
      let nivelActual = Number(perfilRes.rows[0].nivel_actual);
      let leveledUp = false;

      const nivelRes = await client.query(
        `SELECT nivel
         FROM reglas_nivel_streamer
         WHERE activo = TRUE
           AND streamer_id = $1
           AND horas_requeridas <= $2
           AND nivel > $3
         ORDER BY nivel DESC
         LIMIT 1`,
        [stream.streamer_id, horasTotales, nivelActual]
      );

      if (nivelRes.rowCount) {
        nivelActual = Number(nivelRes.rows[0].nivel);
        await client.query(
          `UPDATE perfiles_streamer SET nivel_actual = $1 WHERE id = $2`,
          [nivelActual, stream.streamer_id]
        );
        leveledUp = true;
      }

      await client.query("COMMIT");

      if (leveledUp) {
        broadcastStreamEvent(streamId, "streamer_level_up", {
          streamerId: stream.streamer_id,
          nivel_actual: nivelActual,
          horas_totales: horasTotales,
        });
      }

      return res.json({
        sessionId: session.id,
        streamId,
        inicio: closeRes.rows[0].inicio,
        fin: closeRes.rows[0].fin,
        duracion_horas: Number(closeRes.rows[0].duracion_horas),
        estado_stream: "finalizado",
        leveled_up: leveledUp,
        nivel_actual: nivelActual,
        horas_totales: horasTotales,
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

      // Sumar horas de la última sesión abierta (fin IS NULL) para reflejar progreso en vivo,
      // sin depender del estado de la tabla streams (por si no se actualizó).
      let horasVivas = 0;
      const openSession = await db.query(
        `SELECT ss.inicio
         FROM sesiones_stream ss
         JOIN streams s ON s.id = ss.stream_id
         WHERE s.streamer_id = $1
           AND ss.fin IS NULL
         ORDER BY ss.inicio DESC
         LIMIT 1`,
        [streamerId]
      );
      if (openSession.rowCount) {
        const inicio = openSession.rows[0].inicio;
        horasVivas = Math.max((Date.now() - new Date(inicio).getTime()) / 3600000, 0);
      }

      const nextLevelRes = await db.query(
        `SELECT nivel, horas_requeridas
         FROM reglas_nivel_streamer
         WHERE activo = TRUE AND streamer_id = $1 AND nivel > $2
         ORDER BY nivel ASC
         LIMIT 1`,
        [streamerId, perfil.nivel_actual]
      );

      const fallbackRules = [
        { nivel: 2, horas: 5 },
        { nivel: 3, horas: 20 },
        { nivel: 4, horas: 60 },
        { nivel: 5, horas: 160 },
      ];

      if (!nextLevelRes.rowCount) {
        const horasTotales = Number(perfil.horas_totales);
        const fallbackTarget = fallbackRules.find((r) => r.horas > horasTotales);
        if (!fallbackTarget) {
          return res.json({
            streamerId: perfil.id,
            nivel_actual: perfil.nivel_actual,
            horas_totales: horasTotales,
            es_nivel_maximo: true,
            siguiente_nivel: null,
            horas_requeridas: null,
            falta_horas: 0,
            progreso_porcentaje: 100,
          });
        }

        const falta = Math.max(fallbackTarget.horas - horasTotales, 0);
        const progresoPct = Math.min(
          100,
          Number(((horasTotales / fallbackTarget.horas) * 100).toFixed(2))
        );

        return res.json({
          streamerId: perfil.id,
          nivel_actual: perfil.nivel_actual,
          horas_totales: horasTotales,
          es_nivel_maximo: false,
          siguiente_nivel: fallbackTarget.nivel,
          horas_requeridas: fallbackTarget.horas,
          falta_horas: falta,
          progreso_porcentaje: progresoPct,
        });
      }

      const nextLevel = nextLevelRes.rows[0];
      const horasReq = Number(nextLevel.horas_requeridas);
      const horasTotales = Number(perfil.horas_totales) + horasVivas;
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

export default router;
