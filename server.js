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
  // Límite de 30MB para imágenes (Ajustar según necesidad)
  maxHttpBufferSize: 30 * 1024 * 1024, 
  transports: ['websocket'], 
  upgrade: false 
});
const PORT = process.env.PORT || 3000; 

// ---- Listas de usuarios ----
const allowedUsers = ['Rafa', 'Hugo', 'Sergio', 'Álvaro'];
const onlineUsers = new Set();
// Mapeo de usuario a socket.id para DMs
const userSockets = new Map();

// ---- Configuración de Base de Datos (PostgreSQL) ----
// ¡IMPORTANTE! Revisa tu variable de entorno DATABASE_URL
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// --------------------------------------------------------------------------------
// 1. Configuración de Base de Datos y Tablas
// --------------------------------------------------------------------------------

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
    
    console.log('Tablas de la base de datos verificadas y listas.');
  } catch (err) {
    console.error('ERROR CRÍTICO al conectar o configurar la DB:', err);
    throw err; // Detiene la aplicación si la DB falla
  }
}

// --------------------------------------------------------------------------------
// 2. Configuración de Express para servir el cliente
// --------------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public'))); // Si tienes carpeta public
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --------------------------------------------------------------------------------
// 3. Socket.io Handlers
// --------------------------------------------------------------------------------

