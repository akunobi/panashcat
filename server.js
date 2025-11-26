const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Pool } = require('pg');

// 1. CONFIGURACIÓN DEL SERVIDOR
const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  maxHttpBufferSize: 50 * 1024 * 1024, // 50MB para imágenes
  transports: ['websocket', 'polling'],
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000; 

// 2. CONFIGURACIÓN DE USUARIOS
// Esta lista asegura que puedas enviar DMs a gente offline
const ALL_USERS = ['Rafa', 'Hugo', 'Sergio', 'Álvaro'];
const onlineUsers = new Set();

// 3. CONEXIÓN A BASE DE DATOS
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- INICIALIZACIÓN DE TABLAS ---
async function setupDatabase() {
  try {
    console.log('--- Iniciando y Verificando Base de Datos ---');
    
    // A. Tabla de Mensajes Globales
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

    // B. Tabla de Mensajes Privados
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
    
    // C. Parches de seguridad para columnas faltantes
    try { await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text'`); } catch(e){}
    try { await db.query(`ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text'`); } catch(e){}

    console.log('✅ Base de datos lista y operativa.');
  } catch (err) {
    console.error('❌ Error crítico en DB:', err);
  }
}
setupDatabase();

// Servir archivos estáticos
app.use('/images', express.static(path.join(__dirname, 'images')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Función auxiliar para actualizar la lista de usuarios en tiempo real
function broadcastUserList() {
    const list = ALL_USERS.map(u => ({
        name: u,
        isOnline: onlineUsers.has(u)
    }));
    io.emit('update_user_list', list);
}

// 4. LÓGICA DE SOCKETS
io.on('connection', (socket) => {
  console.log(`🔌 Cliente conectado: ${socket.id}`);

  // --- LOGIN ---
  socket.on('login', (username) => {
    if (!username) return;

    console.log(`👤 Login: ${username}`);
    socket.username = username;
    
    // CRÍTICO: Unir al usuario a una sala con su nombre exacto
    // Esto permite el routing de mensajes privados en tiempo real
    socket.join(username);
    onlineUsers.add(username);
    
    // Confirmar al cliente
    socket.emit('login_success', username);
    
    // Actualizar estados (verde/gris) para todos
    broadcastUserList();
  });

  // --- UNIRSE A CHAT / CARGAR HISTORIAL ---
  socket.on('join_chat', async ({ target }) => {
    if (!socket.username) return;
    
    // Cargar últimos 30 días
    const limit = Math.floor(Date.now() / 1000) - (86400 * 30); 

    try {
        let history = [];

        if (target === 'global') {
            // Historial Global
            const res = await db.query(
                `SELECT * FROM messages WHERE timestamp > $1 ORDER BY id ASC`, 
                [limit]
            );
            history = res.rows.map(r => ({
                id: r.id, user: r.user_name, text: r.text, timestamp: r.timestamp, 
                replyTo: r.reply_to_id, type: r.message_type, isPrivate: false
            }));

        } else {
            // Historial Privado
            // Traemos mensajes donde (Yo soy Emisor Y Tú Receptor) O (Yo Receptor Y Tú Emisor)
            const res = await db.query(`
                SELECT * FROM direct_messages 
                WHERE timestamp > $1 
                AND ((sender=$1 AND receiver=$2) OR (sender=$2 AND receiver=$1))
                ORDER BY id ASC`, 
                [socket.username, target]
            );
            
            history = res.rows.map(r => ({
                id: r.id, 
                user: r.sender, 
                text: r.text, 
                timestamp: r.timestamp, 
                replyTo: r.reply_to_id, 
                type: r.message_type, 
                isPrivate: true, 
                receiver: r.receiver
            }));
        }
        
        // Enviamos historial
        socket.emit('chat_history', { history, context: target });

    } catch (err) { console.error("Error Historial:", err); }
  });

  // --- ENVIAR MENSAJE (LÓGICA REAL-TIME CORREGIDA) ---
  socket.on('chat_message', async (data) => {
    if (!socket.username) return;

    const { text, type, replyTo, target } = data;
    const ts = Math.floor(Date.now() / 1000);

    console.log(`📩 Enviando: ${socket.username} -> ${target}`);

    try {
        if (target === 'global') {
            // --- CASO GLOBAL ---
            const res = await db.query(
                `INSERT INTO messages (user_name, text, timestamp, reply_to_id, message_type) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                [socket.username, text, ts, replyTo, type]
            );
            const msg = { id: res.rows[0].id, user: socket.username, text, timestamp: ts, replyTo, type, isPrivate: false };
            
            // Enviar a todos los conectados
            io.emit('chat_message', msg);

        } else {
            // --- CASO PRIVADO (DM) ---
            const res = await db.query(
                `INSERT INTO direct_messages (sender, receiver, text, timestamp, reply_to_id, message_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [socket.username, target, text, ts, replyTo, type]
            );
            
            const msg = { id: res.rows[0].id, user: socket.username, text, timestamp: ts, replyTo, type, isPrivate: true, receiver: target };
            
            // AQUÍ ESTÁ LA CORRECCIÓN DE TIEMPO REAL:
            // 1. Enviamos el mensaje a la sala del DESTINATARIO
            io.to(target).emit('chat_message', msg);
            
            // 2. Enviamos el mensaje a la sala del REMITENTE (TÚ)
            // Esto garantiza que veas tu propio mensaje inmediatamente sin recargar
            io.to(socket.username).emit('chat_message', msg);
        }
    } catch(e) { console.error("Error guardando mensaje:", e); }
  });

  // --- BORRAR MENSAJE ---
  socket.on('delete_message', async (id) => {
      try {
        await db.query(`DELETE FROM messages WHERE id=$1 AND user_name=$2`, [id, socket.username]);
        await db.query(`DELETE FROM direct_messages WHERE id=$1 AND sender=$2`, [id, socket.username]);
        io.emit('message_deleted', id);
      } catch(e){}
  });

  // --- LIMPIAR CHAT ---
  socket.on('clear_chat', async () => {
      if(!socket.username) return;
      await db.query('DELETE FROM messages');
      io.emit('chat_cleared');
  });

  // --- ESTADOS ---
  socket.on('typing', () => socket.broadcast.emit('user_typing', socket.username));
  socket.on('stop_typing', () => socket.broadcast.emit('user_stop_typing', socket.username));
  
  // --- DESCONEXIÓN ---
  socket.on('disconnect', () => {
    if (socket.username) {
        onlineUsers.delete(socket.username);
        broadcastUserList();
    }
  });
});

server.listen(PORT, () => console.log(`🚀 Servidor OK en puerto ${PORT}`));