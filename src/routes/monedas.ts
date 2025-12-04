import { Router, Request, Response, NextFunction } from "express";
import { db } from "../db";

const router = Router();

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
        true)`,
    [table, column]
  );
};

// GET /api/paquetes-monedas
router.get("/paquetes-monedas", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows } = await db.query(
      `SELECT id, nombre, coins, precio, moneda, activo
       FROM paquetes_monedas
       WHERE activo = TRUE
       ORDER BY precio ASC, id ASC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/viewers/:viewerId/paquetes/:paqueteId/comprar
// Simula compra de paquete y recarga saldo del viewer (flujo de prueba sin pasarela).
router.post(
  "/viewers/:viewerId/paquetes/:paqueteId/comprar",
  async (req: Request, res: Response, next: NextFunction) => {
    const viewerId = Number(req.params.viewerId);
    const paqueteId = Number(req.params.paqueteId);

    if (Number.isNaN(viewerId)) return res.status(400).json({ message: "viewerId invalido" });
    if (Number.isNaN(paqueteId)) return res.status(400).json({ message: "paqueteId invalido" });

    const client = await db.getClient();
    try {
      await client.query("BEGIN");

      const viewerRes = await client.query(
        `SELECT pv.id, pv.usuario_id, b.id AS billetera_id, b.saldo_coins
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

      const paqueteRes = await client.query(
        `SELECT id, coins, precio, moneda, activo
         FROM paquetes_monedas
         WHERE id = $1 AND activo = TRUE`,
        [paqueteId]
      );
      if (!paqueteRes.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "paquete no encontrado o inactivo" });
      }
      const paquete = paqueteRes.rows[0];

      await alignSequence(client, "ordenes_monedas");
      await alignSequence(client, "movimientos_billetera");

      const ordenRes = await client.query(
        `INSERT INTO ordenes_monedas (usuario_id, paquete_id, coins_entregados, precio_pagado, estado, comprobante)
         VALUES ($1, $2, $3, $4, 'pagado', NULL)
         RETURNING id, creado_en`,
        [viewer.usuario_id, paquete.id, paquete.coins, paquete.precio]
      );

      const billeteraRes = await client.query(
        `UPDATE billeteras
         SET saldo_coins = saldo_coins + $1, actualizado_en = NOW()
         WHERE id = $2
         RETURNING saldo_coins`,
        [paquete.coins, viewer.billetera_id]
      );

      await client.query(
        `INSERT INTO movimientos_billetera (billetera_id, tipo, monto, referencia_tipo, referencia_id, creado_en)
         VALUES ($1, 'recarga', $2, 'orden_monedas', $3, NOW())`,
        [viewer.billetera_id, paquete.precio, ordenRes.rows[0].id]
      );

      await client.query("COMMIT");
      return res.status(201).json({
        ordenId: ordenRes.rows[0].id,
        viewerId: viewer.id,
        usuarioId: viewer.usuario_id,
        paqueteId: paquete.id,
        coins_entregados: Number(paquete.coins),
        precio_pagado: Number(paquete.precio),
        moneda: paquete.moneda,
        saldo_final: Number(billeteraRes.rows[0].saldo_coins),
        creado_en: ordenRes.rows[0].creado_en,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      next(err);
    } finally {
      client.release();
    }
  }
);

export default router;
