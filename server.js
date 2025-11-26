const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Pool } = require('pg');

// ---- Configuración Inicial ----
const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  maxHttpBufferSize: 50 * 1024 * 1024, // 50MB
  transports: ['websocket'], 
  upgrade: false 
});
const PORT = process.env.PORT || 3000; 

// ---- Estado ----
const onlineUsers = new Set();

// ---- Base de Datos ----
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function setupDatabase() {
  try {
    console.log('--- Configurando Base de Datos ---');
    
    // 1. Tabla Global
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

    // 2. Tabla Privada
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
    
    // Parches de compatibilidad
    try { await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text'`); } catch(e){}
    try { await db.query(`ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text'`); } catch(e){}

    console.log('✅ Base de datos lista.');
  } catch (err) {
    console.error('❌ Error DB:', err);
  }
}
setupDatabase();

// Servir archivos estáticos
app.use('/images', express.static(path.join(__dirname, 'images')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ---- Lógica Sockets ----
io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);

  // 1. LOGIN (MÉTODO ROBUSTO SIN CALLBACKS)
  socket.on('login', (username) => {
    if (!username) return;

    socket.username = username;
    
    // Unir a sala propia
    socket.join(username);
    onlineUsers.add(username);
    
    // ENVIAR EVENTO DE ÉXITO AL CLIENTE
    socket.emit('login success', username);
    
    // Avisar a los demás
    io.emit('update user list', Array.from(onlineUsers));
    io.emit('system message', `${username} ha entrado.`);
  });

  // 2. UNIRSE A CHAT / PEDIR HISTORIAL
  socket.on('join chat', async ({ target, type }) => {
    if (!socket.username) return;
    const timeLimit = Math.floor(Date.now() / 1000) - 1209600; // 2 semanas
    
    try {
        let messages = [];

        if (type === 'global') {
            // Historial Global
            const res = await db.query(
                `SELECT * FROM messages WHERE timestamp > $1 ORDER BY id ASC`, 
                [timeLimit]
            );
            messages = res.rows.map(row => ({
                id: row.id,
                user: row.user_name,
                text: row.text,
                timestamp: row.timestamp,
                reply_to_id: row.reply_to_id,
                type: row.message_type || 'text',
                isPrivate: false
            }));

        } else if (type === 'private') {
            // Historial Privado
            const res = await db.query(
                `SELECT * FROM direct_messages 
                 WHERE timestamp > $1 
                 AND ( (sender=$2 AND receiver=$3) OR (sender=$3 AND receiver=$2) )
                 ORDER BY id ASC`,
                [timeLimit, socket.username, target]
            );
            messages = res.rows.map(row => ({
                id: row.id,
                user: row.sender,
                text: row.text,
                timestamp: row.timestamp,
                reply_to_id: row.reply_to_id,
                type: row.message_type || 'text',
                isPrivate: true,
                receiver: row.receiver
            }));
        }
        
        socket.emit('chat history', { messages, context: target || 'global' });

    } catch (err) { console.error(err); }
  });

  // 3. ENVIAR MENSAJE (Texto)
  socket.on('chat message', async (text, replyToId, targetUser) => {
    if (!socket.username) return;
    const ts = Math.floor(Date.now() / 1000);

    try {
        if (targetUser && targetUser !== 'global') {
            // Privado
            const res = await db.query(
                `INSERT INTO direct_messages (sender, receiver, text, timestamp, reply_to_id, message_type) VALUES ($1, $2, $3, $4, $5, 'text') RETURNING id`,
                [socket.username, targetUser, text, ts, replyToId]
            );
            const packet = { id: res.rows[0].id, user: socket.username, text, timestamp: ts, reply_to_id: replyToId, type: 'text', isPrivate: true, receiver: targetUser };
            io.to(socket.username).to(targetUser).emit('chat message', packet);

        } else {
            // Global
            const res = await db.query(
                `INSERT INTO messages (user_name, text, timestamp, reply_to_id, message_type) VALUES ($1, $2, $3, $4, 'text') RETURNING id`,
                [socket.username, text, ts, replyToId]
            );
            const packet = { id: res.rows[0].id, user: socket.username, text, timestamp: ts, reply_to_id: replyToId, type: 'text', isPrivate: false };
            io.emit('chat message', packet);
        }
    } catch(e) { console.error(e); }
  });

  // 4. ENVIAR IMAGEN
  socket.on('chat image', async (imgData, replyToId, targetUser) => {
    if (!socket.username) return;
    const ts = Math.floor(Date.now() / 1000);
    try {
        if (targetUser && targetUser !== 'global') {
             // Privado
             const res = await db.query(
                `INSERT INTO direct_messages (sender, receiver, text, timestamp, reply_to_id, message_type) VALUES ($1, $2, $3, $4, $5, 'image') RETURNING id`,
                [socket.username, targetUser, imgData, ts, replyToId]
             );
             const packet = { id: res.rows[0].id, user: socket.username, text: imgData, timestamp: ts, reply_to_id: replyToId, type: 'image', isPrivate: true, receiver: targetUser };
             io.to(socket.username).to(targetUser).emit('chat message', packet);
        } else {
             // Global
             const res = await db.query(
                `INSERT INTO messages (user_name, text, timestamp, reply_to_id, message_type) VALUES ($1, $2, $3, $4, 'image') RETURNING id`,
                [socket.username, imgData, ts, replyToId]
             );
             const packet = { id: res.rows[0].id, user: socket.username, text: imgData, timestamp: ts, reply_to_id: replyToId, type: 'image', isPrivate: false };
             io.emit('chat message', packet);
        }
    } catch(e) { console.error(e); }
  });

  // 5. BORRAR MENSAJE
  socket.on('delete message', async (id) => {
      try {
        await db.query(`DELETE FROM messages WHERE id=$1 AND user_name=$2`, [id, socket.username]);
        await db.query(`DELETE FROM direct_messages WHERE id=$1 AND sender=$2`, [id, socket.username]);
        io.emit('message deleted', id);
      } catch(e) {}
  });

  // 6. LIMPIAR (Solo global)
  socket.on('clear chat request', async () => {
      if(!socket.username) return;
      await db.query('DELETE FROM messages');
      io.emit('chat cleared');
  });

  socket.on('typing', () => socket.broadcast.emit('user typing', socket.username));
  socket.on('stop typing', () => socket.broadcast.emit('user stop typing', socket.username));
  
  socket.on('disconnect', () => {
    if (socket.username) {
        onlineUsers.delete(socket.username);
        io.emit('update user list', Array.from(onlineUsers));
    }
  });
});

server.listen(PORT, () => console.log(`🚀 Server OK en puerto ${PORT}`));