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
    // Creación/modificación de la tabla
    await db.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        user_name TEXT,
        text TEXT,
        timestamp BIGINT
      );
    `);
    
    // Añadimos la columna para respuestas
    await db.query(`
      ALTER TABLE messages 
      ADD COLUMN IF NOT EXISTS reply_to_id INTEGER
    `);
    
    // Limpieza de mensajes antiguos
    const twoWeeksAgo = Math.floor(Date.now() / 1000) - 1209600;
    await db.query(`DELETE FROM messages WHERE timestamp < $1`, [twoWeeksAgo]);
    
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
      callback(true);
      
      onlineUsers.add(username);
      io.emit('update user list', Array.from(onlineUsers));
      io.emit('system message', `${username} se ha unido.`);

      try {
        const twoWeeksAgo = Math.floor(Date.now() / 1000) - 1209600;
        // Seleccionamos todos los datos necesarios
        const history = await db.query(
          `SELECT id, user_name AS "user", text, timestamp, reply_to_id 
           FROM messages 
           WHERE timestamp >= $1 
           ORDER BY timestamp ASC`, 
          [twoWeeksAgo]
        );
        socket.emit('chat history', history.rows);
      } catch (e) {
        console.error('Error al consultar la DB:', e);
      }
      
    } else {
      callback(false);
    }
  });

  // 2. Evento de Mensaje de Chat
  socket.on('chat message', async (msg, replyToId) => {
    if (socket.username) {
      const timestamp = Math.floor(Date.now() / 1000);
      
      try {
        const result = await db.query(
          `INSERT INTO messages (user_name, text, timestamp, reply_to_id) 
           VALUES ($1, $2, $3, $4) 
           RETURNING id`,
          [socket.username, msg, timestamp, replyToId]
        );

        const newId = result.rows[0].id;

        const data = { 
          id: newId,
          user: socket.username, 
          text: msg, 
          timestamp: timestamp,
          reply_to_id: replyToId
        };
        
        io.emit('chat message', data);
      } catch (err) {
        console.error('Error al guardar mensaje:', err);
      }
    }
  });
  
  // 3. Eventos de Escritura
  socket.on('typing', () => {
    if (socket.username) {
      socket.broadcast.emit('user typing', socket.username);
    }
  });
  socket.on('stop typing', () => {
    if (socket.username) {
      socket.broadcast.emit('user stop typing', socket.username);
    }
  });

  // 4. Evento de Desconexión
  socket.on('disconnect', () => {
    if (socket.username) {
      console.log(`❌ ${socket.username} se ha desconectado.`);
      onlineUsers.delete(socket.username);
      io.emit('update user list', Array.from(onlineUsers));
      io.emit('system message', `${socket.username} se ha marchado.`);
      socket.broadcast.emit('user stop typing', socket.username);
    }
  });

  // 5. Evento para Eliminar un Mensaje
  socket.on('delete message', async (messageId) => {
    if (!socket.username) return;

    try {
      const msgResult = await db.query(
        `SELECT user_name FROM messages WHERE id = $1`, 
        [messageId]
      );
      
      if (msgResult.rows.length > 0 && msgResult.rows[0].user_name === socket.username) {
        await db.query(`DELETE FROM messages WHERE id = $1`, [messageId]);
        io.emit('message deleted', messageId);
      }
    } catch (err) {
      console.error('Error al borrar mensaje:', err);
    }
  });

  // 6. Evento para Limpiar el Chat
  socket.on('clear chat request', async () => {
    if (socket.username) {
      console.log(`El usuario ${socket.username} ha solicitado limpiar el chat.`);
      try {
        await db.query(`DELETE FROM messages`);
        console.log('Historial de chat borrado.');
        io.emit('chat cleared'); 
        io.emit('system message', `${socket.username} ha borrado el historial del chat.`);
      } catch (err) {
        console.error('Error al borrar mensajes:', err);
      }
    }
  });

});

// ---- Iniciar el servidor ----
server.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});