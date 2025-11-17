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
    // Creación de la tabla (sin cambios)
    await db.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        user_name TEXT,
        text TEXT,
        timestamp BIGINT
      );
    `);
    
    // --- ¡CAMBIO IMPORTANTE EN LA BASE DE DATOS! ---
    // Añadimos la columna para respuestas, si no existe
    await db.query(`
      ALTER TABLE messages 
      ADD COLUMN IF NOT EXISTS reply_to_id INTEGER
    `);
    
    // Limpieza de mensajes antiguos (sin cambios)
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

  // 1. Evento de Login (¡Modificado!)
  socket.on('login', async (username, callback) => {
    if (allowedUsers.includes(username)) {
      socket.username = username;
      callback(true);
      
      onlineUsers.add(username);
      io.emit('update user list', Array.from(onlineUsers));
      io.emit('system message', `${username} se ha unido.`);

      try {
        const twoWeeksAgo = Math.floor(Date.now() / 1000) - 1209600;
        // ¡CAMBIO! Ahora seleccionamos el 'id' y 'reply_to_id'
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

  // 2. Evento de Mensaje de Chat (¡Modificado!)
  socket.on('chat message', async (msg, replyToId) => { // Acepta un nuevo parámetro
    if (socket.username) {
      const timestamp = Math.floor(Date.now() / 1000);
      
      try {
        // ¡CAMBIO! Guardamos el reply_to_id y pedimos que nos devuelva el 'id'
        const result = await db.query(
          `INSERT INTO messages (user_name, text, timestamp, reply_to_id) 
           VALUES ($1, $2, $3, $4) 
           RETURNING id`, // Pide a Postgres que devuelva el ID recién creado
          [socket.username, msg, timestamp, replyToId]
        );

        const newId = result.rows[0].id; // Obtenemos el ID único

        // Creamos el objeto de datos completo para enviar a los clientes
        const data = { 
          id: newId, // ¡Enviamos el ID!
          user: socket.username, 
          text: msg, 
          timestamp: timestamp,
          reply_to_id: replyToId
        };
        
        io.emit('chat message', data); // Emitimos el objeto completo
      } catch (err) {
        console.error('Error al guardar mensaje:', err);
      }
    }
  });
  
  // 3. Eventos de Escritura (Sin cambios)
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

  // 4. Evento de Desconexión (Sin cambios)
  socket.on('disconnect', () => {
    if (socket.username) {
      console.log(`❌ ${socket.username} se ha desconectado.`);
      onlineUsers.delete(socket.username);
      io.emit('update user list', Array.from(onlineUsers));
      io.emit('system message', `${socket.username} se ha marchado.`);
      socket.broadcast.emit('user stop typing', socket.username);
    }
  });

  // --- ¡NUEVO EVENTO DE BORRADO! ---
  // 5. Evento para Eliminar un Mensaje
  socket.on('delete message', async (messageId) => {
    if (!socket.username) return; // No logueado, no puede borrar

    try {
      // 1. Verificamos que el usuario es el dueño del mensaje
      const msgResult = await db.query(
        `SELECT user_name FROM messages WHERE id = $1`, 
        [messageId]
      );
      
      if (msgResult.rows.length > 0 && msgResult.rows[0].user_name === socket.username) {
        // 2. Si es el dueño, lo borra
        await db.query(`DELETE FROM messages WHERE id = $1`, [messageId]);
        
        // 3. Avisa a todos los clientes que lo borren de la UI
        io.emit('message deleted', messageId);
      }
    } catch (err) {
      console.error('Error al borrar mensaje:', err);
    }
  });

  // 6. Evento para Limpiar el Chat (Sin cambios)
  socket.on('clear chat request', async () => {
    // ... (sin cambios)
  });

});

// ---- Iniciar el servidor ----
server.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});