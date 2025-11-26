const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Pool } = require('pg');

// 1. Configuración del Servidor
const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  maxHttpBufferSize: 50 * 1024 * 1024, // 50MB para imágenes
  transports: ['websocket', 'polling'],
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000; 

// 2. Configuración de Usuarios (Fija para que siempre aparezcan)
const ALL_USERS = ['Rafa', 'Hugo', 'Sergio', 'Álvaro'];
const onlineUsers = new Set();

// 3. Base de Datos
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- INICIALIZACIÓN DE DB ---
async function setupDatabase() {
  try {
    console.log('--- Verificando Base de Datos ---');
    
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

    // Tabla Privada (DMs)
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
    
    // Parches de seguridad por si las columnas no existen
    try { await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text'`); } catch(e){}
    try { await db.query(`ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text'`); } catch(e){}

    console.log('✅ Base de datos lista y tablas verificadas.');
  } catch (err) {
    console.error('❌ Error fatal en DB:', err);
  }
}
setupDatabase();

// Servir archivos
app.use('/images', express.static(path.join(__dirname, 'images')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Función auxiliar para enviar lista de usuarios con estado
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

    console.log(`🔑 Login solicitado: ${username}`);
    socket.username = username;
    
    // Unimos al usuario a su sala personal (para recibir DMs)
    socket.join(username);
    onlineUsers.add(username);
    
    // 1. Confirmamos al usuario que entró
    socket.emit('login_success', username);
    
    // 2. Actualizamos la lista para todos (verde/gris)
    broadcastUserList();
  });

  // --- UNIRSE A CHAT (HISTORIAL) ---
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
            history = res.rows.map(row => ({
                id: row.id, user: row.user_name, text: row.text, timestamp: row.timestamp,
                reply_to_id: row.reply_to_id, message_type: row.message_type, isPrivate: false
            }));

        } else {
            // Historial Privado (Mensajes entre YO y TARGET)
            const res = await db.query(
                `SELECT * FROM direct_messages 
                 WHERE timestamp > $1 
                 AND ( (sender=$2 AND receiver=$3) OR (sender=$3 AND receiver=$2) )
                 ORDER BY id ASC`,
                [limit, socket.username, target]
            );

            history = res.rows.map(row => ({
                id: row.id, user: row.sender, text: row.text, timestamp: row.timestamp,
                reply_to_id: row.reply_to_id, message_type: row.message_type, isPrivate: true, receiver: row.receiver
            }));
        }
        
        socket.emit('chat_history', { history, context: target });

    } catch (err) { console.error("Error Historial:", err); }
  });

  // --- ENVIAR MENSAJE ---
  socket.on('chat_message', async (data) => {
    if (!socket.username) return;

    const { text, type, replyTo, target } = data;
    const ts = Math.floor(Date.now() / 1000);

    console.log(`📩 De ${socket.username} para ${target}`);

    try {
        if (target === 'global') {
            // Guardar Global
            const res = await db.query(
                `INSERT INTO messages (user_name, text, timestamp, reply_to_id, message_type) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                [socket.username, text, ts, replyTo, type]
            );
            const msg = { id: res.rows[0].id, user: socket.username, text, timestamp: ts, reply_to_id: replyTo, message_type: type, isPrivate: false };
            io.emit('chat_message', msg);

        } else {
            // Guardar Privado
            const res = await db.query(
                `INSERT INTO direct_messages (sender, receiver, text, timestamp, reply_to_id, message_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [socket.username, target, text, ts, replyTo, type]
            );
            const msg = { id: res.rows[0].id, user: socket.username, text, timestamp: ts, reply_to_id: replyTo, message_type: type, isPrivate: true, receiver: target };
            
            // Enviar a la sala del REMITENTE y del DESTINATARIO
            io.to(socket.username).to(target).emit('chat_message', msg);
        }
    } catch(e) { console.error("Error Mensaje:", e); }
  });

  // --- BORRAR MENSAJE ---
  socket.on('delete_message', async (id) => {
      try {
        await db.query(`DELETE FROM messages WHERE id=$1 AND user_name=$2`, [id, socket.username]);
        await db.query(`DELETE FROM direct_messages WHERE id=$1 AND sender=$2`, [id, socket.username]);
        io.emit('message_deleted', id);
      } catch(e) {}
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
  
  socket.on('disconnect', () => {
    if (socket.username) {
        onlineUsers.delete(socket.username);
        broadcastUserList();
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Servidor funcionando en puerto ${PORT}`);
});