import express from "express";
import cors from "cors";
import mensajesRouter from "./routes/mensajes";
import regalosRouter from "./routes/regalos";
import viewersRouter from "./routes/viewers";
import nivelesRouter from "./routes/niveles";
import authRouter from "./routes/auth";
import monedasRouter from "./routes/monedas";
import streamsRouter from "./routes/streams";
import streamerRoutes from "./routes/streamers";
import monetizacionRoutes from "./routes/monetizacion";
import sseRouter from "./routes/sse";

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: (process.env.CORS_ORIGIN || "http://localhost:5173")
      .split(",")
      .map((o) => o.trim()),
    credentials: true,
  })
);

app.use("/api/auth", authRouter);
app.use("/api", regalosRouter);
app.use("/api", viewersRouter);
app.use("/api", mensajesRouter);
app.use("/api", nivelesRouter);
app.use("/api", monedasRouter);
app.use("/api", streamsRouter);
app.use("/api", streamerRoutes); // Dashboard, start/end stream (horas y nivel)
app.use("/api/monetizacion", monetizacionRoutes); // Recarga de monedas
app.use("/api", sseRouter); // SSE para chat/regalos/notifs en vivo

// Manejador de errores simple
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ message: "Error interno" });
});

export default app;
