import { Router, Request, Response, NextFunction } from "express";
import { db } from "../db";
import { broadcastStreamEvent } from "../sse";

const router = Router();

// GET /api/streamers/:streamerId/regalos
router.get("/streamers/:streamerId/regalos", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const streamerId = Number(req.params.streamerId);
    if (Number.isNaN(streamerId)) return res.status(400).json({ message: "streamerId invalido" });

    const { rows } = await db.query(
      `SELECT id, nombre, costo_usd, costo_coins, puntos_otorgados
       FROM regalos
       WHERE activo = TRUE AND (streamer_id = $1 OR streamer_id IS NULL)
       ORDER BY costo_coins ASC, id ASC`,
      [streamerId]
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/regalos (lista global opcional)
router.get("/regalos", async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, streamer_id, nombre, costo_usd, costo_coins, puntos_otorgados
       FROM regalos
       WHERE activo = TRUE
       ORDER BY streamer_id NULLS FIRST, costo_coins ASC, id ASC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/streamers/:streamerId/regalos
// Crea un regalo nuevo para un streamer.
router.post(
  "/streamers/:streamerId/regalos",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const streamerId = Number(req.params.streamerId);
      const { nombre, costo_usd, costo_coins, puntos_otorgados, activo = true } = req.body || {};

      if (Number.isNaN(streamerId)) return res.status(400).json({ message: "streamerId invalido" });
      if (!nombre || typeof nombre !== "string" || !nombre.trim())
        return res.status(400).json({ message: "nombre requerido" });
      if (Number.isNaN(Number(costo_coins)) || Number(costo_coins) <= 0)
        return res.status(400).json({ message: "costo_coins debe ser numero > 0" });
      if (Number.isNaN(Number(puntos_otorgados)) || Number(puntos_otorgados) < 0)
        return res.status(400).json({ message: "puntos_otorgados debe ser numero >= 0" });

      const streamerRes = await db.query(
        `SELECT id FROM perfiles_streamer WHERE id = $1`,
        [streamerId]
      );
      if (!streamerRes.rowCount) return res.status(404).json({ message: "streamer no encontrado" });

      // Alinear secuencia para evitar PK duplicada si se precargaron IDs.
      await db.query(
        `SELECT setval(
           pg_get_serial_sequence('regalos','id'),
           GREATEST(
             1,
             (SELECT COALESCE(MAX(id),1) FROM regalos),
             (SELECT last_value FROM regalos_id_seq)
           ),
           true
         )`
      );

      const { rows } = await db.query(
        `INSERT INTO regalos (streamer_id, nombre, costo_usd, costo_coins, puntos_otorgados, activo)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, streamer_id, nombre, costo_usd, costo_coins, puntos_otorgados, activo`,
        [
          streamerId,
          nombre.trim(),
          costo_usd === undefined || costo_usd === null ? null : Number(costo_usd),
          Number(costo_coins),
          Number(puntos_otorgados),
          Boolean(activo),
        ]
      );

      return res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/streamers/:streamerId/regalos/:regaloId
// Edita un regalo existente del streamer.
router.put(
  "/streamers/:streamerId/regalos/:regaloId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const streamerId = Number(req.params.streamerId);
      const regaloId = Number(req.params.regaloId);
      const { nombre, costo_usd, costo_coins, puntos_otorgados, activo } = req.body || {};

      if (Number.isNaN(streamerId)) return res.status(400).json({ message: "streamerId invalido" });
      if (Number.isNaN(regaloId)) return res.status(400).json({ message: "regaloId invalido" });
      if (!nombre || typeof nombre !== "string" || !nombre.trim())
        return res.status(400).json({ message: "nombre requerido" });
      if (Number.isNaN(Number(costo_coins)) || Number(costo_coins) <= 0)
        return res.status(400).json({ message: "costo_coins debe ser numero > 0" });
      if (Number.isNaN(Number(puntos_otorgados)) || Number(puntos_otorgados) < 0)
        return res.status(400).json({ message: "puntos_otorgados debe ser numero >= 0" });
      const activoFlag =
        activo === undefined || activo === null ? undefined : Boolean(activo);

      const regaloRes = await db.query(
        `SELECT id, streamer_id FROM regalos WHERE id = $1`,
        [regaloId]
      );
      if (!regaloRes.rowCount) return res.status(404).json({ message: "regalo no encontrado" });
      if (regaloRes.rows[0].streamer_id !== streamerId)
        return res.status(400).json({ message: "regalo no pertenece a este streamer" });

      const { rows } = await db.query(
        `UPDATE regalos
         SET nombre = $1,
             costo_usd = $2,
             costo_coins = $3,
             puntos_otorgados = $4,
             activo = COALESCE($5, activo)
         WHERE id = $6
         RETURNING id, streamer_id, nombre, costo_usd, costo_coins, puntos_otorgados, activo`,
        [
          nombre.trim(),
          costo_usd === undefined || costo_usd === null ? null : Number(costo_usd),
          Number(costo_coins),
          Number(puntos_otorgados),
          activoFlag,
          regaloId,
        ]
      );

      return res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/streamers/:streamerId/regalos/:regaloId
// Desactiva un regalo (soft delete).
router.delete(
  "/streamers/:streamerId/regalos/:regaloId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const streamerId = Number(req.params.streamerId);
      const regaloId = Number(req.params.regaloId);

      if (Number.isNaN(streamerId)) return res.status(400).json({ message: "streamerId invalido" });
      if (Number.isNaN(regaloId)) return res.status(400).json({ message: "regaloId invalido" });

      const regaloRes = await db.query(
        `SELECT id, streamer_id FROM regalos WHERE id = $1`,
        [regaloId]
      );
      if (!regaloRes.rowCount) return res.status(404).json({ message: "regalo no encontrado" });
      if (regaloRes.rows[0].streamer_id !== streamerId)
        return res.status(400).json({ message: "regalo no pertenece a este streamer" });

      await db.query(
        `UPDATE regalos SET activo = FALSE WHERE id = $1`,
        [regaloId]
      );

      return res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/streams/:streamId/regalos/:regaloId/enviar
// Compra/envia un regalo: descuenta coins, suma puntos y registra el envio.
router.post(
  "/streams/:streamId/regalos/:regaloId/enviar",
  async (req: Request, res: Response, next: NextFunction) => {
    const streamId = Number(req.params.streamId);
    const regaloId = Number(req.params.regaloId);
    const { viewerId, cantidad = 1, mensaje } = req.body || {};

    if (Number.isNaN(streamId)) return res.status(400).json({ message: "streamId invalido" });
    if (Number.isNaN(regaloId)) return res.status(400).json({ message: "regaloId invalido" });
    if (Number.isNaN(Number(viewerId))) return res.status(400).json({ message: "viewerId invalido" });
    if (!Number.isInteger(Number(cantidad)) || Number(cantidad) <= 0)
      return res.status(400).json({ message: "cantidad debe ser entero > 0" });

    const qty = Number(cantidad);
    const msgText = typeof mensaje === "string" && mensaje.trim() ? mensaje.trim() : null;

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

      const findViewer = async (id: number) => {
        return client.query(
          `SELECT pv.id, pv.usuario_id, pv.nivel_actual, pv.puntos,
                  b.id AS billetera_id, b.saldo_coins
           FROM perfiles_viewer pv
           JOIN usuarios u ON u.id = pv.usuario_id
           JOIN billeteras b ON b.usuario_id = u.id
           WHERE pv.id = $1
           FOR UPDATE`,
          [id]
        );
      };

      let viewerRow: any = null;
      let viewerRes = await findViewer(Number(viewerId));

      if (!viewerRes.rowCount) {
        // Intentar con usuario asociado a un perfil de streamer (permite que streamers puedan regalar como viewers)
        const fallbackStreamer = await client.query(
          `SELECT usuario_id FROM perfiles_streamer WHERE id = $1`,
          [Number(viewerId)]
        );
        if (fallbackStreamer.rowCount) {
          const usuarioId = Number(fallbackStreamer.rows[0].usuario_id);
          const existingViewer = await client.query(
            `SELECT id FROM perfiles_viewer WHERE usuario_id = $1`,
            [usuarioId]
          );
          if (existingViewer.rowCount) {
            viewerRes = await findViewer(Number(existingViewer.rows[0].id));
          } else {
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
            const created = await client.query(
              `INSERT INTO perfiles_viewer (usuario_id)
               VALUES ($1)
               RETURNING id`,
              [usuarioId]
            );
            viewerRes = await findViewer(Number(created.rows[0].id));
          }
        }
      }

      if (viewerRes.rowCount) {
        viewerRow = viewerRes.rows[0];
      }

      if (!viewerRow) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "viewer no encontrado" });
      }
      const viewer = viewerRow;

      const streamRes = await client.query(`SELECT id, streamer_id FROM streams WHERE id = $1`, [streamId]);
      if (!streamRes.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "stream no encontrado" });
      }
      const stream = streamRes.rows[0];

      const regaloRes = await client.query(
        `SELECT id, streamer_id, nombre, costo_coins, puntos_otorgados, activo
         FROM regalos
         WHERE id = $1 AND activo = TRUE`,
        [regaloId]
      );
      if (!regaloRes.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "regalo no encontrado o inactivo" });
      }
      const regalo = regaloRes.rows[0];

      if (regalo.streamer_id && regalo.streamer_id !== stream.streamer_id) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "regalo no pertenece a este streamer" });
      }

      const totalCoins = Number(regalo.costo_coins) * qty;
      const totalPuntos = Number(regalo.puntos_otorgados) * qty;

      if (Number(viewer.saldo_coins) < totalCoins) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "saldo insuficiente" });
      }

      // Alinear secuencias para evitar PK duplicadas
      await client.query(
        `SELECT setval(pg_get_serial_sequence('envios_regalo','id'),
                       GREATEST(
                         1,
                         (SELECT COALESCE(MAX(id),1) FROM envios_regalo),
                         (SELECT last_value FROM envios_regalo_id_seq)
                       ), true)`
      );
      await client.query(
        `SELECT setval(pg_get_serial_sequence('movimientos_billetera','id'),
                       GREATEST(
                         1,
                         (SELECT COALESCE(MAX(id),1) FROM movimientos_billetera),
                         (SELECT last_value FROM movimientos_billetera_id_seq)
                       ), true)`
      );
      await client.query(
        `SELECT setval(pg_get_serial_sequence('mensajes_chat','id'),
                       GREATEST(
                         1,
                         (SELECT COALESCE(MAX(id),1) FROM mensajes_chat),
                         (SELECT last_value FROM mensajes_chat_id_seq)
                       ), true)`
      );

      const billeteraRes = await client.query(
        `UPDATE billeteras
         SET saldo_coins = saldo_coins - $1, actualizado_en = NOW()
         WHERE id = $2 AND saldo_coins >= $1
         RETURNING saldo_coins` ,
        [totalCoins, viewer.billetera_id]
      );
      if (!billeteraRes.rowCount) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "saldo insuficiente" });
      }

      const envioRes = await client.query(
        `INSERT INTO envios_regalo (gift_id, stream_id, remitente_id, streamer_id, cantidad, coins_gastados, puntos_generados, mensaje, creado_en)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         RETURNING id, creado_en`,
        [regalo.id, stream.id, viewer.id, stream.streamer_id, qty, totalCoins, totalPuntos, msgText]
      );

      await client.query(
        `INSERT INTO movimientos_billetera (billetera_id, tipo, monto, referencia_tipo, referencia_id, creado_en)
         VALUES ($1, 'regalo', $2, 'envio_regalo', $3, NOW())`,
        [viewer.billetera_id, -totalCoins, envioRes.rows[0].id]
      );

      const puntosRes = await client.query(
        `UPDATE perfiles_viewer
         SET puntos = puntos + $1
         WHERE id = $2
         RETURNING puntos`,
        [totalPuntos, viewer.id]
      );

      const puntosTotales = Number(puntosRes.rows[0].puntos);
      const levelResult = await checkLevelUp(viewer.id, puntosTotales, viewer.nivel_actual);

      await client.query(
        `INSERT INTO mensajes_chat (stream_id, usuario_id, tipo, mensaje, gift_id, envio_regalo_id, badge, nivel_usuario, creado_en)
         VALUES ($1, $2, 'regalo', $3, $4, $5, 'none', $6, NOW())`,
        [stream.id, viewer.usuario_id, msgText ?? null, regalo.id, envioRes.rows[0].id, levelResult.nuevoNivel]
      );

      await client.query("COMMIT");

      const responseBody = {
        envioId: envioRes.rows[0].id,
        streamId: stream.id,
        streamerId: stream.streamer_id,
        viewerId: viewer.id,
        coins_gastados: totalCoins,
        puntos_generados: totalPuntos,
        puntos_totales: puntosTotales,
        leveled_up: levelResult.leveledUp,
        nivel_actual: levelResult.nuevoNivel,
        saldo_restante: Number(billeteraRes.rows[0].saldo_coins),
        creado_en: envioRes.rows[0].creado_en,
      };

      // Eventos en tiempo real para overlay/chat
      broadcastStreamEvent(stream.id, "gift_sent", {
        ...responseBody,
        viewer_usuario_id: viewer.usuario_id,
        gift_id: regalo.id,
        gift_nombre: regalo.nombre,
        cantidad: qty,
        mensaje: msgText,
      });

      if (levelResult.leveledUp) {
        broadcastStreamEvent(stream.id, "viewer_level_up", {
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
  }
);

// GET /api/streams/:streamId/eventos/regalos
// Devuelve los envios de regalo recientes para overlays/animaciones.
router.get(
  "/streams/:streamId/eventos/regalos",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const streamId = Number(req.params.streamId);
      const limitParam = req.query.limit;
      const limit =
        limitParam === undefined ? 20 : Number(limitParam);
      if (Number.isNaN(streamId)) return res.status(400).json({ message: "streamId invalido" });
      if (Number.isNaN(limit) || limit <= 0 || limit > 100)
        return res.status(400).json({ message: "limit invalido (1-100)" });

      const { rows } = await db.query(
        `SELECT eg.id,
                eg.stream_id,
                eg.cantidad,
                eg.coins_gastados,
                eg.puntos_generados,
                eg.mensaje,
                eg.creado_en,
                r.id AS regalo_id,
                r.nombre AS regalo_nombre,
                r.costo_coins,
                r.puntos_otorgados,
                v.id AS viewer_id,
                u.nombre AS viewer_nombre,
                u.avatar_url
         FROM envios_regalo eg
         JOIN regalos r ON r.id = eg.gift_id
         JOIN perfiles_viewer v ON v.id = eg.remitente_id
         JOIN usuarios u ON u.id = v.usuario_id
         WHERE eg.stream_id = $1
         ORDER BY eg.creado_en DESC, eg.id DESC
         LIMIT $2`,
        [streamId, limit]
      );

      return res.json(rows);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
