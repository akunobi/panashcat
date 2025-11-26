const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Pool } = require('pg');

// 1. CONFIGURACIÓN DEL SERVIDOR
const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  maxHttpBufferSize: 50 * 1024 * 1024, // 50MB para subida de imágenes
  transports: ['websocket', 'polling'],
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000; 

// 2. LISTA DE USUARIOS Y ESTADO
// Definimos los usuarios fijos para que aparezcan aunque estén offline
const ALL_USERS = ['Rafa', 'Hugo', 'Sergio', 'Álvaro'];
const onlineUsers = new Set();

// 3. CONEXIÓN BASE DE DATOS
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- INICIALIZACIÓN DE BASE DE DATOS ---
async function setupDatabase() {
  try {
    console.log('--- Verificando estado de la Base de Datos ---');
    
    // Tabla de Mensajes Globales
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

    // Tabla de Mensajes Privados (DMs)
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
    
    // Asegurar que las columnas existan (por si la DB fue creada con versiones anteriores)
    try { await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text'`); } catch(e){}
    try { await db.query(`ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text'`); } catch(e){}

    console.log('✅ Base de datos lista y configurada.');
  } catch (err) {
    console.error('❌ Error fatal al configurar la DB:', err);
  }
}
setupDatabase();

// Servir archivos estáticos
app.use('/images', express.static(path.join(__dirname, 'images')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Función auxiliar para enviar la lista de usuarios con su estado (Online/Offline)
function broadcastUserList() {
    const list = ALL_USERS.map(u => ({
        name: u,
        isOnline: onlineUsers.has(u)
    }));
    io.emit('update_user_list', list);
}

// 4. LÓGICA DE SOCKETS
io.on('connection', (socket) => {
  console.log(`🔌 Cliente conectado: ${socket.id}`);

  // --- LOGIN ---
  socket.on('login', (username) => {
    if (!username) return;

    console.log(`🔑 Usuario logueado: ${username}`);
    socket.username = username;
    
    // Unir al usuario a su propia sala (para recibir DMs)
    socket.join(username);
    onlineUsers.add(username);
    
    // 1. Confirmar al usuario que el login fue exitoso
    socket.emit('login_success', username);
    
    // 2. Actualizar la lista de usuarios para todos (para mostrar puntos verdes)
    broadcastUserList();
  });

  // --- UNIRSE A UN CHAT (CARGAR HISTORIAL) ---
  socket.on('join_chat', async ({ target }) => {
    if (!socket.username) return;
    
    // Cargar mensajes de los últimos 30 días
    const limit = Math.floor(Date.now() / 1000) - (86400 * 30); 

    try {
        let history = [];

        if (target === 'global') {
            // Historial Global
            const res = await db.query(
                `SELECT * FROM messages WHERE timestamp > $1 ORDER BY id ASC`, 
                [limit]
            );
            
            // Mapeamos los datos para que el frontend los entienda fácil
            history = res.rows.map(row => ({
                id: row.id,
                user: row.user_name,
                text: row.text,
                timestamp: row.timestamp,
                replyTo: row.reply_to_id, // Normalizado
                type: row.message_type,   // Normalizado
                isPrivate: false
            }));

        } else {
            // Historial Privado: Mensajes entre YO y el TARGET
            const res = await db.query(
                `SELECT * FROM direct_messages 
                 WHERE timestamp > $1 
                 AND ( (sender=$2 AND receiver=$3) OR (sender=$3 AND receiver=$2) )
                 ORDER BY id ASC`,
                [limit, socket.username, target]
            );

            history = res.rows.map(row => ({
                id: row.id,
                user: row.sender,
                text: row.text,
                timestamp: row.timestamp,
                replyTo: row.reply_to_id, // Normalizado
                type: row.message_type,   // Normalizado
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

  // --- ENVIAR MENSAJE ---
  socket.on('chat_message', async (data) => {
    if (!socket.username) return;

    const { text, type, replyTo, target } = data;
    const ts = Math.floor(Date.now() / 1000);

    console.log(`📩 Mensaje de ${socket.username} para ${target}`);

    try {
        if (target === 'global') {
            // Guardar en Global
            const res = await db.query(
                `INSERT INTO messages (user_name, text, timestamp, reply_to_id, message_type) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                [socket.username, text, ts, replyTo, type]
            );
            
            const msg = { 
                id: res.rows[0].id, 
                user: socket.username, 
                text, timestamp: ts, replyTo, type, 
                isPrivate: false 
            };
            
            // Enviar a todos
            io.emit('chat_message', msg);

        } else {
            // Guardar en DM (Privado)
            const res = await db.query(
                `INSERT INTO direct_messages (sender, receiver, text, timestamp, reply_to_id, message_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [socket.username, target, text, ts, replyTo, type]
            );
            
            const msg = { 
                id: res.rows[0].id, 
                user: socket.username, 
                text, timestamp: ts, replyTo, type, 
                isPrivate: true, receiver: target 
            };
            
            // Enviar a las salas de ambos (Remitente y Destinatario)
            // Esto asegura que ambos vean el mensaje en tiempo real
            io.to(socket.username).to(target).emit('chat_message', msg);
        }
    } catch(e) {
        console.error("Error guardando mensaje:", e);
    }
  });

  // --- BORRAR MENSAJE ---
  socket.on('delete_message', async (id) => {
      try {
        // Intentar borrar de ambas tablas verificando que el usuario sea el dueño
        await db.query(`DELETE FROM messages WHERE id=$1 AND user_name=$2`, [id, socket.username]);
        await db.query(`DELETE FROM direct_messages WHERE id=$1 AND sender=$2`, [id, socket.username]);
        io.emit('message_deleted', id);
      } catch(e) { console.error(e); }
  });

  // --- LIMPIAR CHAT (Solo Global) ---
  socket.on('clear_chat', async () => {
      if(!socket.username) return;
      await db.query('DELETE FROM messages');
      io.emit('chat_cleared');
      io.emit('system_message', `${socket.username} ha limpiado el chat.`);
  });

  // --- ESTADOS (Escribiendo...) ---
  socket.on('typing', () => socket.broadcast.emit('user_typing', socket.username));
  socket.on('stop_typing', () => socket.broadcast.emit('user_stop_typing', socket.username));
  
  // --- DESCONEXIÓN ---
  socket.on('disconnect', () => {
    if (socket.username) {
        console.log(`❌ Usuario desconectado: ${socket.username}`);
        onlineUsers.delete(socket.username);
        // Actualizar lista (se pondrá en gris)
        broadcastUserList();
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Servidor funcionando en el puerto ${PORT}`);
});