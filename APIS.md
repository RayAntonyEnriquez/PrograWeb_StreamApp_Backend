## API de regalos, saldo y chat (espectador)

### Requerimientos cubiertos
1) **Como espectador, puedo ver la lista de regalos con nombre, costo y puntos para elegir qué enviar.**  
2) **Como espectador, puedo ver mi saldo de monedas en el encabezado/menú para decidir compras y envíos.**  
3) **Como espectador, puedo enviar mensajes y sumar 1 punto por mensaje para progresar por participación.**
4) **Como espectador, puedo comprar y enviar un regalo que descuente monedas y sume mis puntos para apoyar al streamer y progresar.**

### Entornos y variables
- `DATABASE_URL` (Render Postgres, SSL required). Ejemplo: `postgresql://.../pw_db_gl86?sslmode=require`
- `PORT` (por defecto 3000)

### Endpoints

#### 1) Lista de regalos por streamer
- `GET /api/streamers/:streamerId/regalos`
- Devuelve regalos **activos** del streamer o globales (`streamer_id IS NULL`), ordenados por `costo_coins` asc.
- Path params:
  - `streamerId` (number, requerido)
- Respuestas:
  - 200 OK, body:  
    ```json
    [
      { "id": 1, "nombre": "Cafecito", "costo_usd": 1.99, "costo_coins": 200, "puntos_otorgados": 20 },
      { "id": 2, "nombre": "Super Like", "costo_usd": null, "costo_coins": 50, "puntos_otorgados": 5 }
    ]
    ```
  - 400 Bad Request si `streamerId` no es numérico.
  - 500 Error interno (fallo en BD u otros).

#### 2) Lista global de regalos (opcional)
- `GET /api/regalos`
- Devuelve todos los regalos **activos** (con o sin streamer), ordenados por `streamer_id` y `costo_coins`.
- Respuestas:
  - 200 OK, body: arreglo de regalos con campos `id, streamer_id, nombre, costo_usd, costo_coins, puntos_otorgados`.

#### 3) Saldo de monedas del espectador
- `GET /api/viewers/:viewerId/saldo`
- Une `perfiles_viewer -> usuarios -> billeteras` y devuelve el saldo de coins.
- Path params:
  - `viewerId` (number, requerido)
- Respuestas:
  - 200 OK, body:  
    ```json
    { "viewerId": 1, "usuarioId": 2, "saldo_coins": 300 }
    ```
  - 400 Bad Request si `viewerId` no es numérico.
  - 404 Not Found si el viewer no existe.
  - 500 Error interno (fallo en BD u otros).

#### 4) Enviar mensaje y sumar puntos de participación
- `POST /api/streams/:streamId/mensajes`
- Body JSON:
  ```json
  { "viewerId": 1, "mensaje": "Hola!" }
  ```
- Flujo:
  - Valida `streamId` y `viewerId` numéricos, `mensaje` no vacío.
  - Verifica existencia de viewer (`perfiles_viewer`) y stream.
  - Transacción: suma +1 punto en `perfiles_viewer`, inserta en `mensajes_chat` con `tipo='texto'`, `badge='none'`, `nivel_usuario` del viewer.
- Respuestas:
  - 201 Created:
    ```json
    {
      "mensajeId": 5,
      "streamId": 1,
      "viewerId": 1,
      "puntos_totales": 851,
      "creado_en": "2024-06-10T15:00:00.000Z"
    }
    ```
  - 400 si path/body inválido.
  - 404 si viewer o stream no existen.
  - 500 en error interno.

#### 5) Comprar/enviar regalo (descontar coins y sumar puntos)
- `POST /api/streams/:streamId/regalos/:regaloId/enviar`
- Body JSON:
  ```json
  { "viewerId": 1, "cantidad": 1, "mensaje": "Para ti" }
  ```
