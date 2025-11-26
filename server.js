const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Pool } = require('pg');

// 1. Configuración del Servidor
const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  maxHttpBufferSize: 50 * 1024 * 1024, // 50MB
  transports: ['websocket', 'polling'], // Forzamos compatibilidad
  cors: { origin: "*" }
});
const PORT = process.env.PORT || 3000; 

// 2. Estado de usuarios (Memoria)
const onlineUsers = new Set();

// 3. Base de Datos
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function setupDatabase() {
  try {
    console.log('--- Iniciando DB ---');
    // Tabla Global
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
    // Tabla Privada
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
    // Columnas extra si faltan
    try { await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text'`); } catch(e){}
    try { await db.query(`ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text'`); } catch(e){}
    console.log('✅ DB Lista.');
  } catch (err) {
    console.error('❌ Error DB:', err);
  }
}
setupDatabase();

app.use('/images', express.static(path.join(__dirname, 'images')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// 4. Lógica de Sockets
io.on('connection', (socket) => {
  console.log(`🔌 Nuevo cliente: ${socket.id}`);

  // --- LOGIN (SIMPLIFICADO) ---
  socket.on('request_login', (username) => {
    console.log(`🔑 Intento de login: ${username}`);
    
    if (!username) return;

    socket.username = username;
    onlineUsers.add(username);
    socket.join(username); // Sala personal para DMs

    // ENVIAMOS CONFIRMACIÓN EXPLÍCITA
    socket.emit('login_approved', username);
    
    // Avisar a todos
    io.emit('update_user_list', Array.from(onlineUsers));
  });

  // --- UNIRSE A CHAT ---
  socket.on('join_chat_room', async ({ target, type }) => {
    if (!socket.username) return;
    const timeLimit = Math.floor(Date.now() / 1000) - 1209600; // 2 semanas

    try {
        let rows = [];
        if (type === 'global') {
            const res = await db.query(`SELECT * FROM messages WHERE timestamp > $1 ORDER BY id ASC`, [timeLimit]);
            rows = res.rows.map(r => ({...r, user: r.user_name, isPrivate: false}));
        } else {
            const res = await db.query(`
                SELECT * FROM direct_messages 
                WHERE timestamp > $1 AND ((sender=$2 AND receiver=$3) OR (sender=$3 AND receiver=$2))
                ORDER BY id ASC`, [timeLimit, socket.username, target]);
            rows = res.rows.map(r => ({...r, user: r.sender, isPrivate: true}));
        }
        socket.emit('chat_history', { messages: rows, context: target || 'global' });
    } catch(e) { console.error(e); }
  });

  // --- ENVIAR MENSAJE ---
  socket.on('send_message', async (data) => {
    if (!socket.username) return;
    const { text, type, replyTo, targetUser } = data;
    const ts = Math.floor(Date.now() / 1000);

    try {
        if (targetUser && targetUser !== 'global') {
            // Privado
            const res = await db.query(
                `INSERT INTO direct_messages (sender, receiver, text, timestamp, reply_to_id, message_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [socket.username, targetUser, text, ts, replyTo, type]
            );
            const packet = { id: res.rows[0].id, user: socket.username, text, timestamp: ts, reply_to_id: replyTo, type, isPrivate: true, receiver: targetUser };
            io.to(socket.username).to(targetUser).emit('receive_message', packet);
        } else {
            // Global
            const res = await db.query(
                `INSERT INTO messages (user_name, text, timestamp, reply_to_id, message_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [socket.username, text, ts, replyTo, type]
            );
            const packet = { id: res.rows[0].id, user: socket.username, text, timestamp: ts, reply_to_id: replyTo, type, isPrivate: false };
            io.emit('receive_message', packet);
        }
    } catch(e) { console.error(e); }
  });

  // --- BORRAR ---
  socket.on('delete_msg', async (id) => {
      try {
          await db.query(`DELETE FROM messages WHERE id=$1 AND user_name=$2`, [id, socket.username]);
          await db.query(`DELETE FROM direct_messages WHERE id=$1 AND sender=$2`, [id, socket.username]);
          io.emit('msg_deleted', id);
      } catch(e){}
  });

  socket.on('disconnect', () => {
    if (socket.username) {
        onlineUsers.delete(socket.username);
        io.emit('update_user_list', Array.from(onlineUsers));
    }
  });
});

server.listen(PORT, () => console.log(`🚀 Servidor OK en puerto ${PORT}`));