io.on('connection', (socket) => {
  console.log('a user connected');

  // 1. LOGIN
  socket.on('login', (username, cb) => {
    // 1a. Validación
    if (!allowedUsers.includes(username)) {
      cb(false); 
      return;
    }

    // 1b. Evitar duplicados (manejo simple de reconexión si ya está loggeado)
    if (onlineUsers.has(username) && userSockets.get(username) !== socket.id) {
        cb(false);
        return;
    }
    
    // **RESPUESTA INMEDIATA AL CLIENTE PARA DESBLOQUEAR EL LOGIN**
    cb(true); 

    // 1c. Asignar y notificar
    socket.username = username;
    onlineUsers.add(username);
    userSockets.set(username, socket.id);
    
    io.emit('system message', `${username} se ha conectado.`);
    io.emit('update user list', Array.from(onlineUsers));
  });

  // 2. Mensaje de Chat Global (TEXTO)
  socket.on('chat message', async (msg, reply_to_id) => {
    if (!socket.username) return;
    
    const timestamp = Math.floor(Date.now() / 1000);
    
    try {
        const res = await db.query(
            `INSERT INTO messages (user_name, text, timestamp, reply_to_id) VALUES ($1, $2, $3, $4) RETURNING id`,
            [socket.username, msg, timestamp, reply_to_id]
        );
        const newMessage = {
            id: res.rows[0].id,
            user: socket.username,
            text: msg,
            timestamp: timestamp,
            reply_to_id: reply_to_id,
            type: 'text',
            isPrivate: false
        };
        io.emit('chat message', newMessage);
    } catch (e) {
        console.error('Error al guardar mensaje global:', e);
    }
  });

  // 3. Mensaje de Chat Global (IMAGEN)
  socket.on('chat image', async (base64Data, reply_to_id) => {
    if (!socket.username) return;
    
    const timestamp = Math.floor(Date.now() / 1000);
    
    try {
        const res = await db.query(
            `INSERT INTO messages (user_name, text, timestamp, reply_to_id, message_type) VALUES ($1, $2, $3, $4, 'image') RETURNING id`,
            [socket.username, base64Data, timestamp, reply_to_id]
        );
        const newMessage = {
            id: res.rows[0].id,
            user: socket.username,
            text: base64Data,
            timestamp: timestamp,
            reply_to_id: reply_to_id,
            type: 'image',
            isPrivate: false
        };
        io.emit('chat message', newMessage);
    } catch (e) {
        console.error('Error al guardar imagen global:', e);
    }
  });


  // 4. Mensaje Privado (DM)
  socket.on('private message', async (recipient, msg, reply_to_id, type = 'text') => {
    if (!socket.username || !userSockets.has(recipient) || socket.username === recipient) return;
    
    const timestamp = Math.floor(Date.now() / 1000);
    const sender = socket.username;
    
    try {
      const res = await db.query(
        `INSERT INTO direct_messages (sender, recipient, text, timestamp, reply_to_id, message_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [sender, recipient, msg, timestamp, reply_to_id, type]
      );
      
      const newMessage = {
          id: res.rows[0].id,
          user: sender, 
          recipient: recipient,
          text: msg,
          timestamp: timestamp,
          reply_to_id: reply_to_id,
          type: type,
          isPrivate: true
      };
      
      // 4a. Enviar al remitente
      socket.emit('private message', newMessage);
      
      // 4b. Enviar al destinatario
      const recipientSocketId = userSockets.get(recipient);
      if (recipientSocketId) {
          io.to(recipientSocketId).emit('private message', newMessage);
      }
      
    } catch (e) {
      console.error('Error al guardar DM:', e);
    }
  });

  // 5. Historial
  // 5a. Historial Global
  socket.on('get global history', async () => {
    try {
      const res = await db.query(`
        SELECT id, user_name, text, timestamp, reply_to_id, message_type 
        FROM messages 
        ORDER BY timestamp DESC LIMIT 50
      `);
      socket.emit('chat history', { 
          type: 'global', 
          messages: res.rows.reverse() 
      });
    } catch (e) {
      console.error('Error al cargar historial global:', e);
    }
  });

  // 5b. Historial Privado
  socket.on('get private history', async (targetUser) => {
    if (!socket.username || !allowedUsers.includes(targetUser)) return;
    
    const user1 = socket.username;
    const user2 = targetUser;
    
    try {
        const res = await db.query(`
            SELECT id, sender, recipient, text, timestamp, reply_to_id, message_type
            FROM direct_messages
            WHERE 
                (sender = $1 AND recipient = $2) OR 
                (sender = $2 AND recipient = $1)
            ORDER BY timestamp DESC LIMIT 50
        `, [user1, user2]);
        
        socket.emit('chat history', { 
            type: 'private', 
            target: targetUser, 
            messages: res.rows.reverse() 
        });
        
    } catch (e) {
        console.error('Error al cargar historial privado:', e);
    }
  });


  // 6. Indicador de Escritura
  socket.on('typing', (context) => {
    if (!socket.username) return;
    
    if (context === 'global') {
        socket.broadcast.emit('user typing', { user: socket.username, context: 'global' });
    } else {
        const targetSocketId = userSockets.get(context);
        if (targetSocketId && targetSocketId !== socket.id) {
            io.to(targetSocketId).emit('user typing', { user: socket.username, context: 'private' });
        }
    }
  });

  socket.on('stop typing', (context) => {
    if (!socket.username) return;
    
    if (context === 'global') {
        socket.broadcast.emit('user stop typing', { user: socket.username, context: 'global' });
    } else {
        const targetSocketId = userSockets.get(context);
        if (targetSocketId && targetSocketId !== socket.id) {
            io.to(targetSocketId).emit('user stop typing', { user: socket.username, context: 'private' });
        }
    }
  });

  // 7. Eliminar Mensaje
  socket.on('delete message', async (id, isPrivate) => {
    if (!socket.username) return;
    
    const table = isPrivate ? 'direct_messages' : 'messages';
    const userCol = isPrivate ? 'sender' : 'user_name';
    
    try {
      const check = await db.query(`SELECT ${userCol}, recipient FROM ${table} WHERE id = $1`, [id]);
      if (check.rows.length > 0 && check.rows[0][userCol] === socket.username) {
        
        await db.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
        
        io.emit('message deleted', id); 
        
        if (isPrivate) {
            const recipient = check.rows[0].recipient;
            if (recipient) {
                const recipientSocketId = userSockets.get(recipient);
                if (recipientSocketId) {
                    io.to(recipientSocketId).emit('message deleted', id);
                }
            }
        }
      }
    } catch (e) { console.error('Error al eliminar mensaje:', e); }
  });

  // 8. Limpiar Chat (Solo Global)
  socket.on('clear chat request', async () => {
    if (socket.username) {
      try {
        await db.query(`DELETE FROM messages`);
        io.emit('chat cleared'); 
        io.emit('system message', `${socket.username} limpió el chat global.`);
      } catch (err) { console.error('Error al limpiar chat:', err); }
    }
  });

  // 9. Desconexión
  socket.on('disconnect', () => {
    if (socket.username) {
      console.log(`${socket.username} disconnected`);
      
      onlineUsers.delete(socket.username);
      userSockets.delete(socket.username);
      
      io.emit('system message', `${socket.username} se ha desconectado.`);
      io.emit('update user list', Array.from(onlineUsers));
    } else {
      console.log('a user disconnected (not logged in)');
    }
  });
});

// --------------------------------------------------------------------------------
// 10. Iniciar Servidor
// --------------------------------------------------------------------------------

setupDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
  });
}).catch(err => {
    console.error('----------------------------------------------------');
    console.error('FATAL: El servidor NO PUDO INICIAR debido a un error de DB.');
    console.error('Revise su variable de entorno DATABASE_URL o la conexión a PostgreSQL.');
    console.error('----------------------------------------------------');
    process.exit(1);
});