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
const CONVERSATION_ID_PRODUCCION = 5315;
const ARCHIVO_PROCESADOS = 'procesados/mensajes_procesados.json';
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const storage = new Storage();
let escribiendoEnSheets = false;
const colaEscritura = [];
let idsProcesados = new Set();
let ultimoBarrido = null;
let procesadosCargados = false;

// Márgenes de espera (en segundos), basados en tiempo real del mensaje, no en timers
const MARGEN_IMAGEN_ESPERA_TEXTO = 45; // una imagen sin texto espera esto antes de registrarse sola
const MARGEN_TEXTO_ESPERA_IMAGEN = 10; // un texto sin imagen anterior espera esto antes de descartarse

// Candado de concurrencia: evita que dos barridos corran en paralelo
let barridoEnCurso = false;
let barridoPendiente = false;

function obtenerInicioHoy() {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  return Math.floor(hoy.getTime() / 1000);
}

async function cargarIdsProcesados() {
  try {
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(ARCHIVO_PROCESADOS);
    const [exists] = await file.exists();
    if (!exists) {
      console.log('Archivo de procesados no existe, iniciando vacío');
      idsProcesados = new Set();
      procesadosCargados = true;
      return;
    }
    const [contenido] = await file.download();
    const datos = JSON.parse(contenido.toString());
    idsProcesados = new Set(datos.ids || []);
    ultimoBarrido = datos.ultimoBarrido || obtenerInicioHoy();
    console.log(`IDs procesados cargados: ${idsProcesados.size}, último barrido: ${new Date(ultimoBarrido * 1000).toLocaleString('es-CO', {timeZone: 'America/Bogota'})}`);
    procesadosCargados = true;
  } catch (error) {
    console.error('Error cargando IDs procesados:', error.message);
    idsProcesados = new Set();
    procesadosCargados = true;
  }
}

async function guardarIdsProcesados() {
  try {
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(ARCHIVO_PROCESADOS);
    await file.save(JSON.stringify({ ids: [...idsProcesados], ultimoBarrido }), {
      contentType: 'application/json'
    });
  } catch (error) {
    console.error('Error guardando IDs procesados:', error.message);
  }
}

