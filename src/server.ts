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

const app = express();

// CORS para desarrollo local (Vite en 5173 / GitHub Pages usarA¡ fetch al dominio Render)
app.use(
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    credentials: false,
  })
);

app.use(express.json());

app.use("/api/auth", authRouter);
app.use("/api", regalosRouter);
app.use("/api", viewersRouter);
app.use("/api", mensajesRouter);
app.use("/api", nivelesRouter);
app.use("/api", monedasRouter);
app.use("/api", streamsRouter);
app.use("/api", streamerRoutes); // Dashboard, start/end stream (horas y nivel)
app.use("/api/monetizacion", monetizacionRoutes); // Recarga de monedas

// Manejador de errores simple
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ message: "Error interno" });
});

export default app;
