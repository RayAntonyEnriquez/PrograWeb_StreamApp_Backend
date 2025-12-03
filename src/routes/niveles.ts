import { Router, Request, Response, NextFunction } from "express";
import { db } from "../db";

const router = Router();

// GET /api/niveles-viewer
router.get("/niveles-viewer", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows } = await db.query(
      `SELECT id, nivel, puntos_requeridos, recompensa_coins, activo
       FROM reglas_nivel_viewer
       ORDER BY nivel ASC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/niveles-viewer
// Crea una regla de nivel para espectadores (global, no por streamer).
router.post("/niveles-viewer", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { nivel, puntos_requeridos, recompensa_coins, activo = true } = req.body || {};

    if (!Number.isInteger(Number(nivel)) || Number(nivel) <= 0)
      return res.status(400).json({ message: "nivel debe ser entero > 0" });
    if (!Number.isInteger(Number(puntos_requeridos)) || Number(puntos_requeridos) <= 0)
      return res.status(400).json({ message: "puntos_requeridos debe ser entero > 0" });
    if (!Number.isInteger(Number(recompensa_coins)) || Number(recompensa_coins) < 0)
      return res.status(400).json({ message: "recompensa_coins debe ser entero >= 0" });

    const exists = await db.query(
      `SELECT 1 FROM reglas_nivel_viewer WHERE nivel = $1`,
      [Number(nivel)]
    );
    if (exists.rowCount) return res.status(409).json({ message: "nivel ya existe" });

    await db.query(
      `SELECT setval(
         pg_get_serial_sequence('reglas_nivel_viewer','id'),
         GREATEST(
           (SELECT COALESCE(MAX(id),0) FROM reglas_nivel_viewer),
           (SELECT last_value FROM reglas_nivel_viewer_id_seq)
         ),
         true
       )`
    );

    const { rows } = await db.query(
      `INSERT INTO reglas_nivel_viewer (nivel, puntos_requeridos, recompensa_coins, activo)
       VALUES ($1, $2, $3, $4)
       RETURNING id, nivel, puntos_requeridos, recompensa_coins, activo`,
      [Number(nivel), Number(puntos_requeridos), Number(recompensa_coins), Boolean(activo)]
    );

    return res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/niveles-viewer/:id
router.put("/niveles-viewer/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const { nivel, puntos_requeridos, recompensa_coins, activo } = req.body || {};
    if (Number.isNaN(id)) return res.status(400).json({ message: "id invalido" });

    if (
      nivel === undefined &&
      puntos_requeridos === undefined &&
      recompensa_coins === undefined &&
      activo === undefined
    ) {
      return res.status(400).json({ message: "no hay campos para actualizar" });
    }

    if (nivel !== undefined && (!Number.isInteger(Number(nivel)) || Number(nivel) <= 0))
      return res.status(400).json({ message: "nivel debe ser entero > 0" });
    if (
      puntos_requeridos !== undefined &&
      (!Number.isInteger(Number(puntos_requeridos)) || Number(puntos_requeridos) <= 0)
    )
      return res.status(400).json({ message: "puntos_requeridos debe ser entero > 0" });
    if (
      recompensa_coins !== undefined &&
      (!Number.isInteger(Number(recompensa_coins)) || Number(recompensa_coins) < 0)
    )
      return res.status(400).json({ message: "recompensa_coins debe ser entero >= 0" });

    const current = await db.query(
      `SELECT id, nivel FROM reglas_nivel_viewer WHERE id = $1`,
      [id]
    );
    if (!current.rowCount) return res.status(404).json({ message: "regla no encontrada" });

    if (nivel !== undefined) {
      const dup = await db.query(
        `SELECT 1 FROM reglas_nivel_viewer WHERE nivel = $1 AND id <> $2`,
        [Number(nivel), id]
      );
      if (dup.rowCount) return res.status(409).json({ message: "nivel ya existe" });
    }

    const { rows } = await db.query(
      `UPDATE reglas_nivel_viewer
       SET nivel = COALESCE($1, nivel),
           puntos_requeridos = COALESCE($2, puntos_requeridos),
           recompensa_coins = COALESCE($3, recompensa_coins),
           activo = COALESCE($4, activo)
       WHERE id = $5
       RETURNING id, nivel, puntos_requeridos, recompensa_coins, activo`,
      [
        nivel !== undefined ? Number(nivel) : null,
        puntos_requeridos !== undefined ? Number(puntos_requeridos) : null,
        recompensa_coins !== undefined ? Number(recompensa_coins) : null,
        activo !== undefined ? Boolean(activo) : null,
        id,
      ]
    );

    return res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/niveles-viewer/:id
// Soft delete: marca activo = false
router.delete("/niveles-viewer/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "id invalido" });

    const found = await db.query(
      `SELECT id FROM reglas_nivel_viewer WHERE id = $1`,
      [id]
    );
    if (!found.rowCount) return res.status(404).json({ message: "regla no encontrada" });

    await db.query(
      `UPDATE reglas_nivel_viewer SET activo = FALSE WHERE id = $1`,
      [id]
    );
    return res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
