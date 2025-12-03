import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { db } from "../db";

const router = Router();

const buildVdoLinks = (key: string) => ({
  pushUrl: `https://vdo.ninja/?push=${key}&webcam&quality=0&proaudio`,
  viewUrl: `https://vdo.ninja/?view=${key}&cleanoutput`,
});

// --- Req 11: Datos para el Dashboard ---
router.get("/streamers/:userId/dashboard", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = Number(req.params.userId);
    if (Number.isNaN(userId)) return res.status(400).json({ message: "userId invalido" });
    const { rows } = await db.query(
      `SELECT id, nivel_actual, horas_totales, titulo_canal 
       FROM perfiles_streamer WHERE usuario_id = $1`,
      [userId]
    );

    if (!rows.length) return res.status(404).json({ message: "Perfil de streamer no encontrado" });

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// --- Req 23: Iniciar Transmision ---
router.post("/streams/start", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { streamerId, titulo } = req.body;

    // 1. Insertamos el stream en estado 'en_vivo'
    const streamRes = await db.query(
      `INSERT INTO streams (streamer_id, titulo, estado, inicio_en) 
       VALUES ($1, $2, 'en_vivo', NOW()) RETURNING id`,
      [streamerId, titulo]
    );
    const streamId = streamRes.rows[0].id;

    // 2. Iniciamos una sesion de tiempo (para contar exacto)
    await db.query(`INSERT INTO sesiones_stream (stream_id, inicio) VALUES ($1, NOW())`, [streamId]);

    // 3. Generamos key y URLs de VDO.Ninja y las guardamos
    const streamKey = crypto.randomBytes(6).toString("hex");
    const { pushUrl, viewUrl } = buildVdoLinks(streamKey);
    await db.query(
      `UPDATE streams
       SET vdo_stream_key = $1,
           vdo_push_url = $2,
           vdo_view_url = $3
       WHERE id = $4`,
      [streamKey, pushUrl, viewUrl, streamId]
    );

    res.json({
      success: true,
      streamId,
      message: "Stream iniciado",
      vdo_stream_key: streamKey,
      vdo_push_url: pushUrl,
      vdo_view_url: viewUrl,
    });
  } catch (err) {
    next(err);
  }
});

// --- Req 23 y 21: Finalizar Transmision y checkear nivel ---
router.post("/streams/end", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { streamId, streamerId } = req.body;

    // 1. Finalizar en tabla streams
    await db.query(`UPDATE streams SET estado = 'finalizado', fin_en = NOW() WHERE id = $1`, [streamId]);

    // 2. Cerrar sesion y calcular duracion
    const sessionRes = await db.query(
      `UPDATE sesiones_stream 
       SET fin = NOW(), duracion_horas = EXTRACT(EPOCH FROM (NOW() - inicio))/3600 
       WHERE stream_id = $1 RETURNING duracion_horas`,
      [streamId]
    );
    const duracion = Number(sessionRes.rows[0]?.duracion_horas || 0);

    // 3. Sumar las horas al total del streamer
    const perfilRes = await db.query(
      `UPDATE perfiles_streamer 
       SET horas_totales = horas_totales + $1 
       WHERE id = $2 RETURNING horas_totales, nivel_actual`,
      [duracion, streamerId]
    );
    const { horas_totales, nivel_actual } = perfilRes.rows[0];

    // 4. Logica de subida de nivel por horas
    const nivelRes = await db.query(
      `SELECT nivel FROM reglas_nivel_streamer 
       WHERE horas_requeridas <= $1 AND nivel > $2 
       ORDER BY nivel DESC LIMIT 1`,
      [horas_totales, nivel_actual]
    );

    let nuevoNivel: number | null = null;
    let mensajeNivel: string | null = null;

    if (nivelRes.rows.length > 0) {
      nuevoNivel = nivelRes.rows[0].nivel;
      await db.query(`UPDATE perfiles_streamer SET nivel_actual = $1 WHERE id = $2`, [nuevoNivel, streamerId]);
      mensajeNivel = `Felicidades! Has subido al nivel ${nuevoNivel}`;
    }

    res.json({
      success: true,
      horasSumadas: duracion,
      horasTotales: horas_totales,
      subioNivel: !!nuevoNivel,
      nuevoNivel,
      mensaje: mensajeNivel || "Stream finalizado correctamente",
    });
  } catch (err) {
    next(err);
  }
});

export default router;

