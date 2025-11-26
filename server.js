const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  maxHttpBufferSize: 50 * 1024 * 1024, 
  transports: ['websocket'], 
  upgrade: false,
  cors: { origin: "*" }
});
const PORT = process.env.PORT || 3000; 

const onlineUsers = new Set();

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- BASE DE DATOS ROBUSTA ---
async function setupDatabase() {
  try {
    console.log('🔧 Verificando tablas de Base de Datos...');
    
    // 1. Tabla Global
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

    // 2. Tabla Privada (DMs)
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
    
    // 3. Asegurar columnas (Parches)
    try { await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text'`); } catch(e){}
    try { await db.query(`ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text'`); } catch(e){}

    console.log('✅ Base de datos lista y verificada.');
  } catch (err) {
    console.error('❌ Error CRÍTICO en DB:', err);
  }
}
setupDatabase();

app.use('/images', express.static(path.join(__dirname, 'images')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

io.on('connection', (socket) => {
  console.log(`🔌 Cliente conectado: ${socket.id}`);

  // LOGIN
  socket.on('login', (username) => {
    if (!username) return;
    socket.username = username;
    
    // Unir a sala personal para recibir DMs
    socket.join(username); 
    onlineUsers.add(username);
    
    socket.emit('login_success', username);
    io.emit('update_users', Array.from(onlineUsers));
    console.log(`👤 Usuario logueado: ${username}`);
  });

  // UNIRSE A CHAT / CARGAR HISTORIAL
  socket.on('join_chat', async ({ target }) => {
    if (!socket.username) return;
    const limit = Math.floor(Date.now() / 1000) - 1209600; // 2 semanas

    try {
        let history = [];
        if (target === 'global') {
            const res = await db.query(`SELECT * FROM messages WHERE timestamp > $1 ORDER BY id ASC`, [limit]);
            history = res.rows.map(r => ({
                id: r.id, user: r.user_name, text: r.text, timestamp: r.timestamp, 
                replyTo: r.reply_to_id, type: r.message_type || 'text', isPrivate: false
            }));
        } else {
            // Cargar DMs (enviados por mi O recibidos por mi)
            const res = await db.query(`
                SELECT * FROM direct_messages 
                WHERE timestamp > $1 
                AND ((sender=$2 AND receiver=$3) OR (sender=$3 AND receiver=$2))
                ORDER BY id ASC`, 
                [limit, socket.username, target]
            );
            history = res.rows.map(r => ({
                id: r.id, user: r.sender, text: r.text, timestamp: r.timestamp, 
                replyTo: r.reply_to_id, type: r.message_type || 'text', isPrivate: true, receiver: r.receiver
            }));
        }
        socket.emit('chat_history', { history, context: target });
    } catch(e) { 
        console.error("❌ Error cargando historial:", e.message); 
    }
  });

  // ENVIAR MENSAJE (AQUÍ ESTABA EL PROBLEMA)
  socket.on('send_msg', async (data) => {
    if (!socket.username) return;
    
    // Aseguramos que data tenga la estructura correcta
    const { text, type, replyTo, target } = data;
    const ts = Math.floor(Date.now() / 1000);

    console.log(`📩 Recibido mensaje de ${socket.username} para ${target}: ${text.substring(0, 10)}...`);

    try {
        if (target === 'global') {
            // --- GLOBAL ---
            const res = await db.query(
                `INSERT INTO messages (user_name, text, timestamp, reply_to_id, message_type) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                [socket.username, text, ts, replyTo, type]
            );
            const msg = { id: res.rows[0].id, user: socket.username, text, timestamp: ts, replyTo, type, isPrivate: false };
            io.emit('new_msg', msg);
        
        } else {
            // --- PRIVADO (DM) ---
            const res = await db.query(
                `INSERT INTO direct_messages (sender, receiver, text, timestamp, reply_to_id, message_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [socket.username, target, text, ts, replyTo, type]
            );
            const msg = { id: res.rows[0].id, user: socket.username, text, timestamp: ts, replyTo, type, isPrivate: true, receiver: target };
            
            // Enviamos a MI MISMO y al DESTINATARIO
            io.to(socket.username).to(target).emit('new_msg', msg);
            console.log(`✅ DM guardado y enviado a ${socket.username} y ${target}`);
        }
    } catch(e) { 
        console.error("❌ ERROR GUARDANDO MENSAJE EN DB:", e.message); 
        // Avisar al usuario que falló (opcional, pero útil)
        socket.emit('system_error', 'Error al guardar mensaje en base de datos.');
    }
  });

  // BORRAR
  socket.on('delete_msg', async (id) => {
      try {
        await db.query(`DELETE FROM messages WHERE id=$1 AND user_name=$2`, [id, socket.username]);
        await db.query(`DELETE FROM direct_messages WHERE id=$1 AND sender=$2`, [id, socket.username]);
        io.emit('msg_deleted', id);
      } catch(e){}
  });

  socket.on('disconnect', () => {
    if(socket.username) {
        onlineUsers.delete(socket.username);
        io.emit('update_users', Array.from(onlineUsers));
    }
  });
});

server.listen(PORT, () => console.log(`🚀 Server OK: ${PORT}`));