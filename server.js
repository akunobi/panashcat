// server.js
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Pool } = require('pg');

// ---- Configuración Inicial ----
const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  maxHttpBufferSize: 50 * 1024 * 1024, // 50MB para imágenes
  transports: ['websocket'], 
  upgrade: false 
});
const PORT = process.env.PORT || 3000; 

// ---- Listas de usuarios (Simulación de Auth) ----
// Puedes añadir más o quitar esta restricción si quieres
const allowedUsers = ['Rafa', 'Hugo', 'Sergio', 'Álvaro', 'Invitado'];
const onlineUsers = new Set();

// ---- Configuración de Base de Datos (PostgreSQL) ----
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
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

    // 2. Tabla Mensajes Privados (NUEVA)
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
    
    console.log('Tablas configuradas correctamente.');
  } catch (err) {
    console.error('Error config DB:', err);
  }
}

// Configurar archivos estáticos
app.use(express.static(path.join(__dirname, '/')));

// ---- SOCKET.IO LOGIC ----
io.on('connection', (socket) => {
  console.log('Nuevo socket conectado:', socket.id);

  // 1. Login
  socket.on('login', async (username) => {
    // Validación simple (puedes quitar el check de allowedUsers si quieres entrada libre)
    /* if (!allowedUsers.includes(username)) {
       socket.emit('login error', 'Usuario no permitido');
       return;
    } */

    socket.username = username;
    onlineUsers.add(username);
    
    // Unir al usuario a su propia sala personal para recibir notificaciones
    socket.join(username);

    socket.emit('login success', username);
    io.emit('update user list', Array.from(onlineUsers));
    io.emit('system message', `${username} ha entrado al chat.`);
  });

  // 2. Unirse a una sala (Global o Privada) y cargar historial
  socket.on('join chat room', async ({ target, type }) => {
    if (!socket.username) return;

    // Salir de salas de chat previas (excepto su sala personal 'socket.username')
    const rooms = Array.from(socket.rooms);
    rooms.forEach(room => {
        if (room !== socket.id && room !== socket.username) {
            socket.leave(room);
        }
    });

    if (type === 'global') {
        socket.join('global_room');
        
        // Cargar historial Global
        const res = await db.query('SELECT * FROM messages ORDER BY id ASC');
        socket.emit('chat history', res.rows);

    } else if (type === 'private') {
        // Crear ID único para la sala: "UsuarioA_UsuarioB" (orden alfabético)
        const users = [socket.username, target].sort();
        const roomName = `dm_${users[0]}_${users[1]}`;
        
        socket.join(roomName);

        // Cargar historial Privado
        const res = await db.query(`
            SELECT * FROM direct_messages 
            WHERE (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)
            ORDER BY id ASC
        `, [socket.username, target]);
        
        // Formatear para que el frontend lo lea igual (user_name = sender)
        const history = res.rows.map(m => ({
            id: m.id,
            user_name: m.sender,
            text: m.text,
            timestamp: m.timestamp,
            message_type: m.message_type,
            reply_to_id: m.reply_to_id,
            isPrivate: true
        }));
        
        socket.emit('chat history', history);
    }
  });

  // 3. Chat Message (Global o Privado)
  socket.on('chat message', async (data) => {
    if (!socket.username) return;

    const { text, type, replyTo, targetUser, isPrivate } = data;
    const timestamp = Date.now();

    try {
        if (isPrivate && targetUser) {
            // --- Lógica Privada ---
            const insertQ = `
              INSERT INTO direct_messages (sender, receiver, text, timestamp, message_type, reply_to_id)
              VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
            `;
            const result = await db.query(insertQ, [socket.username, targetUser, text, timestamp, type, replyTo]);
            
            const newMsg = {
                id: result.rows[0].id,
                user_name: socket.username, // Para que el frontend sepa quien lo envió
                text, timestamp,
                message_type: type,
                reply_to_id: replyTo,
                isPrivate: true,
                receiver: targetUser
            };

            // Enviar a ambos usuarios (remitente y destinatario)
            // Usamos io.to(username) porque al loguearse se unieron a esa sala
            io.to(socket.username).to(targetUser).emit('private message incoming', newMsg);

        } else {
            // --- Lógica Global ---
            const insertQ = `
              INSERT INTO messages (user_name, text, timestamp, message_type, reply_to_id)
              VALUES ($1, $2, $3, $4, $5) RETURNING id
            `;
            const result = await db.query(insertQ, [socket.username, text, timestamp, type, replyTo]);
            
            const newMsg = {
                id: result.rows[0].id,
                user_name: socket.username,
                text, timestamp,
                message_type: type,
                reply_to_id: replyTo
            };
            
            // Emitir a todos (o a la sala global_room si prefieres aislarlo más)
            io.emit('chat message', newMsg);
        }
    } catch (err) {
        console.error("Error guardando mensaje:", err);
    }
  });

  // 4. Typing
  socket.on('user typing', () => {
     // Esto lo simplificamos: broadcast global para no complicar el ejemplo,
     // idealmente debería ser por sala.
     socket.broadcast.emit('user typing', socket.username);
  });
  
  socket.on('user stop typing', () => {
     socket.broadcast.emit('user stop typing', socket.username);
  });

  // 5. Borrar Mensaje
  socket.on('delete message', async (messageId) => {
     // Nota: Para simplificar, este script borra solo de la tabla global. 
     // Deberías añadir lógica extra si quieres borrar privados también.
     try {
        const check = await db.query('SELECT user_name FROM messages WHERE id = $1', [messageId]);
        if(check.rows.length > 0 && check.rows[0].user_name === socket.username) {
            await db.query('DELETE FROM messages WHERE id = $1', [messageId]);
            io.emit('message deleted', messageId);
        }
     } catch(e) { console.error(e); }
  });

  // 6. Limpiar Chat (Solo Global por seguridad)
  socket.on('clear chat request', async () => {
      await db.query('DELETE FROM messages');
      io.emit('chat cleared');
  });

  // 7. Desconexión
  socket.on('disconnect', () => {
    if (socket.username) {
      onlineUsers.delete(socket.username);
      io.emit('update user list', Array.from(onlineUsers));
      io.emit('system message', `${socket.username} se ha marchado.`);
    }
  });
});

// Arrancar
setupDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
  });
});