# PrograWeb_StreamApp_Backend
Plataforma de streaming estilo TikTok desarrollada en React + Vite. 

## Contenido
-  Diagrama de tablas
-  Conexión a la base de datos


## Diagrama de tablas
![Diagrama de tablas](Captura/Tablas.png)

## Conexión a la base de datos (Docker)
1. Solo con docker instalado (psql u otros ya vean ustedes )
2. Ejecuta el contenedor:
```sh
docker run --rm -it postgres:16 \
  psql "postgresql://pw_db_gl86_user:GO7VGM4jvPNscQz9e9hcFNI71zvFUjx0@dpg-d4n6e7i4d50c73f7nqv0-a.oregon-postgres.render.com/pw_db_gl86?sslmode=require"
```
3. Explora las tablas según necesites

## Notas importantes
- No modifiques datos a menos que sea estrictamente necesario
- Si cambias el esquema o algún dato AVISAAAAAAAAAAAAAAAAAAAAAAAAAAA