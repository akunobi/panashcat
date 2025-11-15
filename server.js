// 1. Importar las librerías
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Pool } = require('pg'); // ¡CAMBIO! Importamos pg (PostgreSQL)

// ---- Configuración Inicial ----
const app = express();
const server = http.createServer(app);
const io = new Server(server);
// Render nos da el puerto a través de una variable de entorno
const PORT = process.env.PORT || 3000; 

// ---- Lista de usuarios permitidos ----
const allowedUsers = ['Rafa', 'Hugo', 'Sergio', 'Álvaro'];

// ---- ¡NUEVA CONFIGURACIÓN DE BASE DE DATOS (PostgreSQL)! ----
const db = new Pool({
  // Render nos da la URL de conexión a través de esta variable de entorno
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Requerido para conexiones en la nube en Render
  }
});

// Esta función async se asegura de que la tabla exista
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
    
    // Borramos mensajes de más de 2 semanas (1209600 segundos)
    const twoWeeksAgo = Math.floor(Date.now() / 1000) - 1209600;
    await db.query(`DELETE FROM messages WHERE timestamp < $1`, [twoWeeksAgo]);
    
    console.log('Base de datos lista.');
  } catch (err) {
    console.error('Error al configurar la base de datos:', err);
  }
}

// Ejecutamos la configuración de la DB al arrancar
setupDatabase();

// ---- Servir el HTML ----
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---- Lógica del Chat (Socket.IO) ----
io.on('connection', (socket) => {
  console.log('Un cliente está intentando conectarse...');

  // 1. Evento de Login (¡Modificado con "async"!)
  socket.on('login', async (username, callback) => {
    if (allowedUsers.includes(username)) {
      socket.username = username;
      callback(true);
      console.log(`✅ ${username} se ha conectado.`);
      io.emit('system message', `${username} se ha unido.`);

      // ¡CAMBIO! Consultamos el historial a PostgreSQL
      try {
        const twoWeeksAgo = Math.floor(Date.now() / 1000) - 1209600;
        // Cambiamos el nombre de la columna 'user' a 'user_name' para evitar conflictos
        const history = await db.query(
          `SELECT user_name AS "user", text, timestamp FROM messages WHERE timestamp >= $1 ORDER BY timestamp ASC`, 
          [twoWeeksAgo]
        );
        // "history.rows" contiene los resultados
        socket.emit('chat history', history.rows);
      } catch (e) {
        console.error('Error al consultar la DB:', e);
      }
      
    } else {
      callback(false);
    }
  });

  // 2. Evento de Mensaje de Chat (¡Modificado con "async"!)
  socket.on('chat message', async (msg) => {
    if (socket.username) {
      const timestamp = Math.floor(Date.now() / 1000);
      const data = {
        user: socket.username,
        text: msg,
        timestamp: timestamp
      };

      // ¡CAMBIO! Guardamos en PostgreSQL
      try {
        // $1, $2, $3 son marcadores de posición para pg
        await db.query(
          `INSERT INTO messages (user_name, text, timestamp) VALUES ($1, $2, $3)`, 
          [data.user, data.text, data.timestamp]
        );
        // Solo emitimos si se guarda bien
        io.emit('chat message', data);
      } catch (err) {
        console.error('Error al guardar mensaje:', err);
      }
    }
  });

  // 3. Evento de Desconexión (Sin cambios)
  socket.on('disconnect', () => {
    if (socket.username) {
      console.log(`❌ ${socket.username} se ha desconectado.`);
      io.emit('system message', `${socket.username} se ha marchado.`);
    }
  });

  // 4. Evento para Limpiar el Chat (¡Modificado con "async"!)
  socket.on('clear chat request', async () => {
    if (socket.username) {
      console.log(`El usuario ${socket.username} ha solicitado limpiar el chat.`);
      
      // ¡CAMBIO! Borramos en PostgreSQL
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