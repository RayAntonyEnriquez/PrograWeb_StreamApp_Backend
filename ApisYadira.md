Registro espectador
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"nombre":"Ana Viewer","email":"ana.viewer@mail.com","password":"secreto123","rol":"espectador"}'

Registro streamer
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"nombre":"Pepe Stream","email":"pepe.stream@mail.com","password":"secreto123","rol":"streamer","canal_slug":"pepe-stream","titulo_canal":"Dev y cafe"}'

Login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ana.viewer@mail.com","password":"secreto123"}'

Refresh
curl -X POST http://localhost:3000/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"<refresh_token_recibido>"}'

Logout (devuelve 200 {"message":"logout ok"})
curl -X POST http://localhost:3000/api/auth/logout \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"<refresh_token_recibido>"}'

Listar paquetes de monedas
curl http://localhost:3000/api/paquetes-monedas

Comprar paquete (recarga saldo y crea orden)
curl -X POST http://localhost:3000/api/viewers/1/paquetes/1/comprar \
  -H "Content-Type: application/json"

Saldo viewer (validar recarga)
curl http://localhost:3000/api/viewers/1/saldo

Abrir sesion de stream (RTMP/WebRTC)
curl -X POST http://localhost:3000/api/streams/1/start \
  -H "Content-Type: application/json" \
  -d '{"streamerId":1}'

Cerrar sesion de stream (suma horas al streamer)
curl -X POST http://localhost:3000/api/streams/1/stop \
  -H "Content-Type: application/json" \
  -d '{"streamerId":1}'

Perfil del espectador (nivel y puntos)
curl http://localhost:3000/api/viewers/1/perfil

Enviar mensaje (suma puntos y avisa si sube de nivel)
curl -X POST http://localhost:3000/api/streams/1/mensajes \
  -H "Content-Type: application/json" \
  -d '{"viewerId":1,"mensaje":"Hola chat"}'

Enviar regalo (suma puntos y avisa si sube de nivel)
curl -X POST http://localhost:3000/api/streams/1/regalos/1/enviar \
  -H "Content-Type: application/json" \
  -d '{"viewerId":1,"cantidad":1,"mensaje":"Para ti"}'

Overlay de regalos recientes (para animaciones)
curl http://localhost:3000/api/streams/1/eventos/regalos?limit=20

Progreso de nivel del streamer (horas faltantes)
curl http://localhost:3000/api/streamers/1/progreso-nivel


