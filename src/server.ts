import express from "express";
import mensajesRouter from "./routes/mensajes";
import regalosRouter from "./routes/regalos";
import viewersRouter from "./routes/viewers";
import nivelesRouter from "./routes/niveles";

const app = express();
app.use(express.json());

app.use("/api", regalosRouter);
app.use("/api", viewersRouter);
app.use("/api", mensajesRouter);
app.use("/api", nivelesRouter);

// Manejador de errores simple
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ message: "Error interno" });
});

export default app;
