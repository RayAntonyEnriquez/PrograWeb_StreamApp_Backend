import { Router, Request, Response, NextFunction } from "express";
import { db } from "../db";

const router = Router();

const rouletteRewards = [
  { type: "coins", amount: 50, label: "+50 monedas", short: "50c" },
  { type: "coins", amount: 100, label: "+100 monedas", short: "100c" },
  { type: "coins", amount: 200, label: "+200 monedas", short: "200c" },
  { type: "points", amount: 50, label: "+50 puntos", short: "50p" },
  { type: "points", amount: 100, label: "+100 puntos", short: "100p" },
  { type: "coins", amount: 500, label: "+500 monedas", short: "500c" },
];

const alignSequence = async (
  client: Awaited<ReturnType<typeof db.getClient>>,
  table: string,
  column: string = "id"
) => {
  await client.query(
    `SELECT setval(
        pg_get_serial_sequence($1, $2),
        GREATEST(
          1,
          (SELECT COALESCE(MAX(${column}),1) FROM ${table}),
          (SELECT last_value FROM pg_get_serial_sequence($1, $2))
        ),
        true
      )`,
    [table, column]
  );
};

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

// GET /api/viewers/:viewerId/ruleta/status
router.get("/viewers/:viewerId/ruleta/status", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const viewerId = Number(req.params.viewerId);
    if (Number.isNaN(viewerId)) return res.status(400).json({ message: "viewerId invalido" });

    const viewerRes = await db.query(
      `SELECT pv.id
       FROM perfiles_viewer pv
       WHERE pv.id = $1`,
      [viewerId]
    );
    if (!viewerRes.rowCount) return res.status(404).json({ message: "viewer no encontrado" });

    const claimRes = await db.query(
      `SELECT reward_label, reward_amount, reward_type, claimed_on
       FROM ruleta_claims
       WHERE viewer_id = $1 AND claimed_on = CURRENT_DATE
       LIMIT 1`,
      [viewerId]
    );

    if (claimRes.rowCount) {
      const row = claimRes.rows[0];
      return res.json({
        claimed_today: true,
        reward: {
          label: row.reward_label,
          amount: Number(row.reward_amount),
          type: row.reward_type,
        },
      });
    }

    return res.json({ claimed_today: false, reward: null });
  } catch (err) {
    next(err);
  }
});

// POST /api/viewers/:viewerId/ruleta/claim
router.post("/viewers/:viewerId/ruleta/claim", async (req: Request, res: Response, next: NextFunction) => {
  const viewerId = Number(req.params.viewerId);
  if (Number.isNaN(viewerId)) return res.status(400).json({ message: "viewerId invalido" });

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const viewerRes = await client.query(
      `SELECT pv.id, pv.usuario_id, pv.nivel_actual, pv.puntos, b.id AS billetera_id, b.saldo_coins
       FROM perfiles_viewer pv
       JOIN usuarios u ON u.id = pv.usuario_id
       JOIN billeteras b ON b.usuario_id = u.id
       WHERE pv.id = $1
       FOR UPDATE`,
      [viewerId]
    );
    if (!viewerRes.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "viewer no encontrado" });
    }
    const viewer = viewerRes.rows[0];

    const claimRes = await client.query(
      `SELECT 1 FROM ruleta_claims WHERE viewer_id = $1 AND claimed_on = CURRENT_DATE LIMIT 1`,
      [viewerId]
    );
    if (claimRes.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "ruleta ya usada hoy" });
    }

    const reward = rouletteRewards[Math.floor(Math.random() * rouletteRewards.length)];

    await alignSequence(client, "ruleta_claims");

    let saldoCoins = Number(viewer.saldo_coins);
    let puntos = Number(viewer.puntos);
    if (reward.type === "coins") {
      saldoCoins += reward.amount;
      await client.query(
        `UPDATE billeteras SET saldo_coins = $1, actualizado_en = NOW() WHERE id = $2`,
        [saldoCoins, viewer.billetera_id]
      );
    } else {
      puntos += reward.amount;
      await client.query(
        `UPDATE perfiles_viewer SET puntos = $1 WHERE id = $2`,
        [puntos, viewer.id]
      );
    }

    await client.query(
      `INSERT INTO ruleta_claims (viewer_id, reward_label, reward_amount, reward_type, claimed_on)
       VALUES ($1, $2, $3, $4, CURRENT_DATE)`,
      [viewer.id, reward.label, reward.amount, reward.type]
    );

    await client.query("COMMIT");
    return res.status(201).json({
      reward,
      claimed_today: true,
      saldo_coins: saldoCoins,
      puntos,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
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

    res.json({
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
