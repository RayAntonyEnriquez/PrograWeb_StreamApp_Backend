--POR FAVOR NO TOCAS ESTAR TABLAS YA ESTAS SUBIDAS A LA BD DE RENDER , 
--ESTA ES SOLO LA ESTRUCTURA QUE SE SIGUIO, O AVISEN SI UN DATO ESTA MAL PAARA CAMBAR SIN MALOGRAR LAS DEMAS TABLAS
--
-- Enums
CREATE TYPE rol_usuario AS ENUM ('streamer','espectador');
CREATE TYPE estado_usuario AS ENUM ('activo','suspendido');
CREATE TYPE estado_stream AS ENUM ('programado','en_vivo','finalizado');
CREATE TYPE estado_suscripcion AS ENUM ('activa','cancelada','expirada');
CREATE TYPE tipo_mov_billetera AS ENUM ('recarga','regalo','suscripcion','reembolso');
CREATE TYPE tipo_msg_chat AS ENUM ('texto','regalo','sistema');
CREATE TYPE badge_chat AS ENUM ('mod','sub','vip','none');
CREATE TYPE estado_orden AS ENUM ('pendiente','pagado','fallido');

-- Usuarios
CREATE TABLE usuarios (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    nombre VARCHAR(255) NOT NULL,
    rol rol_usuario NOT NULL,
    avatar_url VARCHAR(1024),
    estado estado_usuario NOT NULL DEFAULT 'activo',
    creado_en TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Perfiles
CREATE TABLE perfiles_streamer (
    id SERIAL PRIMARY KEY,
    usuario_id INT NOT NULL UNIQUE REFERENCES usuarios(id),
    canal_slug VARCHAR(255) NOT NULL UNIQUE,
    titulo_canal VARCHAR(255),
    bio TEXT,
    nivel_actual INT NOT NULL DEFAULT 1,
    horas_totales DECIMAL(10,2) NOT NULL DEFAULT 0,
    ultimo_stream_en TIMESTAMP
);

CREATE TABLE perfiles_viewer (
    id SERIAL PRIMARY KEY,
    usuario_id INT NOT NULL UNIQUE REFERENCES usuarios(id),
    nivel_actual INT NOT NULL DEFAULT 1,
    puntos INT NOT NULL DEFAULT 0,
    horas_vistas DECIMAL(10,2) NOT NULL DEFAULT 0,
    saldo_coins DECIMAL(12,2) NOT NULL DEFAULT 0
);

-- Billeteras
CREATE TABLE billeteras (
    id SERIAL PRIMARY KEY,
    usuario_id INT NOT NULL UNIQUE REFERENCES usuarios(id),
    saldo_coins DECIMAL(12,2) NOT NULL DEFAULT 0,
    actualizado_en TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE movimientos_billetera (
    id SERIAL PRIMARY KEY,
    billetera_id INT NOT NULL REFERENCES billeteras(id),
    tipo tipo_mov_billetera NOT NULL,
    monto DECIMAL(12,2) NOT NULL,
    referencia_tipo VARCHAR(50),
    referencia_id INT,
    creado_en TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Monetización
CREATE TABLE paquetes_monedas (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(255) NOT NULL,
    coins INT NOT NULL,
    precio DECIMAL(10,2) NOT NULL,
    moneda VARCHAR(10) NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE ordenes_monedas (
    id SERIAL PRIMARY KEY,
    usuario_id INT NOT NULL REFERENCES usuarios(id),
    paquete_id INT NOT NULL REFERENCES paquetes_monedas(id),
    coins_entregados INT NOT NULL,
    precio_pagado DECIMAL(10,2) NOT NULL,
    estado estado_orden NOT NULL DEFAULT 'pendiente',
    comprobante VARCHAR(1024),
    creado_en TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Streams
CREATE TABLE streams (
    id SERIAL PRIMARY KEY,
    streamer_id INT NOT NULL REFERENCES perfiles_streamer(id),
    titulo VARCHAR(255) NOT NULL,
    descripcion TEXT,
    estado estado_stream NOT NULL DEFAULT 'programado',
    programado_en TIMESTAMP,
    inicio_en TIMESTAMP,
    fin_en TIMESTAMP,
    thumbnail_url VARCHAR(1024)
);

CREATE TABLE sesiones_stream (
    id SERIAL PRIMARY KEY,
    stream_id INT NOT NULL REFERENCES streams(id),
    inicio TIMESTAMP NOT NULL,
    fin TIMESTAMP,
    duracion_horas DECIMAL(10,2)
);

-- Reglas de nivel
CREATE TABLE reglas_nivel_streamer (
    id SERIAL PRIMARY KEY,
    streamer_id INT NOT NULL REFERENCES perfiles_streamer(id),
    nivel INT NOT NULL,
    horas_requeridas DECIMAL(10,2) NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (streamer_id, nivel)
);

CREATE TABLE reglas_nivel_viewer (
    id SERIAL PRIMARY KEY,
    nivel INT NOT NULL UNIQUE,
    puntos_requeridos INT NOT NULL,
    recompensa_coins INT NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE
);

-- Relaciones viewer/streamer
CREATE TABLE seguimientos (
    viewer_id INT NOT NULL REFERENCES perfiles_viewer(id),
    streamer_id INT NOT NULL REFERENCES perfiles_streamer(id),
    creado_en TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (viewer_id, streamer_id)
);

CREATE TABLE suscripciones (
    id SERIAL PRIMARY KEY,
    viewer_id INT NOT NULL REFERENCES perfiles_viewer(id),
    streamer_id INT NOT NULL REFERENCES perfiles_streamer(id),
    tier VARCHAR(50) NOT NULL,
    precio_mensual DECIMAL(10,2) NOT NULL,
    estado estado_suscripcion NOT NULL DEFAULT 'activa',
    inicio TIMESTAMP NOT NULL DEFAULT NOW(),
    fin TIMESTAMP,
    auto_renovar BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE roles_canal (
    id SERIAL PRIMARY KEY,
    streamer_id INT NOT NULL REFERENCES perfiles_streamer(id),
    viewer_id INT NOT NULL REFERENCES perfiles_viewer(id),
    rol VARCHAR(10) NOT NULL CHECK (rol IN ('mod','vip','sub')),
    asignado_en TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (streamer_id, viewer_id, rol)
);

-- Regalos
CREATE TABLE regalos (
    id SERIAL PRIMARY KEY,
    streamer_id INT REFERENCES perfiles_streamer(id),
    nombre VARCHAR(255) NOT NULL,
    costo_usd DECIMAL(10,2),
    costo_coins INT NOT NULL,
    puntos_otorgados INT NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE envios_regalo (
    id SERIAL PRIMARY KEY,
    gift_id INT NOT NULL REFERENCES regalos(id),
    stream_id INT NOT NULL REFERENCES streams(id),
    remitente_id INT NOT NULL REFERENCES perfiles_viewer(id),
    streamer_id INT NOT NULL REFERENCES perfiles_streamer(id),
    cantidad INT NOT NULL,
    coins_gastados INT NOT NULL,
    puntos_generados INT NOT NULL,
    mensaje TEXT,
    creado_en TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Chat
CREATE TABLE mensajes_chat (
    id SERIAL PRIMARY KEY,
    stream_id INT NOT NULL REFERENCES streams(id),
    usuario_id INT NOT NULL REFERENCES usuarios(id),
    tipo tipo_msg_chat NOT NULL,
    mensaje TEXT,
    gift_id INT REFERENCES regalos(id),
    envio_regalo_id INT REFERENCES envios_regalo(id),
    badge badge_chat NOT NULL DEFAULT 'none',
    nivel_usuario INT,
    creado_en TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Índices sugeridos
-- No obligatorio es solo para agilizar la busqueda de base cada tabla , ven ustedes si lo usan 
CREATE INDEX idx_streams_streamer_estado ON streams (streamer_id, estado);
CREATE INDEX idx_sesiones_stream_stream ON sesiones_stream (stream_id, inicio);
CREATE INDEX idx_suscripciones_viewer_streamer ON suscripciones (viewer_id, streamer_id, estado);
CREATE INDEX idx_envios_regalo_stream ON envios_regalo (stream_id, creado_en);
CREATE INDEX idx_mensajes_chat_stream ON mensajes_chat (stream_id, creado_en);
CREATE INDEX idx_mov_billetera_billetera ON movimientos_billetera (billetera_id, creado_en);










--Datos Preseteado para que ven si se pueden leer o alterar correctamente, lo dejare el blanco al final, solo usenlo para validar datos , no harcodeen nada
-- Usuarios
INSERT INTO usuarios (id, email, password_hash, nombre, rol, estado) VALUES
 (1,'fabrizio@stream.app','$2y$10$hash','fabrizio','streamer','activo'),
 (2,'pri@stream.app','$2y$10$hash','pri','espectador','activo'),
 (3,'yadira@stream.app','$2y$10$hash','yadira','espectador','activo');

-- Perfiles
INSERT INTO perfiles_streamer (id, usuario_id, canal_slug, titulo_canal, bio, nivel_actual, horas_totales, ultimo_stream_en) VALUES
 (1,1,'ana-stream','Café y Código','Streaming diario',3,120.5,'2024-06-01 10:05');

INSERT INTO perfiles_viewer (id, usuario_id, nivel_actual, puntos, horas_vistas, saldo_coins) VALUES
 (1,2,4,850,55.5,300),
 (2,3,2,150,12.0,120);

-- Billeteras
INSERT INTO billeteras (id, usuario_id, saldo_coins) VALUES
 (1,1,5000),
 (2,2,300),
 (3,3,120);

-- Paquetes y moenedas
INSERT INTO paquetes_monedas (id, nombre, coins, precio, moneda, activo) VALUES
 (1,'Starter 500',500,4.99,'USD',TRUE),
 (2,'Pro 2000',2000,14.99,'USD',TRUE);

INSERT INTO ordenes_monedas (id, usuario_id, paquete_id, coins_entregados, precio_pagado, estado, comprobante) VALUES
 (1,2,1,500,4.99,'pagado','recibo-001.png');

-- Streams y sesiones
INSERT INTO streams (id, streamer_id, titulo, descripcion, estado, programado_en, inicio_en, fin_en, thumbnail_url) VALUES
 (1,1,'Mañana de Rust','Construyendo un CLI','en_vivo','2024-06-01 10:00','2024-06-01 10:05',NULL,'https://picsum.photos/id/237/600/400.jpg
'),
 (2,1,'Noche de Go','API y tests','programado','2024-06-05 20:00',NULL,NULL,'https://picsum.photos/600/400
');

INSERT INTO sesiones_stream (id, stream_id, inicio, fin, duracion_horas) VALUES
 (1,1,'2024-06-01 10:05','2024-06-01 12:15',2.17);

-- Reglas de nivel
INSERT INTO reglas_nivel_streamer (id, streamer_id, nivel, horas_requeridas, activo) VALUES
 (1,1,4,160.0,TRUE);

INSERT INTO reglas_nivel_viewer (id, nivel, puntos_requeridos, recompensa_coins, activo) VALUES
 (1,5,1000,100,TRUE);

-- Seguimientos y suscripciones
INSERT INTO seguimientos (viewer_id, streamer_id, creado_en) VALUES
 (1,1,NOW()),
 (2,1,NOW());

INSERT INTO suscripciones (id, viewer_id, streamer_id, tier, precio_mensual, estado, inicio, auto_renovar) VALUES
 (1,1,1,'Tier1',4.99,'activa',NOW(),TRUE);

-- Roles de canal
INSERT INTO roles_canal (id, streamer_id, viewer_id, rol, asignado_en) VALUES
 (1,1,1,'mod',NOW()),
 (2,1,2,'vip',NOW());

-- Regalos y envíos
INSERT INTO regalos (id, streamer_id, nombre, costo_usd, costo_coins, puntos_otorgados, activo) VALUES
 (1,1,'Cafecito',1.99,200,20,TRUE),
 (2,1,'Super Like',NULL,50,5,TRUE);

INSERT INTO envios_regalo (id, gift_id, stream_id, remitente_id, streamer_id, cantidad, coins_gastados, puntos_generados, mensaje, creado_en) VALUES
 (1,1,1,1,1,1,200,20,'¡Buen stream!',NOW()),
 (2,2,1,2,1,3,150,15,'Vamos Ana!',NOW());

-- Movimientos de billetera 
INSERT INTO movimientos_billetera (id, billetera_id, tipo, monto, referencia_tipo, referencia_id, creado_en) VALUES
 (1,2,'recarga',4.99,'orden_monedas',1,NOW()),
 (2,2,'regalo',-200,'envio_regalo',2,NOW()),
 (3,1,'regalo',200,'envio_regalo',1,NOW());

-- Chat
INSERT INTO mensajes_chat (id, stream_id, usuario_id, tipo, mensaje, gift_id, envio_regalo_id, badge, nivel_usuario, creado_en) VALUES
 (1,1,2,'texto','Hola desde el chat',NULL,NULL,'none',4,NOW()),
 (2,1,2,'regalo','Envió Cafecito',1,1,'sub',4,NOW()),
 (3,1,3,'texto','Saludos a todos',NULL,NULL,'none',2,NOW());


