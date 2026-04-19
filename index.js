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

const sesiones = {};

function numeroAutorizado(numero) {
  if (!numero) return false;
  return NUMEROS_AUTORIZADOS.some(n => 
    numero.includes(n) || n.includes(numero)
  );
}

async function descargarImagen(url) {
  const response = await axios.get(url, {
    headers: { 'api_access_token': CHATWOOT_TOKEN },
    responseType: 'arraybuffer'
  });
  return Buffer.from(response.data);
}

async function subirImagen(buffer, filename) {
  const bucket = storage.bucket(BUCKET_NAME);
  const file = bucket.file(`pedidos/${filename}`);
  await file.save(buffer, { contentType: 'image/jpeg' });
  const [url] = await file.getSignedUrl({
    action: 'read',
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000
  });
  return url;
}

async function procesarConGemini(imageBuffer, textoAdicional) {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const imagePart = {
    inlineData: {
      data: imageBuffer.toString('base64'),
      mimeType: 'image/jpeg'
    }
  };

  const prompt = `
    Eres un asistente que extrae datos de pedidos de clientes para una tienda de ropa.
    Analiza la imagen del chat y el texto adicional del operador.
    Combina ambas fuentes para obtener la información más completa posible.
    El texto adicional del pedido tiene esta estructura .
    1. la talla del producto (6,8,28,30,32, etc.)
    2. el código de producto (cla, hop, ov cargo, entre otros codigo)
    3. código de color (ne, ao, ac, rojo, entre otros).
    4.En ocasiones se repite la talla el codigo del prodcuto y el color por que pueden ser dos o más prendas.
    5. Valor del pedido (130, 100, y superiores),
    6. Observaciones del pedido, características de la ubicación del destinatario que no están en la imagen (ciudad, que se dirige a oficina interrapidísimo entre otros) o incluso correcciones que deben tenerse en cuenta, que modifican los datos que se encuentran en la imagen
    
    Texto adicional del operador: "${textoAdicional}"
    
    Extrae los siguientes datos y devuelve SOLO un JSON válido sin texto adicional ni backticks:
    {
      "nombre": "nombre completo del cliente",
      "telefono": "número de teléfono del cliente, es un número de 10 dígitos que comienza por 3 y en ocasiones es precedido por un +57",
      "direccion": "dirección completa de entrega por lo general esta en la imagen, sin embargo si en el texto adicional aparece oficina, debe colocarse oficina principal interrapidisimo sin importar que en la imagen este una direccion escrita, o en ocasiones aparecera en el texto adicional la oficina de interrapidisimo y su direccion en ese caso se óndra esos datos. Ten presente que la información que está en el texto adicional va como prioridad sobre la de la imagen ",
      "ciudad": "ciudad o municipio de Colombia donde se realiza la entrega",
      "producto": "descripción del producto o contenido del pedido, irá primero la talla y después la descripción del producto""Si llega a haber otro Se colocarán separado por una ,",
      "valorRecaudo": "valor a recaudar en números sin símbolos. Los valores están siempre después de la referencia del producto. Todos los valores se dan en miles. Es decir que si llegas a ver por ejemplo 130, colocarás 130000. Si el texto menciona ya pago, pagado, pago, ya canceló o similar, coloca 0.",
      "tipo": "tipo de pedido según el texto: VENTA si es pedido normal o tiene valor a cobrar o menciona ya pagó o pagado, CAMBIO si menciona cambio o cambiar, ERROR si menciona error o botones o falla, CAMBIO Y RECOGER si menciona recoger prenda o cambio y recoger. Por defecto VENTA si no hay ninguna indicación."
    }
    
    Si un dato no está disponible en ninguna fuente o no es claro o hay posibilidad de confusión, usa null.
    Devuelve SOLO el JSON, sin explicaciones ni texto adicional.
  `;

  const result = await model.generateContent([prompt, imagePart]);
  const text = result.response.text().trim();
  const clean = text.replace(/```json|```/g, '').trim();
  const jsonMatch = clean.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Gemini no devolvió un JSON válido');

  const datos = JSON.parse(jsonMatch[0]);
  if (datos.valorRecaudo === null && textoAdicional.match(/ya pag|pagado|pago|cancel/i)) {
    datos.valorRecaudo = 0;
  }
  return datos;
}

