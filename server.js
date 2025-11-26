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

// 2. Estado en Memoria (Usuarios conectados)
const onlineUsers = new Set();

// 3. Conexión Base de Datos
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- CONFIGURACIÓN INICIAL DE TABLAS ---
async function setupDatabase() {
  try {
    console.log('--- Verificando Base de Datos ---');
    
    // Tabla para chat global
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

    // Tabla para mensajes privados (DMs)
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
    
    // Intentar añadir columnas si faltan (por si la DB es antigua)
    try { await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text'`); } catch(e){}
    try { await db.query(`ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text'`); } catch(e){}

    console.log('✅ Base de datos lista y configurada.');
  } catch (err) {
    console.error('❌ Error fatal configurando DB:', err);
  }
}
setupDatabase();

// Servir archivos estáticos (HTML, imágenes)
app.use('/images', express.static(path.join(__dirname, 'images')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 4. LÓGICA DE SOCKETS
io.on('connection', (socket) => {
  console.log(`🔌 Nuevo cliente conectado: ${socket.id}`);

  // --- EVENTO: LOGIN ---
  socket.on('login', (username) => {
    if (!username) return;

    console.log(`🔑 Intento de login: ${username}`);
    socket.username = username;
    
    // Unimos al usuario a una sala con su mismo nombre para recibir DMs
    socket.join(username);
    onlineUsers.add(username);
    
    // Confirmamos al cliente que el login fue exitoso
    socket.emit('login_success', username);
    
    // Actualizamos la lista de usuarios a todos
    io.emit('update_user_list', Array.from(onlineUsers));
    io.emit('system_message', `${username} ha entrado al chat.`);
  });

  // --- EVENTO: UNIRSE A UN CHAT (Cargar Historial) ---
  socket.on('join_chat', async ({ target }) => {
    if (!socket.username) return;
    
    // Cargar solo las últimas 2 semanas para no saturar
    const timeLimit = Math.floor(Date.now() / 1000) - 1209600; 

    try {
        let history = [];

        if (target === 'global') {
            // Cargar historial GLOBAL
            const res = await db.query(
                `SELECT * FROM messages WHERE timestamp > $1 ORDER BY id ASC`, 
                [timeLimit]
            );
            
            history = res.rows.map(row => ({
                id: row.id,
                user: row.user_name,
                text: row.text,
                timestamp: row.timestamp,
                reply_to_id: row.reply_to_id,
                message_type: row.message_type,
                isPrivate: false
            }));

        } else {
            // Cargar historial PRIVADO (Entre YO y el TARGET)
            const res = await db.query(
                `SELECT * FROM direct_messages 
                 WHERE timestamp > $1 
                 AND ( (sender=$2 AND receiver=$3) OR (sender=$3 AND receiver=$2) )
                 ORDER BY id ASC`,
                [timeLimit, socket.username, target]
            );

            history = res.rows.map(row => ({
                id: row.id,
                user: row.sender,
                text: row.text,
                timestamp: row.timestamp,
                reply_to_id: row.reply_to_id,
                message_type: row.message_type,
                isPrivate: true,
                receiver: row.receiver
            }));
        }
        
        // Enviamos el historial al cliente
        socket.emit('chat_history', { history, context: target });

    } catch (err) {
        console.error("Error recuperando historial:", err);
    }
  });

  // --- EVENTO: ENVIAR MENSAJE ---
  socket.on('chat_message', async (data) => {
    if (!socket.username) return;

    const { text, type, replyTo, target } = data;
    const ts = Math.floor(Date.now() / 1000);

    console.log(`📩 Mensaje de ${socket.username} para ${target}`);

    try {
        if (target === 'global') {
            // Guardar en Tabla Global
            const res = await db.query(
                `INSERT INTO messages (user_name, text, timestamp, reply_to_id, message_type) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                [socket.username, text, ts, replyTo, type]
            );
            
            const msg = { 
                id: res.rows[0].id, 
                user: socket.username, 
                text, timestamp: ts, reply_to_id: replyTo, 
                message_type: type, isPrivate: false 
            };
            
            // Enviar a todos
            io.emit('chat_message', msg);

        } else {
            // Guardar en Tabla Privada
            const res = await db.query(
                `INSERT INTO direct_messages (sender, receiver, text, timestamp, reply_to_id, message_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [socket.username, target, text, ts, replyTo, type]
            );
            
            const msg = { 
                id: res.rows[0].id, 
                user: socket.username, 
                text, timestamp: ts, reply_to_id: replyTo, 
                message_type: type, isPrivate: true, receiver: target 
            };
            
            // Enviar a las salas de los dos involucrados
            io.to(socket.username).to(target).emit('chat_message', msg);
        }
    } catch(e) {
        console.error("Error guardando mensaje:", e);
    }
  });

  // --- EVENTO: BORRAR MENSAJE ---
  socket.on('delete_message', async (id) => {
      try {
        // Intentar borrar de ambas tablas (validando usuario)
        await db.query(`DELETE FROM messages WHERE id=$1 AND user_name=$2`, [id, socket.username]);
        await db.query(`DELETE FROM direct_messages WHERE id=$1 AND sender=$2`, [id, socket.username]);
        io.emit('message_deleted', id);
      } catch(e) { console.error(e); }
  });

  // --- EVENTO: LIMPIAR CHAT (Solo Global) ---
  socket.on('clear_chat', async () => {
      if(!socket.username) return;
      await db.query('DELETE FROM messages');
      io.emit('chat_cleared');
      io.emit('system_message', `${socket.username} ha limpiado el chat.`);
  });

  // --- EVENTOS DE ESTADO ---
  socket.on('typing', () => socket.broadcast.emit('user_typing', socket.username));
  socket.on('stop_typing', () => socket.broadcast.emit('user_stop_typing', socket.username));
  
  socket.on('disconnect', () => {
    if (socket.username) {
        console.log(`❌ Usuario desconectado: ${socket.username}`);
        onlineUsers.delete(socket.username);
        io.emit('update_user_list', Array.from(onlineUsers));
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Servidor funcionando en el puerto ${PORT}`);
});