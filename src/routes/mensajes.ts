import { Router, Request, Response, NextFunction } from "express";
import { db } from "../db";

const router = Router();

// POST /api/streams/:streamId/mensajes
// Crea mensaje de chat de un espectador y suma +1 punto por participacion.
router.post("/streams/:streamId/mensajes", async (req: Request, res: Response, next: NextFunction) => {
  const streamId = Number(req.params.streamId);
  const { viewerId, mensaje } = req.body || {};

  if (Number.isNaN(streamId)) return res.status(400).json({ message: "streamId invalido" });
  if (Number.isNaN(Number(viewerId))) return res.status(400).json({ message: "viewerId invalido" });
  if (!mensaje || typeof mensaje !== "string" || !mensaje.trim()) return res.status(400).json({ message: "mensaje requerido" });

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const viewerRes = await client.query(
      `SELECT pv.id, pv.usuario_id, pv.nivel_actual, pv.puntos
       FROM perfiles_viewer pv
       WHERE pv.id = $1`,
      [Number(viewerId)]
    );
    if (!viewerRes.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "viewer no encontrado" });
    }
    const viewer = viewerRes.rows[0];

    const streamRes = await client.query(`SELECT id FROM streams WHERE id = $1`, [streamId]);
    if (!streamRes.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "stream no encontrado" });
    }

    // Alinear secuencia para evitar PK duplicada en mensajes_chat
    await client.query(
      `SELECT setval(
          pg_get_serial_sequence('mensajes_chat','id'),
          GREATEST(
            (SELECT COALESCE(MAX(id),0) FROM mensajes_chat),
            (SELECT last_value FROM mensajes_chat_id_seq)
          ),
          true
        )`
    );

    const puntosRes = await client.query(
      `UPDATE perfiles_viewer
       SET puntos = puntos + 1
       WHERE id = $1
       RETURNING puntos`,
      [viewer.id]
    );

    const msgRes = await client.query(
      `INSERT INTO mensajes_chat (stream_id, usuario_id, tipo, mensaje, badge, nivel_usuario, creado_en)
       VALUES ($1, $2, 'texto', $3, 'none', $4, NOW())
       RETURNING id, creado_en`,
      [streamId, viewer.usuario_id, mensaje.trim(), viewer.nivel_actual]
    );

    await client.query("COMMIT");
    return res.status(201).json({
      mensajeId: msgRes.rows[0].id,
      streamId,
      viewerId: viewer.id,
      puntos_totales: Number(puntosRes.rows[0].puntos),
      creado_en: msgRes.rows[0].creado_en,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/streams/:streamId/mensajes
// Devuelve mensajes del chat incluyendo nivel y nombre del usuario.
router.get("/streams/:streamId/mensajes", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const streamId = Number(req.params.streamId);
    if (Number.isNaN(streamId)) return res.status(400).json({ message: "streamId invalido" });

    const { rows } = await db.query(
      `SELECT mc.id,
              mc.stream_id,
              mc.usuario_id,
              u.nombre AS usuario_nombre,
              u.avatar_url,
              mc.tipo,
              mc.mensaje,
              mc.badge,
              mc.nivel_usuario,
              mc.gift_id,
              mc.envio_regalo_id,
              mc.creado_en
       FROM mensajes_chat mc
       JOIN usuarios u ON u.id = mc.usuario_id
       WHERE mc.stream_id = $1
       ORDER BY mc.creado_en ASC, mc.id ASC`,
      [streamId]
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

export default router;