async function escribirEnSheets(datos, imagenUrl, fechaPedido, textoImagen, textoAdicional) {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const headersResponse = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Pedidos!1:1'
  });
  const headers = headersResponse.data.values[0];
  console.log('Encabezados encontrados:', JSON.stringify(headers));

  const nombreCol = headers.indexOf('Nombre');
  if (nombreCol === -1) throw new Error('No se encontró la columna Nombre');

  const colLetra = String.fromCharCode(65 + nombreCol);
  const nombresResponse = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `Pedidos!${colLetra}:${colLetra}`
  });
  const ultimaFila = (nombresResponse.data.values || []).length + 1;
  console.log('Escribiendo en fila:', ultimaFila);

  console.log('textoImagen:', JSON.stringify(textoImagen));
  console.log('textoAdicional:', JSON.stringify(textoAdicional));

  const columnMap = {
    'Nombre': datos.nombre || '',
    'Teléfono': datos.telefono || '',
    'Dirección': datos.direccion || '',
    'Ciudad/Municipio': datos.ciudad || '',
    'Contenido/Producto': datos.producto || '',
    'Valor Recaudo ($)': datos.valorRecaudo !== null && datos.valorRecaudo !== undefined ? datos.valorRecaudo : '',
    'Imagen': imagenUrl || '',
    'Tipo': datos.tipo || 'VENTA',
    'Fecha Pedido': fechaPedido || '',
    'Texto Imagen': textoImagen || textoAdicional || ''
  };

  const fila = headers.map(header => columnMap[header] !== undefined ? columnMap[header] : null);
  console.log('Fila a escribir:', JSON.stringify(fila));

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Pedidos!A${ultimaFila}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [fila] }
  });
  console.log('Fila escrita exitosamente en fila:', ultimaFila);
}

