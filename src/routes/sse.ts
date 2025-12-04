import { Router, Request, Response, NextFunction } from "express";
import { registerStreamClient } from "../sse";

const router = Router();

// GET /api/streams/:streamId/events
// SSE: suscribe al stream para recibir chat, regalos y notificaciones en tiempo real.
router.get("/streams/:streamId/events", (req: Request, res: Response, next: NextFunction) => {
  try {
    const streamId = Number(req.params.streamId);
    if (Number.isNaN(streamId)) return res.status(400).json({ message: "streamId invalido" });
    registerStreamClient(streamId, res);
  } catch (err) {
    next(err);
  }
});

export default router;
