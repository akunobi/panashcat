// 1. Importar las librerías
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Pool } = require('pg');

// ---- Configuración Inicial ----
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000; 

// ---- Lista de usuarios permitidos ----
const allowedUsers = ['Rafa', 'Hugo', 'Sergio', 'Álvaro'];

// ---- ¡NUEVO! Lista de usuarios en línea ----
const onlineUsers = new Set();

// ---- Configuración de Base de Datos (PostgreSQL) ----
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// (Esta parte de 'setupDatabase' no cambia)
async function setupDatabase() {
  try {
    console.log('Conectando a la base de datos PostgreSQL...');
    await db.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        user_name TEXT,
        text TEXT,
        timestamp BIGINT
      );
    `);
    
    const twoWeeksAgo = Math.floor(Date.now() / 1000) - 1209600;
    await db.query(`DELETE FROM messages WHERE timestamp < $1`, [twoWeeksAgo]);
    
    console.log('Base de datos lista.');
  } catch (err) {
    console.error('Error al configurar la base de datos:', err);
  }
}
setupDatabase();

// ---- Servir el HTML ----
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---- Lógica del Chat (Socket.IO) ----
io.on('connection', (socket) => {
  console.log('Un cliente está intentando conectarse...');

  // 1. Evento de Login (¡Modificado!)
  socket.on('login', async (username, callback) => {
    if (allowedUsers.includes(username)) {
      socket.username = username;
      callback(true);
      console.log(`✅ ${username} se ha conectado.`);

      // --- ¡CAMBIO AQUÍ! ---
      // 1. Añadir al usuario a la lista de conectados
      onlineUsers.add(username);
      // 2. Enviar la lista actualizada a TODOS
      io.emit('update user list', Array.from(onlineUsers));
      // --- Fin del cambio ---

      io.emit('system message', `${username} se ha unido.`);

      // (El resto de la carga del historial no cambia)
      try {
        const twoWeeksAgo = Math.floor(Date.now() / 1000) - 1209600;
        const history = await db.query(
          `SELECT user_name AS "user", text, timestamp FROM messages WHERE timestamp >= $1 ORDER BY timestamp ASC`, 
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

  // 2. Evento de Mensaje de Chat (Sin cambios)
  socket.on('chat message', async (msg) => {
    // (Esta función no cambia)
    if (socket.username) {
      const timestamp = Math.floor(Date.now() / 1000);
      const data = { user: socket.username, text: msg, timestamp: timestamp };
      try {
        await db.query(
          `INSERT INTO messages (user_name, text, timestamp) VALUES ($1, $2, $3)`, 
          [data.user, data.text, data.timestamp]
        );
        io.emit('chat message', data);
      } catch (err) {
        console.error('Error al guardar mensaje:', err);
      }
    }
  });

  // 3. Evento de Desconexión (¡Modificado!)
  socket.on('disconnect', () => {
    if (socket.username) {
      console.log(`❌ ${socket.username} se ha desconectado.`);

      // --- ¡CAMBIO AQUÍ! ---
      // 1. Quitar al usuario de la lista
      onlineUsers.delete(socket.username);
      // 2. Enviar la lista actualizada a TODOS
      io.emit('update user list', Array.from(onlineUsers));
      // --- Fin del cambio ---

      io.emit('system message', `${socket.username} se ha marchado.`);
    }
  });

  // 4. Evento para Limpiar el Chat (Sin cambios)
  socket.on('clear chat request', async () => {
    // (Esta función no cambia)
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