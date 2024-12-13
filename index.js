require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const { Server } = require("socket.io");
const http = require("http");
const QRCode = require("qrcode");
const fs = require("fs");
const { DateTime } = require("luxon");
const XLSX = require("xlsx");
const path = require("path");
const {
  DisconnectReason,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
const makeWASocket = require("@whiskeysockets/baileys").default;
const cors = require("cors"); // Para permitir solicitudes del frontend

// Configuración del servidor
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(cors()); // Habilitar CORS
app.use(express.static("public"));
app.use(express.json()); // Permitir solicitudes JSON

// Manejador de sesiones por instancia
const sessions = {}; // Objeto para almacenar sesiones activas

// Conexión a MongoDB
mongoose
  .connect(process.env.MONGODB_URL)
  .then(() => {
    console.log("Conectado a MongoDB");
  })
  .catch((err) => {
    console.error("Error al conectar a MongoDB", err);
  });

// Definir el esquema y modelo para los mensajes
const messageSchema = new mongoose.Schema({
  instanceId: { type: String, required: true },
  senderNumber: { type: String, required: true }, // Número de quien envía el mensaje
  message: { type: String, required: true },
  messageType: { type: String, enum: ["sent", "received"], required: true }, // Tipo de mensaje (enviado o recibido)
  timestamp: { type: Date, default: Date.now },
  timestampLima: { type: Date, required: true },
  hourUTC: { type: String, required: true }, // Campo adicional para la hora en UTC
  hourLima: { type: String, required: true }, // Campo adicional para la hora en Lima
});

const Message = mongoose.model("MessageR", messageSchema);

// Función para guardar el mensaje en MongoDB
async function saveMessage(instanceId, senderNumber, message, messageType) {
  try {
    // Obtener la fecha actual en UTC
    const utcDate = new Date();

    // Obtener la fecha actual ajustada a la zona horaria de Lima
    const limaDate = DateTime.fromJSDate(utcDate, {
      zone: "America/Lima",
    }).toJSDate();

    // Extraer solo la hora en formato de 24 horas
    const hourUTC = DateTime.fromJSDate(utcDate).toFormat("HH:mm"); // Hora en UTC
    const hourLima = DateTime.fromJSDate(limaDate).toFormat("HH:mm"); // Hora en Lima

    // Crear un nuevo mensaje con ambas fechas y horas
    const newMessage = new Message({
      instanceId,
      senderNumber,
      message,
      messageType,
      timestamp: utcDate, // Guardar la fecha en UTC
      timestampLima: limaDate, // Guardar la fecha ajustada a Lima
      hourUTC, // Guardar solo la hora en UTC
      hourLima, // Guardar solo la hora en Lima
    });

    await newMessage.save();
    console.log(
      `Mensaje guardado para la instancia ${instanceId} de ${senderNumber}`
    );
  } catch (error) {
    console.error("Error al guardar el mensaje:", error);
  }
}

// Función para inicializar una nueva instancia de conexión
async function initializeSession(instanceId) {
  const { state, saveCreds } = await useMultiFileAuthState(
    `sessions/${instanceId}`
  );

  const sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
  });

  // Manejo de eventos de conexión
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`QR generado para la instancia: ${instanceId}`);
      const qrCodeURL = await QRCode.toDataURL(qr);
      io.emit("qr", { instanceId, qr: qrCodeURL });
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log(`Reconectando la instancia: ${instanceId}`);
        initializeSession(instanceId);
      } else {
        console.log(`Sesión cerrada para la instancia: ${instanceId}`);
        io.emit("logout", { instanceId });
        delete sessions[instanceId]; // Eliminar sesión de la memoria
      }
    }

    if (connection === "open") {
      console.log(`Instancia conectada: ${instanceId}`);
      io.emit("connected", { instanceId });
    }
  });

  // Evento de mensaje entrante
  sock.ev.on("messages.upsert", async (m) => {
    const { messages } = m;
    messages.forEach(async (msg) => {
      const messageType = msg.key.fromMe ? "sent" : "received"; // Determina si es enviado o recibido

      // Determinar el contenido del mensaje según el tipo
      let message = "";
      const msgType = Object.keys(msg.message)[0];

      switch (msgType) {
        case "conversation":
          message = msg.message.conversation;
          break;
        case "extendedTextMessage":
          message = msg.message.extendedTextMessage.text;
          break;
        case "imageMessage":
          message = msg.message.imageMessage.caption || "[Imagen sin texto]";
          break;
        case "videoMessage":
          message = "[Video]";
          break;
        case "documentMessage":
          message =
            "[Documento: " +
            (msg.message.documentMessage.title || "sin título") +
            "]";
          break;
        case "audioMessage":
          message = "[Audio]";
          break;
        case "stickerMessage":
          message = "[Sticker]";
          break;
        default:
          message = "[Mensaje no soportado]";
      }

      const senderNumber = msg.key.remoteJid; // Número de quien envió el mensaje

      // Registrar en consola
      console.log(
        `Mensaje ${messageType} en la instancia ${instanceId}: ${senderNumber} -> ${message}`
      );

      // Guardar el mensaje en MongoDB
      await saveMessage(instanceId, senderNumber, message, messageType);
    });
  });

  sock.ev.on("creds.update", saveCreds);
  sessions[instanceId] = sock; // Guardar la sesión activa
}

