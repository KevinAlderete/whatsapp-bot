// // Importar módulos necesarios
// const express = require("express");
// const xlsx = require("xlsx");
// const http = require("http");
// const { Server } = require("socket.io");
// const QRCode = require("qrcode");
// const fs = require("fs");
// const path = require("path");
// const {
//   DisconnectReason,
//   useMultiFileAuthState,
// } = require("@whiskeysockets/baileys");
// const makeWASocket = require("@whiskeysockets/baileys").default;

// // Variables globales
// let contador = { enviados: 0, recibidos: 0 };
// let qrEmitted = false;
// let sock = null;
// let isLoggedOut = false;
// let messagesGroupedByPhone = {}; // Agrupar mensajes por número de teléfono

// // Configuración del servidor
// const app = express();
// const server = http.createServer(app);
// const io = new Server(server);
// const PORT = 3000;

// // Configuración de Express
// app.use(express.static("public"));
// app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
// app.get("/download-messages", handleDownloadLog);
// app.get("/download-excel", handleDownloadExcel);
// // Nueva ruta para eliminar el historial
// app.post("/clear-messages-log", clearMessagesLog);

// // Función: Descargar archivo de registro (JSON)
// function handleDownloadLog(req, res) {
//   const messagesLogPath = path.join(__dirname, "messages_grouped_log.json");
//   if (fs.existsSync(messagesLogPath)) {
//     res.download(messagesLogPath, "messages_grouped_log.json", (err) => {
//       if (err) {
//         console.error("Error al descargar el archivo", err);
//         res.status(500).send("No se pudo descargar el archivo.");
//       }
//     });
//   } else {
//     res.status(404).send("El archivo de registro no existe.");
//   }
// }

// // Función: Descargar archivo Excel
// function handleDownloadExcel(req, res) {
//   const excelFilePath = path.join(__dirname, "messages_log.xlsx");

//   // Generar el archivo Excel con los datos actualizados
//   saveMessagesToExcel(messagesGroupedByPhone, excelFilePath);

//   // Descargar el archivo actualizado
//   res.download(excelFilePath, "messages_log.xlsx", (err) => {
//     if (err) {
//       console.error("Error al descargar el archivo Excel", err);
//       res.status(500).send("No se pudo descargar el archivo Excel.");
//     }
//   });
// }

// // Función para generar el archivo Excel a partir de los mensajes agrupados por número
// function saveMessagesToExcel(messagesGroupedByPhone, filePath) {
//   // Convertir los mensajes agrupados en un formato adecuado para el Excel
//   let allMessages = [];
//   for (const phoneNumber in messagesGroupedByPhone) {
//     const groupedMessages = messagesGroupedByPhone[phoneNumber];
//     allMessages = allMessages.concat(groupedMessages);
//   }

//   // Agregar ID, Enviado/Recibido y formato de mensaje
//   const messagesWithDetails = allMessages.map((msg, index) => ({
//     ID: index + 1, // ID único basado en el índice (comienza en 1)
//     Numero: msg.phoneNumber,
//     Mensaje: msg.message,
//     Fecha: msg.date,
//     Hora: msg.time,
//     EnviadoRecibido: msg.fromMe ? "Enviado" : "Recibido",
//   }));

//   const worksheet = xlsx.utils.json_to_sheet(messagesWithDetails);
//   const workbook = xlsx.utils.book_new();
//   xlsx.utils.book_append_sheet(workbook, worksheet, "Mensajes");

//   // Escribir el archivo Excel
//   xlsx.writeFile(workbook, filePath);
// }

// // Función para eliminar todo el historial de mensajes registrados
// function clearMessagesLog(req, res) {
//   try {
//     // Resetear la variable global
//     messagesGroupedByPhone = {};

//     // Eliminar el archivo de registro si existe
//     const logFilePath = path.join(__dirname, "messages_grouped_log.json");
//     if (fs.existsSync(logFilePath)) {
//       fs.unlinkSync(logFilePath);
//       console.log("Archivo de registro eliminado.");
//     }

//     // Eliminar el archivo Excel si existe
//     const excelFilePath = path.join(__dirname, "messages_log.xlsx");
//     if (fs.existsSync(excelFilePath)) {
//       fs.unlinkSync(excelFilePath);
//       console.log("Archivo Excel eliminado.");
//     }

//     // Resetear los contadores
//     contador = { enviados: 0, recibidos: 0 };

//     // Notificar éxito
//     io.emit("updateCounters", contador); // Actualizar los contadores en la interfaz
//     res.status(200).send("Historial de mensajes eliminado exitosamente.");
//   } catch (error) {
//     console.error("Error al eliminar el historial de mensajes:", error);
//     res.status(500).send("Error al eliminar el historial.");
//   }
// }

