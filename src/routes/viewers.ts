import { Router, Request, Response, NextFunction } from "express";
import { db } from "../db";

const router = Router();

// GET /api/viewers/by-usuario/:usuarioId
// Permite mapear un usuario (login) a su perfil de viewer para consumir saldo/puntos.
router.get(
  "/viewers/by-usuario/:usuarioId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const usuarioId = Number(req.params.usuarioId);
      if (Number.isNaN(usuarioId)) return res.status(400).json({ message: "usuarioId invalido" });

      const { rows } = await db.query(
        `SELECT pv.id AS viewer_id,
                u.id AS usuario_id,
                u.email,
                u.nombre,
                u.avatar_url,
                pv.nivel_actual,
                pv.puntos
         FROM perfiles_viewer pv
         JOIN usuarios u ON u.id = pv.usuario_id
         WHERE u.id = $1`,
        [usuarioId]
      );

      if (!rows.length) return res.status(404).json({ message: "viewer no encontrado para usuario" });
      const row = rows[0];

      return res.json({
        viewerId: row.viewer_id,
        usuarioId: row.usuario_id,
        email: row.email,
        nombre: row.nombre,
        avatar_url: row.avatar_url,
        nivel_actual: row.nivel_actual,
        puntos: Number(row.puntos),
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/viewers/:viewerId/saldo
router.get("/viewers/:viewerId/saldo", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const viewerId = Number(req.params.viewerId);
    if (Number.isNaN(viewerId)) return res.status(400).json({ message: "viewerId invalido" });

    const { rows } = await db.query(
      `SELECT pv.id AS viewer_id,
              u.id AS usuario_id,
              b.saldo_coins
       FROM perfiles_viewer pv
       JOIN usuarios u ON u.id = pv.usuario_id
       JOIN billeteras b ON b.usuario_id = u.id
       WHERE pv.id = $1`,
      [viewerId]
    );

    if (!rows.length) return res.status(404).json({ message: "viewer no encontrado" });

    const row = rows[0];
    res.json({
      viewerId: row.viewer_id,
      usuarioId: row.usuario_id,
      saldo_coins: Number(row.saldo_coins),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/viewers/:viewerId/progreso-nivel
// Devuelve los puntos actuales y lo que falta para el siguiente nivel segun reglas_nivel_viewer.
router.get(
  "/viewers/:viewerId/progreso-nivel",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const viewerId = Number(req.params.viewerId);
      if (Number.isNaN(viewerId)) return res.status(400).json({ message: "viewerId invalido" });

      const viewerRes = await db.query(
        `SELECT id, nivel_actual, puntos
         FROM perfiles_viewer
         WHERE id = $1`,
        [viewerId]
      );

      if (!viewerRes.rowCount) return res.status(404).json({ message: "viewer no encontrado" });
      const viewer = viewerRes.rows[0];

      const nextLevelRes = await db.query(
        `SELECT nivel, puntos_requeridos, recompensa_coins
         FROM reglas_nivel_viewer
         WHERE activo = TRUE AND nivel > $1
         ORDER BY nivel ASC
         LIMIT 1`,
        [viewer.nivel_actual]
      );

      if (!nextLevelRes.rowCount) {
        return res.json({
          viewerId: viewer.id,
          nivel_actual: viewer.nivel_actual,
          puntos_actuales: Number(viewer.puntos),
          es_nivel_maximo: true,
          siguiente_nivel: null,
          puntos_requeridos: null,
          falta_puntos: 0,
          recompensa_coins: null,
          progreso_porcentaje: 100,
        });
      }

      const nextLevel = nextLevelRes.rows[0];
      const puntosRequeridos = Number(nextLevel.puntos_requeridos);
      const puntosActuales = Number(viewer.puntos);
      const falta = Math.max(puntosRequeridos - puntosActuales, 0);
      const progresoPct = Math.min(
        100,
        Number(((puntosActuales / puntosRequeridos) * 100).toFixed(2))
      );

      return res.json({
        viewerId: viewer.id,
        nivel_actual: viewer.nivel_actual,
        puntos_actuales: puntosActuales,
        es_nivel_maximo: false,
        siguiente_nivel: nextLevel.nivel,
        puntos_requeridos: puntosRequeridos,
        falta_puntos: falta,
        recompensa_coins: Number(nextLevel.recompensa_coins),
        progreso_porcentaje: progresoPct,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/viewers/:viewerId/perfil
// Devuelve nivel y puntos actuales (y saldo) para mostrar progreso en el perfil.
router.get("/viewers/:viewerId/perfil", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const viewerId = Number(req.params.viewerId);
    if (Number.isNaN(viewerId)) return res.status(400).json({ message: "viewerId invalido" });

    const { rows } = await db.query(
      `SELECT pv.id AS viewer_id,
              u.id AS usuario_id,
              u.nombre,
              u.avatar_url,
              pv.nivel_actual,
              pv.puntos,
              pv.horas_vistas,
              b.saldo_coins
       FROM perfiles_viewer pv
       JOIN usuarios u ON u.id = pv.usuario_id
       JOIN billeteras b ON b.usuario_id = u.id
       WHERE pv.id = $1`,
      [viewerId]
    );

    if (!rows.length) return res.status(404).json({ message: "viewer no encontrado" });
    const row = rows[0];

    return res.json({
      viewerId: row.viewer_id,
      usuarioId: row.usuario_id,
      nombre: row.nombre,
      avatar_url: row.avatar_url,
      nivel_actual: row.nivel_actual,
      puntos: Number(row.puntos),
      horas_vistas: Number(row.horas_vistas),
      saldo_coins: Number(row.saldo_coins),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