async function obtenerMensajes(conversationId) {
  try {
    const response = await axios.get(
      `${CHATWOOT_URL}/api/v1/accounts/27/conversations/${conversationId}/messages`,
      { headers: { 'api_access_token': CHATWOOT_TOKEN } }
    );
    return response.data.payload || [];
  } catch (error) {
    console.error('Error obteniendo mensajes:', error.message);
    return [];
  }
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
Eres un asistente especializado en extraer datos de pedidos de una tienda de ropa colombiana llamada Ocaso Jeans.
Recibirás dos fuentes de información:
1. Una imagen de un chat de WhatsApp con los datos del cliente (nombre, teléfono, dirección, ciudad)
2. Un texto adicional escrito por el operador con información del pedido
ESTRUCTURA DEL TEXTO DEL OPERADOR:
El texto sigue este orden separado por comas:
PRODUCTO(S) , VALOR RECAUDO , OBSERVACIÓN DE PAGO , OBSERVACIÓN DE DIRECCIÓN
REGLAS PARA PRODUCTOS:
- Un producto: "34 cla am" (talla + referencia + color)
- Varios productos diferentes: "34 cla am + 36 hop ne"
- Varios productos iguales: "34 cla am x2"
- El color puede ser: ne (negro), ao (azul oscuro), ac (azul claro), am (amarillo), rojo, entre otros
- Las referencias pueden o no, estar acompañadas de diseños del producto como rot (desgastes o rotos) : "34 cla rot am"
- Las referencias pueden ser: cla, hop, ov cargo, entre otras
REGLAS PARA VALORES:
- Todos los valores están en miles. Si ves 130, significa 130.000
- Si aparece un solo valor → ese es tanto el Valor Recaudo como el Valor Total del Pedido
- Si el operador indica que ya pagó ("ya pago", "ya cancelo", "pagado" o similar) → Valor Recaudo es 0, y el valor mencionado es el Valor Total del Pedido
- Si hay abono → el texto tendrá tres valores: el recaudo (lo que cobra el mensajero), el abono (pago parcial previo) y el valor total. Ejemplo: "80, abono 50 bancolombia de 130" significa: recaudo 80.000, abono 50.000, valor total 130.000
REGLAS PARA FORMA DE PAGO:
- Si no se menciona ninguna forma de pago → "Contra entrega"
- Si menciona Bancolombia, Nequi, Daviplata, Addi, Siste Crédito u otro medio → transcribir exactamente como aparece escrito aunque tenga errores ortográficos
- Si hay abono + pago contra entrega → "Mixto"
- Si ya pagó completamente → el medio mencionado (ej: "Bancolombia")
REGLAS PARA TIPO DE PEDIDO:
- VENTA → pedido normal, sin indicación especial
- CAMBIO → el operador escribe "cambio" sin indicación adicional. Nosotros asumimos el costo del envío
- CAMBIO ENVIO CLIENTE → el operador escribe "cambio envio cliente". El cliente asume el costo del envío
- CAMBIO RECOGER PRENDA → el operador escribe "cambio recoger prenda". Es un cambio en Bogotá donde el domiciliario entrega y recoge prenda(s)
- ERROR → el operador escribe "error". Es un error de bodega, el valor recaudo siempre es 0
- REENVIO → el operador escribe "reenvio". 
REGLAS PARA DIRECCIÓN:
- La dirección principal viene en la imagen
- Si el operador menciona "oficina interrapidisimo" o similar → reemplazar la dirección por "ENTREGA EN OFICINA INTERRAPIDISIMO" no remplazaras nunca la ciudad
- Si el operador menciona una dirección específica de oficina → usar esa dirección depsues de "ENTREGA EN OFICINA INTERRAPIDISIMO" sin reemplazar la ciudad de la imagen 
- La información del texto del operador tiene prioridad sobre la imagen, a excepcion de la ciudad descrita en la imagen 
REGLAS PARA ERRORES DE ESCRITURA:
- El operador puede escribir rápido y cometer errores ortográficos
- Interpreta cada palabra según el contexto. Ejemplos: "bancolomia" → Bancolombia, "camboi" → cambio, "ofician" → oficina
- Si corriges algo, regístralo en el campo porValidar
REGLAS PARA EL CAMPO POR VALIDAR:
- Si todo está claro y completo → null
- Si la IA corrigió una palabra mal escrita o hay una duda menor → describir brevemente
- Si falta un dato crítico → indicarlo claramente. Ejemplo: "Falta dirección", "No se identificó ciudad", "Valor no especificado"
- Los datos críticos son: nombre, teléfono, dirección, ciudad, valor
- Si hay múltiples alertas → separarlas con " | "
Texto adicional del operador: "${textoAdicional}"
Extrae los siguientes datos y devuelve SOLO un JSON válido sin texto adicional ni backticks:
{
  "nombre": "nombre completo del cliente extraído de la imagen",
  "telefono": "número de 10 dígitos que comienza por 3, sin prefijo +57, si no se encuentra en la imagen buscar el +57 y colocar el numero de 10 digitos despues de +57",
  "direccion": "dirección completa de entrega",
  "ciudad": "ciudad o municipio de Colombia",
  "producto": "descripción completa del producto o productos. Primero la talla, luego la referencia y el color. Si son varios, separados por coma",
  "valorRecaudo": "valor en números sin símbolos ni puntos. Ejemplo: 130000",
  "valorTotalPedido": "valor real del producto en números sin símbolos ni puntos. Ejemplo: 130000",
  "formaPago": "Contra entrega, Bancolombia, Nequi, Daviplata, Addi, Siste Crédito, Mixto, u otro medio mencionado",
  "abono": "valor del abono en números si aplica, de lo contrario null. Ejemplo: 50000",
  "medioPagoAbono": "medio por el que se realizó el abono si aplica, de lo contrario null",
  "tipo": "VENTA, CAMBIO, CAMBIO ENVIO CLIENTE, CAMBIO RECOGER PRENDA o ERROR",
  "porValidar": "descripción de correcciones o datos faltantes, o null si todo está completo"
}
Si un dato no está disponible o no es posible determinarlo con certeza, usa null.
Devuelve SOLO el JSON, sin explicaciones ni texto adicional.
  `;
  const result = await model.generateContent([prompt, imagePart]);
  const text = result.response.text().trim();
  const clean = text.replace(/```json|```/g, '').trim();
  const jsonMatch = clean.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Gemini no devolvió un JSON válido');
  return JSON.parse(jsonMatch[0]);
}

async function escribirEnSheets(datos, imagenUrl, fechaPedido, textoImagen, textoAdicional) {
  return new Promise((resolve, reject) => {
    colaEscritura.push({ datos, imagenUrl, fechaPedido, textoImagen, textoAdicional, resolve, reject });
    procesarColaEscritura();
  });
}

async function procesarColaEscritura() {
  if (escribiendoEnSheets || colaEscritura.length === 0) return;
  escribiendoEnSheets = true;
  const { datos, imagenUrl, fechaPedido, textoImagen, textoAdicional, resolve, reject } = colaEscritura.shift();
  try {
    await _escribirEnSheets(datos, imagenUrl, fechaPedido, textoImagen, textoAdicional);
    resolve();
  } catch (e) {
    reject(e);
  } finally {
    escribiendoEnSheets = false;
    procesarColaEscritura();
  }
}

async function _escribirEnSheets(datos, imagenUrl, fechaPedido, textoImagen, textoAdicional) {
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
  const telefonoCol = headers.indexOf('Teléfono');
  if (telefonoCol === -1) throw new Error('No se encontró la columna Teléfono');
  const colLetra = String.fromCharCode(65 + telefonoCol);
  const telefonosResponse = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `Pedidos!${colLetra}:${colLetra}`
  });
  const ultimaFila = (telefonosResponse.data.values || []).length + 1;
  console.log('Escribiendo en fila:', ultimaFila);
  console.log('textoImagen:', JSON.stringify(textoImagen));
  console.log('textoAdicional:', JSON.stringify(textoAdicional));
  let textoAbono = '';
  if (datos.abono) {
    textoAbono = datos.medioPagoAbono
      ? `${Number(datos.abono).toLocaleString('es-CO')} - ${datos.medioPagoAbono}`
      : `${Number(datos.abono).toLocaleString('es-CO')}`;
  }
  const columnMap = {
    'Nombre': datos.nombre || '',
    'Teléfono': datos.telefono || '',
    'Dirección': datos.direccion || '',
    'Ciudad/Municipio': datos.ciudad || '',
    'Contenido/Producto': datos.producto || '',
    'Valor Recaudo ($)': datos.valorRecaudo !== null && datos.valorRecaudo !== undefined ? datos.valorRecaudo : '',
    'Valor Total de Pedido': datos.valorTotalPedido !== null && datos.valorTotalPedido !== undefined ? datos.valorTotalPedido : '',
    'Forma de pago': datos.formaPago || 'Contra entrega',
    'Abono': textoAbono || '',
    'Por validar (IA)': datos.porValidar || '',
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

function esTextoValido(texto) {
  if (!texto || texto.trim().length === 0) return false;
  const soloCaracteresRepetidos = /^[\-\.\=\_\*\#\s]+$/.test(texto.trim());
  return !soloCaracteresRepetidos;
}

function tieneImagen(mensaje) {
  return mensaje.attachments && mensaje.attachments.some(a => a.file_type === 'image');
}

function obtenerImagen(mensaje) {
  return mensaje.attachments.find(a => a.file_type === 'image');
}

async function procesarPar(par, conversationId) {
  try {
    console.log(`Procesando par - MessageId: ${par.messageId} - Texto: "${par.texto}"`);
    idsProcesados.add(par.messageId);
    if (par.imagenMessageId) idsProcesados.add(par.imagenMessageId);
    guardarIdsProcesados();
    const imageBuffer = await descargarImagen(par.imagenUrl);
    const filename = `pedido_${conversationId}_${Date.now()}.jpg`;
    const imagenUrlSubida = await subirImagen(imageBuffer, filename);
    const datos = await procesarConGemini(imageBuffer, par.texto);
    if (!par.texto || par.texto.trim().length === 0) {
      const aviso = 'Falta texto del pedido (producto, valor, pago) - registrado solo con imagen';
      datos.porValidar = datos.porValidar ? `${aviso} | ${datos.porValidar}` : aviso;
    }
    await escribirEnSheets(datos, imagenUrlSubida, par.fechaPedido, null, par.texto);
    console.log('Pedido procesado exitosamente:', datos);
  } catch (error) {
    console.error(`Error procesando par ${par.messageId}:`, error.message);
  }
}

// Recorre la ventana de mensajes en orden real y decide qué hacer con cada uno.
// Devuelve el timestamp hasta donde es seguro avanzar ultimoBarrido.
async function procesarVentana(conversationId, desde, ahora) {
  const mensajes = await obtenerMensajes(conversationId);
  const entrantes = mensajes
    .filter(m => m.message_type === 0 && m.created_at >= desde)
    .sort((a, b) => a.created_at - b.created_at);

  let puntoDeCorte = desde;
  let i = 0;

  while (i < entrantes.length) {
    const actual = entrantes[i];

    if (idsProcesados.has(actual.id)) {
      puntoDeCorte = actual.created_at;
      i++;
      continue;
    }

    if (tieneImagen(actual)) {
      const siguiente = entrantes[i + 1];
      const siguienteEsTextoValido = siguiente && esTextoValido(siguiente.content) && !tieneImagen(siguiente) && !idsProcesados.has(siguiente.id);

      if (siguienteEsTextoValido) {
        // Par completo: imagen + texto
        await procesarPar({
          imagenUrl: obtenerImagen(actual).data_url,
          texto: siguiente.content.trim(),
          messageId: siguiente.id,
          imagenMessageId: actual.id,
          fechaPedido: new Date(actual.created_at * 1000).toLocaleString('es-CO', { timeZone: 'America/Bogota' })
        }, conversationId);
        puntoDeCorte = siguiente.created_at;
        i += 2;
        continue;
      }

      // No hay texto válido justo después todavía (o el siguiente es otra imagen/basura)
      const segundosEsperando = ahora - actual.created_at;
      if (segundosEsperando >= MARGEN_IMAGEN_ESPERA_TEXTO) {
        // Se acabó el tiempo de espera: registrar la imagen sola
        await procesarPar({
          imagenUrl: obtenerImagen(actual).data_url,
          texto: '',
          messageId: actual.id,
          imagenMessageId: actual.id,
          fechaPedido: new Date(actual.created_at * 1000).toLocaleString('es-CO', { timeZone: 'America/Bogota' })
        }, conversationId);
        puntoDeCorte = actual.created_at;
        i++;
        continue;
      }

      // Todavía dentro del margen de espera: detener el recorrido aquí, sin avanzar más
      console.log(`Imagen ${actual.id} esperando texto (${segundosEsperando}s de ${MARGEN_IMAGEN_ESPERA_TEXTO}s)`);
      break;
    }

    // Es un texto que llegó sin que una imagen anterior lo haya consumido como par
    if (esTextoValido(actual.content)) {
      const anterior = entrantes[i - 1];
      const anteriorEsImagenSinUsar = anterior && tieneImagen(anterior) && !idsProcesados.has(anterior.id);

      if (anteriorEsImagenSinUsar) {
        // La imagen anterior no fue consumida en el paso previo (caso raro) → emparejar ahora
        await procesarPar({
          imagenUrl: obtenerImagen(anterior).data_url,
          texto: actual.content.trim(),
          messageId: actual.id,
          imagenMessageId: anterior.id,
          fechaPedido: new Date(anterior.created_at * 1000).toLocaleString('es-CO', { timeZone: 'America/Bogota' })
        }, conversationId);
        puntoDeCorte = actual.created_at;
        i++;
        continue;
      }

      const segundosEsperando = ahora - actual.created_at;
      if (segundosEsperando >= MARGEN_TEXTO_ESPERA_IMAGEN) {
        // Se acabó el tiempo de espera: no hay imagen para este texto, se descarta
        console.log(`Texto ${actual.id} sin imagen anterior tras ${segundosEsperando}s, descartando: "${actual.content}"`);
        idsProcesados.add(actual.id);
        guardarIdsProcesados();
        puntoDeCorte = actual.created_at;
        i++;
        continue;
      }

      // Todavía dentro del margen: detener el recorrido aquí
      console.log(`Texto ${actual.id} esperando imagen anterior (${segundosEsperando}s de ${MARGEN_TEXTO_ESPERA_IMAGEN}s)`);
      break;
    }

    // Mensaje no válido (ej: "-----", "...") y sin imagen → se ignora y se avanza
    puntoDeCorte = actual.created_at;
    i++;
  }

  return puntoDeCorte;
}

async function ejecutarBarrido(conversationId) {
  if (barridoEnCurso) {
    barridoPendiente = true;
    return;
  }
  barridoEnCurso = true;
  try {
    const ahora = Math.floor(Date.now() / 1000);
    const desde = ultimoBarrido || obtenerInicioHoy();
    console.log(`Barrido desde ${new Date(desde * 1000).toLocaleString('es-CO', {timeZone: 'America/Bogota'})}`);
    const nuevoPuntoDeCorte = await procesarVentana(conversationId, desde, ahora);
    if (nuevoPuntoDeCorte > (ultimoBarrido || 0)) {
      ultimoBarrido = nuevoPuntoDeCorte;
      guardarIdsProcesados();
    }
  } catch (error) {
    console.error('Error en barrido:', error.message);
  } finally {
    barridoEnCurso = false;
    if (barridoPendiente) {
      barridoPendiente = false;
      ejecutarBarrido(conversationId); // sin await: se reprograma para captar lo que llegó mientras tanto
    }
  }
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    if (!procesadosCargados) await cargarIdsProcesados();
    const body = req.body;
    if (body.event !== 'message_created') return;
    if (body.message_type !== 0 && body.message_type !== 'incoming') return;
    const conversationId = body.conversation?.id;
    if (conversationId !== CONVERSATION_ID_PRODUCCION) return;
    const contenido = body.content || '';
    const adjuntos = body.attachments || [];
    const imagen = adjuntos.find(a => a.file_type === 'image');
    console.log(`Mensaje recibido - Conv: ${conversationId} - Contenido: "${contenido}" - Imagen: ${!!imagen}`);

    // El webhook solo dispara el barrido. La API de Chatwoot es la única fuente de verdad.
    ejecutarBarrido(conversationId); // sin await: responde rápido al webhook, procesa en segundo plano
  } catch (error) {
    console.error('Error en webhook:', error.message);
  }
});

// Endpoint manual de recuperación (ej: menú de Sheets, o "..." desde WhatsApp)
app.post('/barrido-manual', async (req, res) => {
  ejecutarBarrido(CONVERSATION_ID_PRODUCCION);
  res.json({ status: 'barrido activado' });
});

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    servicio: 'webhook-pedidos',
    idsProcesados: idsProcesados.size
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  await cargarIdsProcesados();
});