- Flujo:
  - Valida `streamId`, `regaloId`, `viewerId` numéricos y `cantidad` entero > 0.
  - Verifica existencia de viewer (incluye billetera), stream y regalo activo. Si el regalo es específico de streamer, valida que pertenezca al streamer del stream.
  - Transacción:
    - Alinea secuencias (envios_regalo, movimientos_billetera, mensajes_chat) para evitar PK duplicadas.
    - Verifica saldo suficiente; actualiza `billeteras` descontando `costo_coins * cantidad`.
    - Inserta en `envios_regalo` (coins_gastados, puntos_generados, mensaje).
    - Inserta movimiento en `movimientos_billetera` (`tipo='regalo'`, monto negativo, referencia al envío).
    - Actualiza `perfiles_viewer.puntos` sumando `puntos_otorgados * cantidad`.
    - Inserta en `mensajes_chat` con `tipo='regalo'`, `gift_id` y `envio_regalo_id`.
- Respuestas:
  - 201 Created:
    ```json
    {
      "envioId": 10,
      "streamId": 1,
      "streamerId": 1,
      "viewerId": 1,
      "coins_gastados": 200,
      "puntos_generados": 20,
      "puntos_totales": 870,
      "saldo_restante": 100,
      "creado_en": "2024-06-10T15:00:00.000Z"
    }
    ```
  - 400 si path/body inválido, saldo insuficiente o regalo no pertenece al streamer.
  - 404 si viewer, stream o regalo no existen/están inactivos.
  - 500 en error interno.

### Comandos de prueba (curl)
- Regalos por streamer:  
  `curl http://localhost:3000/api/streamers/1/regalos`
- Regalos globales:  
  `curl http://localhost:3000/api/regalos`
- Saldo de espectador:  
  `curl http://localhost:3000/api/viewers/1/saldo`
- Enviar mensaje y sumar punto:  
  `curl -X POST http://localhost:3000/api/streams/1/mensajes -H "Content-Type: application/json" -d "{\"viewerId\":1,\"mensaje\":\"Hola chat\"}"`
- Enviar regalo (compra + puntos + descuenta coins):  
  `curl -X POST http://localhost:3000/api/streams/1/regalos/1/enviar -H "Content-Type: application/json" -d "{\"viewerId\":1,\"cantidad\":1,\"mensaje\":\"Para ti\"}"`

### Criterios de aceptación (rápidos)
- Respuesta 200 para los GET con datos válidos (según la BD de Render).
- Errores de path numérico devuelven 400; viewer inexistente devuelve 404.
- En el POST de mensaje, cada llamado válido incrementa `puntos` en `perfiles_viewer` en 1 y crea un registro en `mensajes_chat`; viewer/stream inexistente responde 404 sin modificar datos.
- Campos presentes:
  - Regalos: `id, nombre, costo_usd, costo_coins, puntos_otorgados` (y `streamer_id` en la global).
  - Saldo: `viewerId, usuarioId, saldo_coins`.
  - Mensaje: `mensajeId, streamId, viewerId, puntos_totales, creado_en`.
  - Envio regalo: `envioId, streamId, streamerId, viewerId, coins_gastados, puntos_generados, puntos_totales, saldo_restante, creado_en`.
  - Progreso nivel: `viewerId, nivel_actual, puntos_actuales, es_nivel_maximo, siguiente_nivel, puntos_requeridos, falta_puntos, recompensa_coins, progreso_porcentaje`.
  - Chat (listado): `id, stream_id, usuario_id, usuario_nombre, avatar_url, tipo, mensaje, badge, nivel_usuario, gift_id, envio_regalo_id, creado_en`.

### Nuevo requerimiento
5) **Como espectador, puedo ver cuanto me falta para el siguiente nivel para mantenerme motivado.**

### Nuevo endpoint
#### 6) Progreso hacia siguiente nivel (viewer)
- `GET /api/viewers/:viewerId/progreso-nivel`
- Usa `perfiles_viewer` y `reglas_nivel_viewer` activas para calcular puntos actuales, el siguiente nivel, recompensa y porcentaje.
- Respuestas:
  - 200 OK (con siguiente nivel):
    ```json
    {
      "viewerId": 1,
      "nivel_actual": 4,
      "puntos_actuales": 850,
      "es_nivel_maximo": false,
      "siguiente_nivel": 5,
      "puntos_requeridos": 1000,
      "falta_puntos": 150,
      "recompensa_coins": 100,
      "progreso_porcentaje": 85
    }
    ```
  - 200 OK si ya está en el nivel máximo (sin siguiente nivel activo), con `es_nivel_maximo: true` y `falta_puntos: 0`.
  - 400 si `viewerId` no es numérico.
  - 404 si el viewer no existe.

