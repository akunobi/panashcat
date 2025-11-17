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

// ---- Servir Archivos ----

// ¡NUEVA LÍNEA! Sirve la carpeta 'images'
app.use('/images', express.static(path.join(__dirname, 'images')));

// Sirve el HTML principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---- Lógica del Chat (Socket.IO) ----
io.on('connection', (socket) => {
  console.log('✅ Un cliente se ha conectado (WebSocket).');

  // 1. Evento de Login (Sin cambios)
  socket.on('login', async (username, callback) => {
    if (allowedUsers.includes(username)) {
      socket.username = username;
      callback(true);
      
      onlineUsers.add(username);
      io.emit('update user list', Array.from(onlineUsers));
      io.emit('system message', `${username} se ha unido.`);

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
      callback(false); // Login fallido
    }
  });

  // 2. Evento de Mensaje de Chat (Sin cambios)
  socket.on('chat message', async (msg) => {
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
  
  // --- ¡NUEVOS EVENTOS DE ESCRITURA! ---
  // 3. Usuario está escribiendo
  socket.on('typing', () => {
    if (socket.username) {
      // Reenvía a todos MENOS al que escribe
      socket.broadcast.emit('user typing', socket.username);
    }
  });
  
  // 4. Usuario ha parado de escribir
  socket.on('stop typing', () => {
    if (socket.username) {
      socket.broadcast.emit('user stop typing', socket.username);
    }
  });
  // --- Fin de nuevos eventos ---

  // 5. Evento de Desconexión
  socket.on('disconnect', () => {
    if (socket.username) {
      console.log(`❌ ${socket.username} se ha desconectado.`);
      onlineUsers.delete(socket.username);
      io.emit('update user list', Array.from(onlineUsers));
      io.emit('system message', `${socket.username} se ha marchado.`);
      // Avisa que dejó de escribir al desconectarse
      socket.broadcast.emit('user stop typing', socket.username);
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