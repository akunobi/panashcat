// ==========================================
// 1. IMPORTACIONES Y CONFIGURACIÓN BÁSICA
// ==========================================
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Pool } = require('pg');

// Inicializamos la aplicación Express
const app = express();
const server = http.createServer(app);

// Configuración de Socket.IO
const io = new Server(server, { 
  // Aumentamos el límite para permitir enviar imágenes de hasta 50MB
  maxHttpBufferSize: 50 * 1024 * 1024, 
  transports: ['websocket', 'polling'], // Soporte para redes restrictivas
  cors: { origin: "*" } // Permitir conexiones desde cualquier origen
});

// Puerto del servidor (variable de entorno o 3000 por defecto)
const PORT = process.env.PORT || 3000; 

// ==========================================
// 2. GESTIÓN DE USUARIOS
// ==========================================

// Lista fija de usuarios permitidos. 
// Esto permite que aparezcan en la lista aunque estén desconectados (Offline).
const ALL_USERS = ['Rafa', 'Hugo', 'Sergio', 'Álvaro'];

// Conjunto para rastrear quién está conectado en tiempo real
const onlineUsers = new Set();

// ==========================================
// 3. BASE DE DATOS (PostgreSQL)
// ==========================================
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Necesario para conexiones seguras en la nube
});

// Función para inicializar las tablas al arrancar
async function setupDatabase() {
  try {
    console.log('--- 🛠️  Iniciando configuración de Base de Datos ---');
    
    // A. Crear tabla de Mensajes Globales
    await db.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        user_name TEXT,
        text TEXT,
        timestamp BIGINT,
        reply_to_id INTEGER,
        message_type TEXT DEFAULT 'text'
      );
    `);

    // B. Crear tabla de Mensajes Directos (Privados)
    await db.query(`
      CREATE TABLE IF NOT EXISTS direct_messages (
        id SERIAL PRIMARY KEY,
        sender TEXT,
        receiver TEXT,
        text TEXT,
        timestamp BIGINT,
        reply_to_id INTEGER,
        message_type TEXT DEFAULT 'text'
      );
    `);
    
    // C. Parches de seguridad: Asegurar que las columnas nuevas existan
    // Esto evita errores si la base de datos fue creada con una versión antigua del script
    try { await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text'`); } catch(e){}
    try { await db.query(`ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text'`); } catch(e){}

    console.log('✅ Base de datos lista y tablas verificadas.');
  } catch (err) {
    console.error('❌ Error fatal al configurar la DB:', err);
  }
}
// Ejecutar la configuración
setupDatabase();

// ==========================================
// 4. SERVIDOR WEB
// ==========================================

// Servir la carpeta de imágenes estáticas
app.use('/images', express.static(path.join(__dirname, 'images')));

// Servir la página principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Función auxiliar para enviar la lista de usuarios actualizada a todos
function broadcastUserList() {
    // Mapeamos la lista fija y comprobamos si están en el Set de onlineUsers
    const list = ALL_USERS.map(u => ({
        name: u,
        isOnline: onlineUsers.has(u)
    }));
    io.emit('update_user_list', list);
}

