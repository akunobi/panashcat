// ==================================================================
// 1. IMPORTACIONES Y CONFIGURACIÓN DEL SERVIDOR
// ==================================================================
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);

// Configuración de Socket.IO con límites aumentados para imágenes
const io = new Server(server, { 
  maxHttpBufferSize: 50 * 1024 * 1024, // 50MB
  transports: ['websocket', 'polling'], // Compatibilidad máxima
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000; 

// ==================================================================
// 2. ESTADO Y CONFIGURACIÓN DE USUARIOS
// ==================================================================

// Lista fija de usuarios para que siempre aparezcan en la barra lateral,
// incluso si están desconectados.
const ALL_USERS = ['Rafa', 'Hugo', 'Sergio', 'Álvaro'];

// Set para rastrear quién está conectado actualmente en tiempo real
const onlineUsers = new Set();

// ==================================================================
// 3. CONEXIÓN A LA BASE DE DATOS (PostgreSQL)
// ==================================================================
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Necesario para Render/Heroku
});

// Función para inicializar tablas
async function setupDatabase() {
  try {
    console.log('--- 🛠️  Iniciando configuración de Base de Datos ---');
    
    // A. Crear tabla de mensajes GLOBALES
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

    // B. Crear tabla de mensajes PRIVADOS (DMs)
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
    
    // C. Parches para asegurar que existan las columnas si la DB es vieja
    try { await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text'`); } catch(e){}
    try { await db.query(`ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text'`); } catch(e){}

    console.log('✅ Base de datos lista y tablas verificadas.');
  } catch (err) {
    console.error('❌ Error fatal al conectar con la DB:', err);
  }
}
// Ejecutar configuración al inicio
setupDatabase();

// ==================================================================
// 4. RUTAS Y ARCHIVOS ESTÁTICOS
// ==================================================================
app.use('/images', express.static(path.join(__dirname, 'images')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Función auxiliar para emitir la lista de usuarios a todos los clientes
function broadcastUserList() {
    const list = ALL_USERS.map(u => ({
        name: u,
        isOnline: onlineUsers.has(u)
    }));
    io.emit('update_user_list', list);
}

// ==================================================================
// 5. LÓGICA DE SOCKETS (EL CHAT)
// ==================================================================
io.on('connection', (socket) => {
  console.log(`🔌 Nuevo socket conectado: ${socket.id}`);

  // --- A. EVENTO DE LOGIN ---
  socket.on('login', (username) => {
    if (!username) return;

    console.log(`🔑 Usuario intentando entrar: ${username}`);
    socket.username = username;
    
    // Unimos al usuario a su propia sala (clave para recibir DMs)
    socket.join(username);
    onlineUsers.add(username);
    
    // 1. Confirmamos al usuario que el login fue exitoso
    socket.emit('login_success', username);
    
    // 2. Actualizamos la lista para todos (para mostrar puntos verdes)
    broadcastUserList();
    
    // 3. Mensaje de sistema (opcional, solo local)
    // socket.broadcast.emit('system_message', `${username} se ha conectado.`);
  });

  // --- B. CAMBIAR DE CHAT / CARGAR HISTORIAL ---
  socket.on('join_chat', async ({ target }) => {
    if (!socket.username) return;
    
    // Cargar mensajes de los últimos 30 días
    const limit = Math.floor(Date.now() / 1000) - (86400 * 30); 

    try {
        let history = [];

        if (target === 'global') {
            // --- Cargar Historial GLOBAL ---
            const res = await db.query(
                `SELECT * FROM messages WHERE timestamp > $1 ORDER BY id ASC`, 
                [limit]
            );
            
            history = res.rows.map(row => ({
                id: row.id,
                user: row.user_name,
                text: row.text,
                timestamp: row.timestamp,
                replyTo: row.reply_to_id,
                type: row.message_type || 'text',
                isPrivate: false
            }));

        } else {
            // --- Cargar Historial PRIVADO ---
            // Buscamos mensajes donde YO sea el remitente O el receptor
            // Y la otra persona sea el TARGET
            const res = await db.query(`
                SELECT * FROM direct_messages 
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
                replyTo: row.reply_to_id,
                type: row.message_type || 'text',
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

  // --- C. ENVIAR MENSAJE (TEXTO O IMAGEN) ---
  socket.on('chat_message', async (data) => {
    if (!socket.username) return;

    const { text, type, replyTo, target } = data;
    const ts = Math.floor(Date.now() / 1000);

    console.log(`📩 Mensaje de ${socket.username} para ${target} (${type})`);

    try {
        if (target === 'global') {
            // 1. Guardar en Tabla Global
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
            
            // 2. Enviar a todos
            io.emit('chat_message', msg);

        } else {
            // 1. Guardar en Tabla Privada (DMs)
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
            
            // 2. Enviar a las salas de AMBOS involucrados
            // Esto asegura que el remitente vea su propio mensaje y el destinatario lo reciba
            io.to(socket.username).to(target).emit('chat_message', msg);
        }
    } catch(e) {
        console.error("Error guardando mensaje:", e);
    }
  });

  // --- D. BORRAR MENSAJE ---
  socket.on('delete_message', async (id) => {
      try {
        // Intentamos borrar de ambas tablas, verificando que el usuario sea el dueño
        await db.query(`DELETE FROM messages WHERE id=$1 AND user_name=$2`, [id, socket.username]);
        await db.query(`DELETE FROM direct_messages WHERE id=$1 AND sender=$2`, [id, socket.username]);
        
        // Emitimos el evento de borrado a todos (simplificación válida)
        io.emit('message_deleted', id);
      } catch(e) { console.error(e); }
  });

  // --- E. LIMPIAR CHAT (SOLO GLOBAL) ---
  socket.on('clear_chat', async () => {
      if(!socket.username) return;
      try {
          await db.query('DELETE FROM messages');
          io.emit('chat_cleared');
          io.emit('system_message', `${socket.username} ha limpiado el chat global.`);
      } catch(e) { console.error(e); }
  });

  // --- F. EVENTOS DE ESCRITURA ---
  socket.on('typing', () => socket.broadcast.emit('user_typing', socket.username));
  socket.on('stop_typing', () => socket.broadcast.emit('user_stop_typing', socket.username));
  
  // --- G. DESCONEXIÓN ---
  socket.on('disconnect', () => {
    if (socket.username) {
        console.log(`❌ Usuario desconectado: ${socket.username}`);
        onlineUsers.delete(socket.username);
        
        // Actualizamos la lista (el usuario pasará a estar offline/gris)
        broadcastUserList();
    }
  });
});

// Arrancar servidor
server.listen(PORT, () => {
  console.log(`🚀 Servidor funcionando correctamente en el puerto ${PORT}`);
});