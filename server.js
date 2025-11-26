// 1. Importar las librerías
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Pool } = require('pg');

// ---- Configuración Inicial ----
const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  // Límite de 30MB para imágenes
  maxHttpBufferSize: 30 * 1024 * 1024, 
  transports: ['websocket'], 
  upgrade: false 
});
const PORT = process.env.PORT || 3000; 

// ---- Listas de usuarios ----
const allowedUsers = ['Rafa', 'Hugo', 'Sergio', 'Álvaro'];
const onlineUsers = new Set();

// ---- Configuración de Base de Datos (PostgreSQL) ----
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function setupDatabase() {
  try {
    console.log('Conectando a la base de datos PostgreSQL...');
    
    // 1. Tabla Mensajes Globales
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
    
    // 2. --- NUEVA TABLA: Mensajes Directos ---
    await db.query(`
      CREATE TABLE IF NOT EXISTS direct_messages (
        id SERIAL PRIMARY KEY,
        sender TEXT,
        recipient TEXT,
        text TEXT,
        timestamp BIGINT,
        reply_to_id INTEGER,
        message_type TEXT DEFAULT 'text'
      );
    `);
    
    // Limpieza de mensajes antiguos (2 semanas)
    const twoWeeksAgo = Math.floor(Date.now() / 1000) - 1209600;
    await db.query(`DELETE FROM messages WHERE timestamp < $1`, [twoWeeksAgo]);
    await db.query(`DELETE FROM direct_messages WHERE timestamp < $1`, [twoWeeksAgo]);
    
    console.log('Base de datos lista.');
  } catch (err) {
    console.error('Error al configurar la base de datos:', err);
  }
}
setupDatabase();

// ---- Servir Archivos ----
app.use('/images', express.static(path.join(__dirname, 'images')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---- Lógica del Chat (Socket.IO) ----
io.on('connection', (socket) => {
  console.log('✅ Un cliente se ha conectado (WebSocket).');

  // 1. Evento de Login
  socket.on('login', async (username, callback) => {
    if (allowedUsers.includes(username)) {
      socket.username = username;
      
      // --- CAMBIO CLAVE: Unirse a sala personal para DMs ---
      socket.join(username);
      
      callback(true);
      
      onlineUsers.add(username);
      io.emit('update user list', Array.from(onlineUsers));
      socket.broadcast.emit('system message', `${username} se ha unido.`);

      // Cargar historial GLOBAL por defecto
      try {
        const history = await db.query(
          `SELECT id, user_name AS "user", text, timestamp, reply_to_id, message_type AS "type"
           FROM messages 
           ORDER BY timestamp ASC LIMIT 100`
        );
        // Enviamos con etiqueta 'global'
        socket.emit('chat history', { type: 'global', messages: history.rows });
      } catch (e) {
        console.error('Error al consultar la DB:', e);
      }
      
    } else {
      callback(false);
    }
  });

  // 2. Mensajes Globales (Texto)
  socket.on('chat message', async (msg, replyToId) => {
    if (socket.username) {
      const timestamp = Math.floor(Date.now() / 1000);
      try {
        const result = await db.query(
          `INSERT INTO messages (user_name, text, timestamp, reply_to_id, message_type) 
           VALUES ($1, $2, $3, $4, 'text') RETURNING id`,
          [socket.username, msg, timestamp, replyToId]
        );
        io.emit('chat message', { 
          id: result.rows[0].id, user: socket.username, text: msg, timestamp, reply_to_id: replyToId, type: 'text', isPrivate: false 
        });
      } catch (err) { console.error(err); }
    }
  });
  
  // 3. Imágenes Globales
  socket.on('chat image', async (imageData, replyToId) => {
    if (socket.username) {
      const timestamp = Math.floor(Date.now() / 1000);
      try {
        const result = await db.query(
          `INSERT INTO messages (user_name, text, timestamp, reply_to_id, message_type) 
           VALUES ($1, $2, $3, $4, 'image') RETURNING id`,
          [socket.username, imageData, timestamp, replyToId]
        );
        io.emit('chat message', { 
          id: result.rows[0].id, user: socket.username, text: imageData, timestamp, reply_to_id: replyToId, type: 'image', isPrivate: false 
        });
      } catch (err) { console.error(err); }
    }
  });

  // --- 4. NUEVO: Mensajes Privados (DM) ---
  socket.on('private message', async (recipient, content, replyToId, type = 'text') => {
    if (!socket.username) return;
    const timestamp = Math.floor(Date.now() / 1000);
    
    try {
      const result = await db.query(
        `INSERT INTO direct_messages (sender, recipient, text, timestamp, reply_to_id, message_type) 
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [socket.username, recipient, content, timestamp, replyToId, type]
      );
      
      const data = {
        id: result.rows[0].id,
        user: socket.username, // Remitente
        recipient: recipient,
        text: content,
        timestamp,
        reply_to_id: replyToId,
        type: type,
        isPrivate: true
      };

      // Enviar a mí mismo y al destinatario
      socket.emit('private message', data);
      io.to(recipient).emit('private message', data);

    } catch (e) { console.error('Error private msg:', e); }
  });

  // --- 5. NUEVO: Historial Privado ---
  socket.on('get private history', async (otherUser) => {
    if (!socket.username) return;
    try {
      // Buscar mensajes de la conversación privada
      const res = await db.query(
        `SELECT id, sender AS "user", recipient, text, timestamp, reply_to_id, message_type AS "type"
         FROM direct_messages 
         WHERE (sender = $1 AND recipient = $2) OR (sender = $2 AND recipient = $1)
         ORDER BY timestamp ASC LIMIT 100`,
        [socket.username, otherUser]
      );
      socket.emit('chat history', { type: 'private', target: otherUser, messages: res.rows });
    } catch (e) { console.error(e); }
  });

  // 6. Eventos de Escritura (Contextual)
  socket.on('typing', (target) => {
    if (!socket.username) return;
    if (target === 'global') {
        socket.broadcast.emit('user typing', { user: socket.username, context: 'global' });
    } else {
        io.to(target).emit('user typing', { user: socket.username, context: 'private' });
    }
  });

  socket.on('stop typing', (target) => {
    if (!socket.username) return;
    if (target === 'global') {
        socket.broadcast.emit('user stop typing', { user: socket.username, context: 'global' });
    } else {
        io.to(target).emit('user stop typing', { user: socket.username, context: 'private' });
    }
  });

  // 7. Eliminar Mensaje (Soporta tablas privadas)
  socket.on('delete message', async (id, isPrivate) => {
    if (!socket.username) return;
    
    const table = isPrivate ? 'direct_messages' : 'messages';
    const userCol = isPrivate ? 'sender' : 'user_name';
    
    try {
      const check = await db.query(`SELECT ${userCol} FROM ${table} WHERE id = $1`, [id]);
      if (check.rows.length > 0 && check.rows[0][userCol] === socket.username) {
        await db.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
        io.emit('message deleted', id); 
      }
    } catch (e) { console.error(e); }
  });

  // 8. Limpiar Chat (Solo Global)
  socket.on('clear chat request', async () => {
    if (socket.username) {
      try {
        await db.query(`DELETE FROM messages`);
        io.emit('chat cleared'); 
        io.emit('system message', `${socket.username} limpió el chat global.`);
      } catch (err) { console.error(err); }
    }
  });

  // 9. Desconexión
  socket.on('disconnect', () => {
    if (socket.username) {
      onlineUsers.delete(socket.username);
      io.emit('update user list', Array.from(onlineUsers));
    }
  });
});

// ---- Iniciar el servidor ----
server.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});