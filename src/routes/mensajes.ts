import { Router, Request, Response, NextFunction } from "express";
import { db } from "../db";
import { broadcastStreamEvent } from "../sse";

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

    const checkLevelUp = async (viewerId: number, puntosTotales: number, nivelActual: number) => {
      const rule = await client.query(
        `SELECT nivel
         FROM reglas_nivel_viewer
         WHERE activo = TRUE AND puntos_requeridos <= $1
         ORDER BY nivel DESC
         LIMIT 1`,
        [puntosTotales]
      );
      if (!rule.rowCount) return { leveledUp: false, nuevoNivel: nivelActual };
      const nuevoNivel = Number(rule.rows[0].nivel);
      if (nuevoNivel > nivelActual) {
        await client.query(
          `UPDATE perfiles_viewer SET nivel_actual = $1 WHERE id = $2`,
          [nuevoNivel, viewerId]
        );
        return { leveledUp: true, nuevoNivel };
      }
      return { leveledUp: false, nuevoNivel: nivelActual };
    };

    let viewerRow = null as any;
    const viewerRes = await client.query(
      `SELECT pv.id, pv.usuario_id, pv.nivel_actual, pv.puntos
       FROM perfiles_viewer pv
       WHERE pv.id = $1`,
      [Number(viewerId)]
    );
    if (viewerRes.rowCount) {
      viewerRow = viewerRes.rows[0];
    } else {
      // Si llega un perfil de streamer, intenta reutilizar/crear perfil viewer para ese usuario.
      const fallbackStreamer = await client.query(
        `SELECT usuario_id FROM perfiles_streamer WHERE id = $1`,
        [Number(viewerId)]
      );
      if (fallbackStreamer.rowCount) {
        const usuarioId = Number(fallbackStreamer.rows[0].usuario_id);
        const existingViewer = await client.query(
          `SELECT id, usuario_id, nivel_actual, puntos FROM perfiles_viewer WHERE usuario_id = $1`,
          [usuarioId]
        );
        if (existingViewer.rowCount) {
          viewerRow = existingViewer.rows[0];
        } else {
          // Alinear secuencia y crear perfil viewer nuevo
          await client.query(
            `SELECT setval(
               pg_get_serial_sequence('perfiles_viewer','id'),
               GREATEST(
                 1,
                 (SELECT COALESCE(MAX(id),1) FROM perfiles_viewer),
                 (SELECT last_value FROM perfiles_viewer_id_seq)
               ),
               true
             )`
          );
          const inserted = await client.query(
            `INSERT INTO perfiles_viewer (usuario_id)
             VALUES ($1)
             RETURNING id, usuario_id, nivel_actual, puntos`,
            [usuarioId]
          );
          viewerRow = inserted.rows[0];
        }
      }
    }
    if (!viewerRow) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "viewer no encontrado" });
    }
    const viewer = viewerRow;

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
            1,
            (SELECT COALESCE(MAX(id),1) FROM mensajes_chat),
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

    const puntosTotales = Number(puntosRes.rows[0].puntos);
    const levelResult = await checkLevelUp(viewer.id, puntosTotales, viewer.nivel_actual);

    const msgRes = await client.query(
      `INSERT INTO mensajes_chat (stream_id, usuario_id, tipo, mensaje, badge, nivel_usuario, creado_en)
       VALUES ($1, $2, 'texto', $3, 'none', $4, NOW())
       RETURNING id, creado_en`,
      [streamId, viewer.usuario_id, mensaje.trim(), levelResult.nuevoNivel]
    );

    await client.query("COMMIT");

    const responseBody = {
      mensajeId: msgRes.rows[0].id,
      streamId,
      viewerId: viewer.id,
      puntos_totales: puntosTotales,
      leveled_up: levelResult.leveledUp,
      nivel_actual: levelResult.nuevoNivel,
      creado_en: msgRes.rows[0].creado_en,
    };

    // Emitir en tiempo real al chat del stream
    broadcastStreamEvent(streamId, "chat_message", {
      ...responseBody,
      usuario_id: viewer.usuario_id,
      mensaje: mensaje.trim(),
    });

    // Si subió de nivel, emitir evento dedicado (útil para toasts)
    if (levelResult.leveledUp) {
      broadcastStreamEvent(streamId, "viewer_level_up", {
        viewerId: viewer.id,
        usuario_id: viewer.usuario_id,
        nivel_actual: levelResult.nuevoNivel,
        puntos_totales: puntosTotales,
      });
    }

    return res.status(201).json(responseBody);
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
