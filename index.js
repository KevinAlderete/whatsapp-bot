// Importar módulos necesarios
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose"); // Nuevo: Mongoose para MongoDB
const xlsx = require("xlsx");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const path = require("path");
const {
  DisconnectReason,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
const makeWASocket = require("@whiskeysockets/baileys").default;

// Variables globales
let contador = { enviados: 0, recibidos: 0 };
let qrEmitted = false;
let sock = null;
let isLoggedOut = false;

// Configuración de MongoDB
const MONGO_URI = process.env.MONGODB_URL; // Cambiar según tu configuración
mongoose
  .connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("Conectado a MongoDB"))
  .catch((error) => console.error("Error conectando a MongoDB:", error));

// Definir el esquema y modelo para los mensajes
const messageSchema = new mongoose.Schema({
  fromMe: Boolean,
  phoneNumber: String,
  message: String,
  timestamp: Number,
  date: String,
  time: String,
});
const Message = mongoose.model("Message", messageSchema);

// Configuración del servidor
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// Configuración de Express
app.use(express.static("public"));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/download-messages", handleDownloadLog);
app.get("/download-excel", handleDownloadExcel);
app.post("/clear-messages-log", clearMessagesLog);

// Función: Descargar archivo de registro desde MongoDB
async function handleDownloadLog(req, res) {
  try {
    const messages = await Message.find({});
    res.json(messages);
  } catch (error) {
    console.error("Error al obtener mensajes:", error);
    res.status(500).send("No se pudo obtener el historial de mensajes.");
  }
}

// Función: Descargar archivo Excel desde MongoDB
async function handleDownloadExcel(req, res) {
  try {
    const messages = await Message.find({});
    const filePath = path.join(__dirname, "messages_log.xlsx");

    // Generar el archivo Excel
    saveMessagesToExcel(messages, filePath);

    // Descargar el archivo generado
    res.download(filePath, "messages_log.xlsx", (err) => {
      if (err) {
        console.error("Error al descargar el archivo Excel", err);
        res.status(500).send("No se pudo descargar el archivo Excel.");
      }
    });
  } catch (error) {
    console.error("Error al generar el archivo Excel:", error);
    res.status(500).send("No se pudo generar el archivo Excel.");
  }
}

// Función para guardar mensajes en Excel
function saveMessagesToExcel(messages, filePath) {
  const formattedMessages = messages.map((msg, index) => ({
    ID: index + 1,
    Numero: msg.phoneNumber,
    Mensaje: msg.message,
    Fecha: msg.date,
    Hora: msg.time,
    EnviadoRecibido: msg.fromMe ? "Enviado" : "Recibido",
  }));

  const worksheet = xlsx.utils.json_to_sheet(formattedMessages);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "Mensajes");

  xlsx.writeFile(workbook, filePath);
}

// Función para eliminar el historial de mensajes en MongoDB
async function clearMessagesLog(req, res) {
  try {
    await Message.deleteMany({});
    contador = { enviados: 0, recibidos: 0 };
    io.emit("updateCounters", contador); // Actualizar contadores en la interfaz
    res.status(200).send("Historial de mensajes eliminado exitosamente.");
  } catch (error) {
    console.error("Error al eliminar el historial:", error);
    res.status(500).send("Error al eliminar el historial.");
  }
}

// Lógica de conexión a WhatsApp
async function connectionLogic() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

  sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
  });

  sock.ev.on("connection.update", handleConnectionUpdate);
  sock.ev.on("messages.upsert", handleMessageUpsert);
  sock.ev.on("creds.update", saveCreds);
}

// Manejar actualizaciones de conexión
async function handleConnectionUpdate(update) {
  const { connection, lastDisconnect, qr } = update || {};

  if (qr && !qrEmitted) {
    qrEmitted = true;
    console.log("Generando código QR para conexión...");
    const qrCodeURL = await QRCode.toDataURL(qr);
    io.emit("qr", qrCodeURL);
  }

  if (connection === "close") {
    const shouldReconnect =
      lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

    if (
      lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut
    ) {
      isLoggedOut = true;
      console.log("Sesión cerrada intencionalmente.");
      io.emit("logout");
    } else if (!isLoggedOut && shouldReconnect) {
      console.log("Intentando reconectar...");
      connectionLogic();
    } else {
      console.log("Sesión cerrada, escanea nuevamente el QR.");
      io.emit("logout");
    }
  } else if (connection === "open") {
    console.log("¡Conexión establecida!");
    io.emit("connected");
  }
}

// Manejar mensajes entrantes y guardar en MongoDB
async function handleMessageUpsert(messageUpdate) {
  const messages = messageUpdate.messages || [];
  for (const msg of messages) {
    try {
      const {
        key: { fromMe, remoteJid: phoneNumber },
        message,
        messageTimestamp,
      } = msg;

      const messageContent =
        message?.conversation ||
        message?.extendedTextMessage?.text ||
        message?.imageMessage?.caption ||
        message?.videoMessage?.caption ||
        "[Mensaje sin texto]";

      const messageData = {
        fromMe,
        phoneNumber,
        message: messageContent,
        timestamp: messageTimestamp || Date.now() / 1000,
        date: new Date(
          (messageTimestamp || Date.now() / 1000) * 1000
        ).toLocaleDateString(),
        time: new Date(
          (messageTimestamp || Date.now() / 1000) * 1000
        ).toLocaleTimeString(),
      };

      await Message.create(messageData);

      if (fromMe) {
        contador.enviados += 1;
      } else {
        contador.recibidos += 1;
      }

      io.emit("updateCounters", contador);
    } catch (error) {
      console.error("Error procesando un mensaje:", error);
    }
  }
}

// Configuración de WebSocket
io.on("connection", (socket) => {
  socket.on("closeConnection", closeConnection);
  socket.on("reconnect", reconnect);
});

// Funciones para cerrar sesión y reconectar
function closeConnection() {
  if (sock) {
    sock.logout();
    console.log("Sesión cerrada manualmente.");
    isLoggedOut = true;
    io.emit("logout");
    qrEmitted = false;
  }
}

function reconnect() {
  if (isLoggedOut) {
    isLoggedOut = false;
    qrEmitted = false;
    connectionLogic();
  } else {
    console.log("No se puede reconectar sin cerrar sesión primero.");
  }
}

// Iniciar conexión y servidor
connectionLogic();
server.listen(PORT, () => {
  console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
});