// Rutas del backend
app.get("/instances", (req, res) => {
  const activeSessions = Object.keys(sessions).map((id) => ({
    id,
    connected: sessions[id]?.connection === "open",
    qr: null, // El QR se envía por WebSocket
  }));
  res.json(activeSessions);
});

app.post("/instances/:id/start", async (req, res) => {
  const { id } = req.params;

  if (sessions[id]) {
    return res.status(400).send("La instancia ya está activa.");
  }

  await initializeSession(id);
  res.json({ message: "Instancia iniciada." });
});

// Ruta para cerrar sesión y eliminarla
app.post("/instances/:id/logout", async (req, res) => {
  const { id } = req.params;
  const session = sessions[id];

  if (!session) {
    return res.status(404).send("Instancia no encontrada.");
  }

  try {
    // Cerrar sesión y eliminar sesión de la memoria
    await session.logout();
    delete sessions[id];

    // Eliminar el archivo de sesión en el sistema de archivos
    const sessionPath = path.join(__dirname, `sessions/${id}`);
    if (fs.existsSync(sessionPath)) {
      fs.rmdirSync(sessionPath, { recursive: true });
      console.log(`Se eliminó la sesión del sistema de archivos: ${id}`);
    }

    res.json({ message: "Sesión cerrada y eliminada." });
  } catch (error) {
    console.error("Error al cerrar la sesión:", error);
    res.status(500).send("Hubo un problema al cerrar la sesión.");
  }
});

// Función para enviar mensajes (enviar mensaje, guardar en base de datos)
async function sendMessage(instanceId, recipientNumber, message) {
  const sock = sessions[instanceId];
  if (sock) {
    await sock.sendMessage(recipientNumber, { text: message });
    console.log(
      `Mensaje enviado desde la instancia ${instanceId} a ${recipientNumber}: ${message}`
    );
    // Guardar el mensaje enviado en MongoDB
    await saveMessage(instanceId, recipientNumber, message, "sent");
  }
}

// Ruta para exportar los mensajes a un archivo Excel
app.get("/export-messages", async (req, res) => {
  try {
    // Obtener los mensajes de la base de datos
    const messages = await Message.find({});

    // Si no hay mensajes, enviar una respuesta adecuada
    if (messages.length === 0) {
      return res.status(404).send("No hay mensajes para exportar.");
    }

    // Transformar los mensajes a un formato adecuado para Excel
    const data = messages.map((msg) => ({
      "ID de Instancia": msg.instanceId,
      "Número del Remitente": msg.senderNumber,
      Mensaje: msg.message,
      "Tipo de Mensaje": msg.messageType,
      "Fecha (UTC)": msg.timestamp,
      "Fecha (Lima)": msg.timestampLima,
      "Hora (UTC)": msg.hourUTC,
      "Hora (Lima)": msg.hourLima,
    }));

    // Crear una hoja de trabajo de Excel
    const ws = XLSX.utils.json_to_sheet(data);

    // Crear un libro de trabajo
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Mensajes");

    // Generar el archivo Excel
    const filePath = path.join(__dirname, "mensajes.xlsx");

    // Escribir el archivo en el sistema de archivos
    XLSX.writeFile(wb, filePath);

    // Enviar el archivo Excel como respuesta
    res.download(filePath, "mensajes.xlsx", (err) => {
      if (err) {
        console.error("Error al descargar el archivo Excel:", err);
        res.status(500).send("Hubo un problema al generar el archivo.");
      }
    });
  } catch (error) {
    console.error("Error al exportar los mensajes:", error);
    res.status(500).send("Hubo un problema al exportar los mensajes.");
  }
});

// Servidor y sockets
io.on("connection", (socket) => {
  console.log("Cliente conectado al WebSocket");
});

server.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