// // Lógica de conexión a WhatsApp
// async function connectionLogic() {
//   const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

//   sock = makeWASocket({
//     printQRInTerminal: true,
//     auth: state,
//   });

//   // Eventos de actualización de conexión
//   sock.ev.on("connection.update", handleConnectionUpdate);
//   sock.ev.on("messages.upsert", handleMessageUpsert);
//   sock.ev.on("creds.update", saveCreds);
// }

// // Manejar actualizaciones de conexión
// async function handleConnectionUpdate(update) {
//   const { connection, lastDisconnect, qr } = update || {};

//   if (qr && !qrEmitted) {
//     qrEmitted = true;
//     console.log("Generando código QR para conexión...");
//     const qrCodeURL = await QRCode.toDataURL(qr);
//     io.emit("qr", qrCodeURL);
//   }

//   if (connection === "close") {
//     const shouldReconnect =
//       lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

//     if (
//       lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut
//     ) {
//       isLoggedOut = true;
//       console.log("Sesión cerrada intencionalmente.");
//       io.emit("logout");
//     } else if (!isLoggedOut && shouldReconnect) {
//       console.log("Intentando reconectar...");
//       connectionLogic();
//     } else {
//       console.log("Sesión cerrada, escanea nuevamente el QR.");
//       io.emit("logout");
//     }
//   } else if (connection === "open") {
//     console.log("¡Conexión establecida!");
//     io.emit("connected");
//   }
// }

// // Manejar mensajes entrantes y agruparlos por número de teléfono
// function handleMessageUpsert(messageUpdate) {
//   const messages = messageUpdate.messages || [];
//   messages.forEach((msg) => {
//     try {
//       const {
//         key,
//         message,
//         key: { fromMe },
//         messageTimestamp,
//       } = msg;

//       const phoneNumber = key.remoteJid || "Número desconocido";

//       // Incrementar contadores según sea enviado o recibido
//       if (fromMe) {
//         contador.enviados += 1;
//       } else {
//         contador.recibidos += 1;
//       }

//       io.emit("updateCounters", contador);

//       // Manejar contenido del mensaje de forma segura
//       const messageContent =
//         message?.conversation ||
//         message?.extendedTextMessage?.text ||
//         message?.imageMessage?.caption ||
//         message?.videoMessage?.caption ||
//         "[Mensaje sin texto]";

//       const messageData = {
//         fromMe,
//         phoneNumber,
//         message: messageContent,
//         timestamp: messageTimestamp || Date.now() / 1000,
//         date: new Date(
//           (messageTimestamp || Date.now() / 1000) * 1000
//         ).toLocaleDateString(),
//         time: new Date(
//           (messageTimestamp || Date.now() / 1000) * 1000
//         ).toLocaleTimeString(),
//       };

//       // Agrupar mensajes por número de teléfono
//       if (!messagesGroupedByPhone[phoneNumber]) {
//         messagesGroupedByPhone[phoneNumber] = [];
//       }
//       messagesGroupedByPhone[phoneNumber].push(messageData);

//       // Guardar el registro agrupado
//       fs.writeFileSync(
//         "messages_grouped_log.json",
//         JSON.stringify(messagesGroupedByPhone, null, 2)
//       );
//     } catch (error) {
//       console.error("Error procesando un mensaje:", error);
//     }
//   });
// }

// // Funciones para cerrar sesión y reconectar
// function closeConnection() {
//   if (sock) {
//     sock.logout();
//     console.log("Sesión cerrada manualmente.");
//     isLoggedOut = true;
//     io.emit("logout");
//     qrEmitted = false;

//     const authPath = path.join(__dirname, "auth_info_baileys");
//     fs.rm(authPath, { recursive: true, force: true }, (err) => {
//       if (err) console.error("Error al eliminar la sesión:", err);
//       else console.log("Sesión eliminada correctamente.");
//     });
//   }
// }

// function reconnect() {
//   if (isLoggedOut) {
//     isLoggedOut = false;
//     qrEmitted = false;
//     connectionLogic();
//   } else {
//     console.log("No se puede reconectar sin cerrar sesión primero.");
//   }
// }

// // Configuración de WebSocket
// io.on("connection", (socket) => {
//   socket.on("closeConnection", closeConnection);
//   socket.on("reconnect", reconnect);
// });

// // Iniciar conexión y servidor
// connectionLogic();
// server.listen(PORT, () => {
//   console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
// });
