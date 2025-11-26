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
  // Aumentar el límite de payload para manejar imágenes grandes (30MB)
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
    
    // 1. Tabla mensajes globales (ORIGINAL)
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

    // Asegurar columna message_type en global
    await db.query(`
      ALTER TABLE messages 
      ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text'
    `);

    // --- NUEVO: 2. Tabla Mensajes Privados (AÑADIDO PARA DMs) ---
    // Creamos una tabla separada para no ensuciar la lógica del chat global
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
    
    // Limpieza de mensajes antiguos (2 semanas) - Aplica a ambos
    const twoWeeksAgo = Math.floor(Date.now() / 1000) - 1209600;
    await db.query(`DELETE FROM messages WHERE timestamp < $1`, [twoWeeksAgo]);
    await db.query(`DELETE FROM direct_messages WHERE timestamp < $1`, [twoWeeksAgo]);
    
    console.log('Base de datos lista (Tablas Global y Privada).');
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

  // 1. Evento de Login (MODIFICADO)
  socket.on('login', async (username, callback) => {
    if (allowedUsers.includes(username)) {
      socket.username = username;
      callback(true);
      
      onlineUsers.add(username);
      
      // --- NUEVO: Unir al usuario a una sala privada con su nombre ---
      // Esto permite enviarle mensajes directos solo a él.
      socket.join(username);

      io.emit('update user list', Array.from(onlineUsers));
      io.emit('system message', `${username} se ha unido.`);

      // Por defecto, cargamos el historial GLOBAL al iniciar
      // (Reutilizamos la lógica original aquí)
      try {
        const twoWeeksAgo = Math.floor(Date.now() / 1000) - 1209600;
        const history = await db.query(
          `SELECT id, user_name AS "user", text, timestamp, reply_to_id, message_type AS "type"
           FROM messages 
           WHERE timestamp >= $1 
           ORDER BY timestamp ASC`, 
          [twoWeeksAgo]
        );
        // Enviamos historial indicando que es contexto 'global'
        socket.emit('chat history', { messages: history.rows, context: 'global' });
      } catch (e) {
        console.error('Error al consultar la DB:', e);
      }
      
    } else {
      callback(false);
    }
  });

  // --- NUEVO: Evento para Cambiar de Chat (Global <-> Privado) ---
  socket.on('join chat', async ({ target, type }) => {
    if (!socket.username) return;
    const twoWeeksAgo = Math.floor(Date.now() / 1000) - 1209600;

    if (type === 'global') {
        // Cargar historial Global (Lógica original)
        const history = await db.query(
          `SELECT id, user_name AS "user", text, timestamp, reply_to_id, message_type AS "type"
           FROM messages WHERE timestamp >= $1 ORDER BY timestamp ASC`, 
          [twoWeeksAgo]
        );
        socket.emit('chat history', { messages: history.rows, context: 'global' });

    } else if (type === 'private') {
        // Cargar historial Privado
        // Buscamos mensajes donde: (Sender = YO y Receiver = OTRO) O (Sender = OTRO y Receiver = YO)
        const history = await db.query(
            `SELECT id, sender AS "user", text, timestamp, reply_to_id, message_type AS "type", receiver
             FROM direct_messages 
             WHERE timestamp >= $1 
             AND ((sender = $2 AND receiver = $3) OR (sender = $3 AND receiver = $2))
             ORDER BY timestamp ASC`,
            [twoWeeksAgo, socket.username, target]
        );
        
        // Marcamos los mensajes como privados para el front
        const formatted = history.rows.map(m => ({ ...m, isPrivate: true }));
        socket.emit('chat history', { messages: formatted, context: target });
    }
  });


  // 2. Evento de Mensaje de Texto (MODIFICADO para aceptar destinatario)
  // Ahora aceptamos un objeto 'options' o argumentos adicionales
  socket.on('chat message', async (msg, replyToId, targetUser) => {
    if (socket.username) {
      const timestamp = Math.floor(Date.now() / 1000);
      
      // --- LOGICA PRIVADA ---
      if (targetUser && targetUser !== 'global') {
         try {
            const result = await db.query(
              `INSERT INTO direct_messages (sender, receiver, text, timestamp, reply_to_id, message_type) 
               VALUES ($1, $2, $3, $4, $5, 'text') RETURNING id`,
              [socket.username, targetUser, msg, timestamp, replyToId]
            );
            const newId = result.rows[0].id;
            const data = { 
              id: newId, user: socket.username, text: msg, timestamp, reply_to_id: replyToId, 
              type: 'text', isPrivate: true, receiver: targetUser 
            };

            // Enviar a MÍ MISMO y al DESTINATARIO
            io.to(socket.username).to(targetUser).emit('chat message', data);
         } catch(err) { console.error(err); }

      } else {
         // --- LOGICA GLOBAL (ORIGINAL) ---
         try {
            const result = await db.query(
              `INSERT INTO messages (user_name, text, timestamp, reply_to_id, message_type) 
               VALUES ($1, $2, $3, $4, 'text') RETURNING id`,
              [socket.username, msg, timestamp, replyToId]
            );
            const newId = result.rows[0].id;
            const data = { 
              id: newId, user: socket.username, text: msg, timestamp, reply_to_id: replyToId, 
              type: 'text', isPrivate: false 
            };
            io.emit('chat message', data);
         } catch (err) { console.error('Error global:', err); }
      }
    }
  });
  
  // 3. Evento para Enviar Imagen (MODIFICADO para aceptar destinatario)
  socket.on('chat image', async (imageData, replyToId, targetUser) => {
    if (socket.username && imageData && imageData.startsWith('data:image')) {
      const timestamp = Math.floor(Date.now() / 1000);

      // --- LOGICA IMAGEN PRIVADA ---
      if (targetUser && targetUser !== 'global') {
          try {
            const result = await db.query(
              `INSERT INTO direct_messages (sender, receiver, text, timestamp, reply_to_id, message_type) 
               VALUES ($1, $2, $3, $4, $5, 'image') RETURNING id`,
              [socket.username, targetUser, imageData, timestamp, replyToId]
            );
            const data = { 
              id: result.rows[0].id, user: socket.username, text: imageData, timestamp, reply_to_id: replyToId, 
              type: 'image', isPrivate: true, receiver: targetUser 
            };
            io.to(socket.username).to(targetUser).emit('chat message', data);
          } catch(err) { console.error(err); }
      } else {
          // --- LOGICA IMAGEN GLOBAL (ORIGINAL) ---
          try {
            const result = await db.query(
              `INSERT INTO messages (user_name, text, timestamp, reply_to_id, message_type) 
               VALUES ($1, $2, $3, $4, 'image') RETURNING id`,
              [socket.username, imageData, timestamp, replyToId]
            );
            const data = { 
              id: result.rows[0].id, user: socket.username, text: imageData, timestamp, reply_to_id: replyToId, 
              type: 'image', isPrivate: false 
            };
            io.emit('chat message', data);
          } catch (err) { console.error(err); }
      }
    }
  });


  // 4. Eventos de Escritura (Global, se podría refinar para DMs pero lo mantendremos simple)
  socket.on('typing', () => {
    if (socket.username) socket.broadcast.emit('user typing', socket.username);
  });
  socket.on('stop typing', () => {
    if (socket.username) socket.broadcast.emit('user stop typing', socket.username);
  });

  // 5. Evento de Desconexión
  socket.on('disconnect', () => {
    if (socket.username) {
      console.log(`❌ ${socket.username} se ha desconectado.`);
      onlineUsers.delete(socket.username);
      io.emit('update user list', Array.from(onlineUsers));
      io.emit('system message', `${socket.username} se ha marchado.`);
    }
  });

  // 6. Evento para Eliminar un Mensaje (MODIFICADO para soportar DM)
  socket.on('delete message', async (messageId) => {
    if (!socket.username) return;
    try {
      // Intentar borrar de global
      let res = await db.query(`SELECT user_name FROM messages WHERE id = $1`, [messageId]);
      if (res.rows.length > 0 && res.rows[0].user_name === socket.username) {
        await db.query(`DELETE FROM messages WHERE id = $1`, [messageId]);
        io.emit('message deleted', messageId);
        return;
      }

      // Si no estaba en global, intentar borrar de privados
      res = await db.query(`SELECT sender, receiver FROM direct_messages WHERE id = $1`, [messageId]);
      if (res.rows.length > 0 && res.rows[0].sender === socket.username) {
         await db.query(`DELETE FROM direct_messages WHERE id = $1`, [messageId]);
         // Notificar a ambos (sender y receiver)
         io.to(socket.username).to(res.rows[0].receiver).emit('message deleted', messageId);
      }
    } catch (err) { console.error('Error al borrar:', err); }
  });

  // 7. Evento para Limpiar el Chat (Solo Global por seguridad)
  socket.on('clear chat request', async () => {
    if (socket.username) {
      try {
        await db.query(`DELETE FROM messages`);
        io.emit('chat cleared'); 
        io.emit('system message', `${socket.username} ha borrado el historial del chat.`);
      } catch (err) { console.error(err); }
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});