### Comando de prueba
- Progreso hacia siguiente nivel:  
  `curl http://localhost:3000/api/viewers/1/progreso-nivel`

### Nuevo requerimiento streamer
6) **Como streamer, puedo crear/editar/eliminar regalos con nombre, costo y puntos para personalizar mi canal.**

### Nuevos endpoints (streamer)
- `POST /api/streamers/:streamerId/regalos`  
  Body: `nombre` (string), `costo_coins` (number>0), `puntos_otorgados` (number>=0), `costo_usd` (number|null, opcional), `activo` (bool, opcional). Devuelve regalo creado.  
  Ejemplo:  
  `curl -X POST http://localhost:3000/api/streamers/1/regalos -H "Content-Type: application/json" -d "{\"nombre\":\"Cafecito\",\"costo_usd\":1.99,\"costo_coins\":200,\"puntos_otorgados\":20}"`
- `PUT /api/streamers/:streamerId/regalos/:regaloId`  
  Actualiza los campos del regalo del streamer (mismas validaciones; `activo` opcional).  
  Ejemplo:  
  `curl -X PUT http://localhost:3000/api/streamers/1/regalos/1 -H "Content-Type: application/json" -d "{\"nombre\":\"Cafecito XL\",\"costo_usd\":2.49,\"costo_coins\":250,\"puntos_otorgados\":30,\"activo\":true}"`
- `DELETE /api/streamers/:streamerId/regalos/:regaloId`  
  Desactiva (soft delete) el regalo del streamer. Responde 204 sin body.  
  Ejemplo:  
  `curl -X DELETE http://localhost:3000/api/streamers/1/regalos/1`

### Nuevo requerimiento streamer (niveles)
7) **Como streamer, puedo configurar los puntos requeridos por nivel para mis espectadores para ajustar la progresión a mi comunidad.**

### Nuevos endpoints (niveles viewer)
- `GET /api/niveles-viewer` (lista todas las reglas activas/inactivas, ordenadas por nivel).
- `POST /api/niveles-viewer` (crea regla; requiere `nivel`, `puntos_requeridos`, `recompensa_coins`, `activo` opcional).
- `PUT /api/niveles-viewer/:id` (actualiza regla; valida duplicados de nivel).
- `DELETE /api/niveles-viewer/:id` (soft delete, pone `activo=false`).

### Comandos de prueba (niveles viewer)
- Listar reglas nivel viewer:  
  `curl http://localhost:3000/api/niveles-viewer`
- Crear regla nivel viewer:  
  `curl -X POST http://localhost:3000/api/niveles-viewer -H "Content-Type: application/json" -d "{\"nivel\":6,\"puntos_requeridos\":1500,\"recompensa_coins\":150,\"activo\":true}"`
- Editar regla nivel viewer:  
  `curl -X PUT http://localhost:3000/api/niveles-viewer/1 -H "Content-Type: application/json" -d "{\"puntos_requeridos\":1100,\"recompensa_coins\":120}"`
- Desactivar regla nivel viewer:  
  `curl -X DELETE http://localhost:3000/api/niveles-viewer/1`

### Nuevo requerimiento chat
8) **Como espectador, puedo ver el nivel de cada usuario junto a su nombre en el chat para comparar participación.**

### Nuevo endpoint (chat con nivel)
- `GET /api/streams/:streamId/mensajes`  
  Devuelve los mensajes del stream con nombre, avatar y `nivel_usuario` guardado en `mensajes_chat`. Ordenado por fecha asc.
  Ejemplo:  
  `curl http://localhost:3000/api/streams/1/mensajes`