// ==========================================
// 5. LÓGICA DE SOCKETS (CHAT)
// ==========================================
io.on('connection', (socket) => {
  console.log(`🔌 Cliente conectado: ${socket.id}`);

  // --- EVENTO: LOGIN ---
  socket.on('login', (username) => {
    if (!username) return;

    console.log(`👤 Usuario logueado: ${username}`);
    socket.username = username;
    
    // IMPORTANTE: Unimos al socket a una sala con su propio nombre.
    // Esto nos permite enviarle mensajes privados usando io.to(nombre).
    socket.join(username); 
    
    // Lo añadimos a la lista de conectados
    onlineUsers.add(username);
    
    // 1. Confirmamos al usuario que el login fue exitoso
    socket.emit('login_success', username);
    
    // 2. Actualizamos la lista para todos (para que vean el punto verde)
    broadcastUserList();
  });

  // --- EVENTO: UNIRSE A UN CHAT (Cargar Historial) ---
  socket.on('join_chat', async ({ target }) => {
    if (!socket.username) return;
    
    // Cargar mensajes de los últimos 30 días
    const limit = Math.floor(Date.now() / 1000) - (86400 * 30); 

    try {
        let history = [];

        if (target === 'global') {
            // --- Historial Global ---
            const res = await db.query(
                `SELECT * FROM messages WHERE timestamp > $1 ORDER BY id ASC`, 
                [limit]
            );
            
            // Formateamos los datos para el cliente
            history = res.rows.map(row => ({
                id: row.id,
                user: row.user_name,
                text: row.text,
                timestamp: row.timestamp,
                replyTo: row.reply_to_id, // Normalizamos nombre
                type: row.message_type,   // Normalizamos nombre
                isPrivate: false
            }));

        } else {
            // --- Historial Privado ---
            // Seleccionamos mensajes donde:
            // (Yo soy el que envía Y Tú recibes) O (Tú envías Y Yo recibo)
            const res = await db.query(`
                SELECT * FROM direct_messages 
                WHERE timestamp > $1 
                AND ((sender=$1 AND receiver=$2) OR (sender=$2 AND receiver=$1))
                ORDER BY id ASC`, 
                [socket.username, target]
            );
            
            history = res.rows.map(row => ({
                id: row.id,
                user: row.sender,
                text: row.text,
                timestamp: row.timestamp,
                replyTo: row.reply_to_id,
                type: row.message_type,
                isPrivate: true,
                receiver: row.receiver
            }));
        }
        
        // Enviamos el historial al usuario que lo solicitó
        socket.emit('chat_history', { history, context: target });

    } catch (err) {
        console.error("Error recuperando historial:", err);
    }
  });

  // --- EVENTO: ENVIAR MENSAJE (Aquí está la corrección clave) ---
  socket.on('chat_message', async (data) => {
    if (!socket.username) return;

    const { text, type, replyTo, target } = data;
    const ts = Math.floor(Date.now() / 1000);

    console.log(`📩 Mensaje de ${socket.username} para ${target}`);

    try {
        if (target === 'global') {
            // --- MENSAJE GLOBAL ---
            const res = await db.query(
                `INSERT INTO messages (user_name, text, timestamp, reply_to_id, message_type) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                [socket.username, text, ts, replyTo, type]
            );
            
            const msg = { 
                id: res.rows[0].id, 
                user: socket.username, 
                text, timestamp: ts, 
                replyTo, type, isPrivate: false 
            };
            
            // Enviar a TODOS los conectados
            io.emit('chat_message', msg);

        } else {
            // --- MENSAJE PRIVADO (DM) ---
            // 1. Guardar en base de datos
            const res = await db.query(
                `INSERT INTO direct_messages (sender, receiver, text, timestamp, reply_to_id, message_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [socket.username, target, text, ts, replyTo, type]
            );
            
            const msg = { 
                id: res.rows[0].id, 
                user: socket.username, 
                text, timestamp: ts, 
                replyTo, type, isPrivate: true, 
                receiver: target 
            };
            
            // 2. Enviar al DESTINATARIO (a su sala personal)
            io.to(target).emit('chat_message', msg);
            
            // 3. Enviar al REMITENTE (a ti mismo, para que aparezca en tu pantalla)
            // Usamos io.to(tu_nombre) en vez de socket.emit para asegurar consistencia
            io.to(socket.username).emit('chat_message', msg);
        }
    } catch(e) {
        console.error("Error guardando mensaje:", e);
    }
  });

  // --- EVENTO: BORRAR MENSAJE ---
  socket.on('delete_message', async (id) => {
      try {
        // Intentar borrar de ambas tablas (solo si el usuario es el dueño)
        await db.query(`DELETE FROM messages WHERE id=$1 AND user_name=$2`, [id, socket.username]);
        await db.query(`DELETE FROM direct_messages WHERE id=$1 AND sender=$2`, [id, socket.username]);
        
        // Notificar a todos que se borró el mensaje
        io.emit('message_deleted', id);
      } catch(e) { console.error(e); }
  });

  // --- EVENTO: LIMPIAR CHAT (Solo Global) ---
  socket.on('clear_chat', async () => {
      if(!socket.username) return;
      await db.query('DELETE FROM messages');
      io.emit('chat_cleared');
      io.emit('system_message', `${socket.username} ha limpiado el chat global.`);
  });

  // --- EVENTOS DE ESTADO (Escribiendo...) ---
  socket.on('typing', () => socket.broadcast.emit('user_typing', socket.username));
  socket.on('stop_typing', () => socket.broadcast.emit('user_stop_typing', socket.username));
  
  // --- EVENTO: DESCONEXIÓN ---
  socket.on('disconnect', () => {
    if (socket.username) {
        console.log(`❌ Usuario desconectado: ${socket.username}`);
        onlineUsers.delete(socket.username);
        // Actualizar lista (se pondrá en gris)
        broadcastUserList();
    }
  });
});

// Arrancar el servidor
server.listen(PORT, () => {
  console.log(`🚀 Servidor funcionando en el puerto ${PORT}`);
});