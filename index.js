const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const { Storage } = require('@google-cloud/storage');

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CHATWOOT_URL = process.env.CHATWOOT_URL;
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const BUCKET_NAME = process.env.BUCKET_NAME;

const NUMEROS_AUTORIZADOS = [
  '3222646442',
  '573222646442',
  '+573222646442'
];

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const storage = new Storage();

// Verificar si el número está autorizado
function numeroAutorizado(numero) {
  return NUMEROS_AUTORIZADOS.some(n => numero.includes(n) || n.includes(numero));
}

// Extraer texto entre #p y el último punto
function extraerTexto(mensaje) {
  const inicio = mensaje.indexOf('#p');
  const fin = mensaje.lastIndexOf('.');
  if (inicio === -1 || fin === -1 || fin < inicio) return '';
  return mensaje.substring(inicio + 2, fin).trim();
}

// Descargar imagen de Chatwoot
async function descargarImagen(url) {
  const response = await axios.get(url, {
    headers: { 'api_access_token': CHATWOOT_TOKEN },
    responseType: 'arraybuffer'
  });
  return Buffer.from(response.data);
}

// Subir imagen a Cloud Storage
async function subirImagen(buffer, filename) {
  const bucket = storage.bucket(BUCKET_NAME);
  const file = bucket.file(`pedidos/${filename}`);
  await file.save(buffer, { contentType: 'image/jpeg', public: true });
  return `https://storage.googleapis.com/${BUCKET_NAME}/pedidos/${filename}`;
}

// Procesar imagen y texto con Gemini
async function procesarConGemini(imageBuffer, textoAdicional) {
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const imagePart = {
    inlineData: {
      data: imageBuffer.toString('base64'),
      mimeType: 'image/jpeg'
    }
  };

  const prompt = `
    Eres un asistente que extrae datos de pedidos de clientes.
    Analiza la imagen y el texto adicional proporcionado.
    Combina ambas fuentes para obtener la información más completa posible.
    
    Texto adicional del operador: "${textoAdicional}"
    
    Extrae los siguientes datos y devuelve SOLO un JSON válido sin texto adicional:
    {
      "nombre": "nombre completo del cliente",
      "telefono": "número de teléfono",
      "direccion": "dirección completa",
      "ciudad": "ciudad o municipio",
      "producto": "descripción del producto o contenido",
      "valorRecaudo": "valor a recaudar en números"
    }
    
    Si un dato no está disponible en ninguna fuente, usa null.
    No incluyas explicaciones, solo el JSON.
  `;

  const result = await model.generateContent([prompt, imagePart]);
  const text = result.response.text();

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Gemini no devolvió un JSON válido');

  return JSON.parse(jsonMatch[0]);
}

// Escribir en Google Sheets
async function escribirEnSheets(datos, imagenUrl) {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const sheets = google.sheets({ version: 'v4', auth });

  // Obtener encabezados para buscar columnas por nombre
  const headersResponse = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Pedidos!1:1'
  });

  const headers = headersResponse.data.values[0];

  // Mapeo de columnas
  const columnMap = {
    'Nombre': datos.nombre,
    'Teléfono': datos.telefono,
    'Dirección': datos.direccion,
    'Ciudad/Municipio': datos.ciudad,
    'Contenido/Producto': datos.producto,
    'Valor Recaudo ($)': datos.valorRecaudo,
    'Imagen': imagenUrl
  };

  // Construir la fila según el orden de los encabezados
  const fila = headers.map(header => columnMap[header] || '');

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Pedidos!A:A',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [fila] }
  });
}

// Webhook principal
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // Verificar que sea un mensaje entrante
    if (body.event !== 'message_created') return res.sendStatus(200);
    if (body.message_type !== 'incoming') return res.sendStatus(200);

    const mensaje = body.content || '';
    const numero = body.meta?.sender?.phone_number || '';

    // Filtros de seguridad
    if (!numeroAutorizado(numero)) return res.sendStatus(200);
    if (!mensaje.includes('#p')) return res.sendStatus(200);
    if (!mensaje.includes('.')) return res.sendStatus(200);

    // Verificar que tenga imagen adjunta
    const adjuntos = body.attachments || [];
    const imagen = adjuntos.find(a => a.file_type === 'image');
    if (!imagen) return res.sendStatus(200);

    // Extraer texto adicional
    const textoAdicional = extraerTexto(mensaje);

    // Descargar imagen
    const imageBuffer = await descargarImagen(imagen.data_url);

    // Subir imagen a Cloud Storage
    const filename = `pedido_${Date.now()}.jpg`;
    const imagenUrl = await subirImagen(imageBuffer, filename);

    // Procesar con Gemini
    const datos = await procesarConGemini(imageBuffer, textoAdicional);

    // Escribir en Sheets
    await escribirEnSheets(datos, imagenUrl);

    console.log('Pedido procesado exitosamente:', datos);
    res.sendStatus(200);

  } catch (error) {
    console.error('Error procesando pedido:', error);
    res.sendStatus(500);
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', servicio: 'webhook-pedidos' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