// ─────────────────────────────────────────────────────────────────────────────
// procesarSesion recibe el objeto de sesión directamente (no lo busca en
// sesiones[]). Así no tiene ninguna dependencia sobre sesiones[] y no puede
// borrar accidentalmente una sesión nueva que se haya creado mientras esta
// función estaba corriendo de forma asíncrona.
// ─────────────────────────────────────────────────────────────────────────────
async function procesarSesion(sesion, conversationId) {
  if (!sesion) return;

  try {
    console.log(`Procesando sesión de conversación ${conversationId}`);
    if (!sesion.imagen) {
      console.log('Sesión sin imagen, descartando');
      return;
    }

    const imageBuffer = await descargarImagen(sesion.imagen);
    const filename = `pedido_${conversationId}_${Date.now()}.jpg`;
    const imagenUrl = await subirImagen(imageBuffer, filename);
    const textoAdicional = sesion.textos.join(' ');
    const datos = await procesarConGemini(imageBuffer, textoAdicional);
    await escribirEnSheets(datos, imagenUrl, sesion.fechaPedido, sesion.textoImagen, textoAdicional);
    console.log('Pedido procesado exitosamente:', datos);

  } catch (error) {
    console.error(`Error procesando sesión ${conversationId}:`, error.message);
  }
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.event !== 'message_created') return;
    if (body.message_type !== 0 && body.message_type !== 'incoming') return;

    const numero = body.meta?.sender?.phone_number || 
                   body.conversation?.meta?.sender?.phone_number ||
                   body.sender?.phone_number || '';
    if (!numeroAutorizado(numero)) return;

    const conversationId = body.conversation?.id;
    if (!conversationId) return;

    const contenido = body.content || '';
    const adjuntos = body.attachments || [];
    const imagen = adjuntos.find(a => a.file_type === 'image');

    console.log(`Mensaje recibido - Conv: ${conversationId} - Contenido: "${contenido}" - Imagen: ${!!imagen}`);

    // TRIGGER 1: Imagen detectada — cerrar sesión anterior y abrir nueva
    if (imagen) {
      if (sesiones[conversationId]) {
        if (sesiones[conversationId].timer) {
          clearTimeout(sesiones[conversationId].timer);
          console.log(`Timer anterior cancelado para conversación ${conversationId}`);
        }

        if (sesiones[conversationId].imagen) {
          // FIX RACE CONDITION:
          // Se copia la sesión anterior a una variable local y se elimina de
          // sesiones[] ANTES de llamar procesarSesion. De esta forma, cuando
          // procesarSesion termine (de forma asíncrona, sin await), ya no
          // tiene nada que borrar en sesiones[] y no puede afectar la sesión
          // nueva que se crea justo después.
          console.log(`Procesando sesión anterior antes de abrir nueva`);
          const sesionAnterior = sesiones[conversationId];
          delete sesiones[conversationId];
          procesarSesion(sesionAnterior, conversationId); // sin await — intencional
        } else {
          delete sesiones[conversationId];
        }
      }

      console.log(`Abriendo sesión para conversación ${conversationId}`);

      let fechaRaw = body.created_at;
      let fechaObj;
      if (!fechaRaw) {
        fechaObj = new Date();
      } else if (typeof fechaRaw === 'number') {
        fechaObj = new Date(fechaRaw * 1000);
      } else if (typeof fechaRaw === 'string') {
        fechaObj = new Date(fechaRaw.replace(' UTC', 'Z'));
      } else {
        fechaObj = new Date();
      }
      const fechaPedido = isNaN(fechaObj.getTime())
        ? new Date().toLocaleString('es-CO', {timeZone: 'America/Bogota'})
        : fechaObj.toLocaleString('es-CO', {timeZone: 'America/Bogota'});

      const sessionId = Date.now();

      sesiones[conversationId] = {
        sessionId: sessionId,
        textos: [],
        imagen: imagen.data_url,
        textoImagen: contenido || body.attachments?.[0]?.caption || null,
        timestamp: Date.now(),
        fechaPedido: fechaPedido,
        timer: setTimeout(() => {
          // FIX RACE CONDITION:
          // El timer también extrae y borra la sesión antes de procesarla,
          // por la misma razón: evitar que procesarSesion tenga referencia
          // a sesiones[] y pueda borrar algo que no le corresponde.
          const sesionActual = sesiones[conversationId];
          if (sesionActual && sesionActual.sessionId === sessionId) {
            console.log(`Timer alcanzado, procesando automáticamente conversación ${conversationId}`);
            delete sesiones[conversationId];
            procesarSesion(sesionActual, conversationId);
          }
        }, 19000)
      };

      // Limpiar sesiones viejas de más de 10 minutos
      Object.keys(sesiones).forEach(id => {
        if (Date.now() - sesiones[id].timestamp > 600000) {
          console.log(`Limpiando sesión expirada: ${id}`);
          delete sesiones[id];
        }
      });

      return;
    }

    // Si no hay sesión abierta para esta conversación, ignorar
    if (!sesiones[conversationId]) return;

    // Acumular texto si no termina en ..
    if (contenido && contenido.trim().length > 0 && !contenido.trim().replace(/\s+/g, '').endsWith('..')) {
      sesiones[conversationId].textos.push(contenido.trim());
      console.log(`Texto acumulado para conversación ${conversationId}: "${contenido}"`);

      // Reiniciar timer con sessionId actual
      const currentSessionId = sesiones[conversationId].sessionId;
      if (sesiones[conversationId].timer) clearTimeout(sesiones[conversationId].timer);
      sesiones[conversationId].timer = setTimeout(() => {
        // FIX RACE CONDITION: mismo patrón — extraer y borrar antes de procesar
        const sesionActual = sesiones[conversationId];
        if (sesionActual && sesionActual.sessionId === currentSessionId) {
          console.log(`Timer alcanzado tras texto, procesando automáticamente conversación ${conversationId}`);
          delete sesiones[conversationId];
          procesarSesion(sesionActual, conversationId);
        }
      }, 19000);
    }

    // TRIGGER 2: Detectar punto final — procesar todo
    if (contenido.trim().replace(/\s+/g, '').endsWith('..')) {
      if (sesiones[conversationId]?.timer) {
        clearTimeout(sesiones[conversationId].timer);
      }
      // FIX RACE CONDITION: mismo patrón — extraer y borrar antes de procesar
      const sesionFinal = sesiones[conversationId];
      delete sesiones[conversationId];
      console.log(`Punto final detectado, procesando conversación ${conversationId}`);
      await procesarSesion(sesionFinal, conversationId); // await aquí sí tiene sentido (trigger manual)
    }

  } catch (error) {
    console.error('Error en webhook:', error.message);
  }
});

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    servicio: 'webhook-pedidos',
    sesionesActivas: Object.keys(sesiones).length
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
