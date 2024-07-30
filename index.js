// Importar los módulos necesarios
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const xlsx = require('xlsx');
const TelegramBot = require('node-telegram-bot-api');
const dotenv = require('dotenv');
const axios = require('axios');

// Cargar las variables de entorno desde el archivo .env
dotenv.config();

// Obtener el token del bot de Telegram desde las variables de entorno
const token = process.env.TELEGRAM_BOT_TOKEN;

// Crear una instancia del bot de Telegram
const bot = new TelegramBot(token, { polling: true });

// Objeto para almacenar los resultados de búsqueda por chatId
const searchResults = {};

// Función para limpiar archivos antiguos en un directorio
async function cleanOldFiles(directory, maxAgeInDays = 7) {
    const files = await fsPromises.readdir(directory);
    const now = new Date();

    for (const file of files) {
        const filePath = path.join(directory, file);
        const stats = await fsPromises.stat(filePath);
        const fileAge = (now - stats.mtime) / (1000 * 60 * 60 * 24);

        if (fileAge > maxAgeInDays) {
            await fsPromises.unlink(filePath);
            console.log(`Archivo eliminado: ${file}`);
        }
    }
}

// Función para mostrar el contenido de un archivo Excel
async function mostrarContenidoArchivo(filePath) {
    try {
        const workbook = xlsx.readFile(filePath);
        const sheetNames = workbook.SheetNames;

        for (const sheetName of sheetNames) {
            console.log(`Hoja: ${sheetName}`);
            const worksheet = workbook.Sheets[sheetName];
            const sheetData = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
            console.log(sheetData);
        }
    } catch (error) {
        console.error('Error al leer el archivo:', error);
    }
}

// Función para buscar un término en un archivo Excel
async function buscarEnArchivo(filePath, searchTerm, chatId, page = 1, resultsPerPage = 5) {
    try {
        const workbook = xlsx.readFile(filePath);
        let allMatchingRows = [];

        for (const sheetName of workbook.SheetNames) {
            const worksheet = workbook.Sheets[sheetName];
            const sheetData = xlsx.utils.sheet_to_json(worksheet, { header: 1 });

            if (sheetData.length > 0) {
                const headers = sheetData[0];
                const matchingRows = sheetData.slice(1).filter(row =>
                    row.some(cell => String(cell).toLowerCase().includes(searchTerm.toLowerCase()))
                );

                allMatchingRows = allMatchingRows.concat(matchingRows.map(row => ({ sheetName, headers, row })));
            }
        }

        searchResults[chatId] = {
            results: allMatchingRows,
            searchTerm: searchTerm,
            currentPage: page
        };

        await sendPaginatedResults(chatId, page);
    } catch (error) {
        console.error('Error al buscar en el archivo:', error);
        await handleErrorMessage(chatId, 'Ocurrió un error al buscar en el archivo. Por favor, inténtalo de nuevo más tarde.');
    }
}

// Función para enviar los resultados paginados de la búsqueda
async function sendPaginatedResults(chatId, page, resultsPerPage = 5) {
    const searchData = searchResults[chatId];
    if (!searchData) {
        await bot.sendMessage(chatId, 'No hay resultados de búsqueda disponibles.');
        return;
    }

    const { results, searchTerm } = searchData;
    const totalResults = results.length;
    const totalPages = Math.ceil(totalResults / resultsPerPage);
    page = Math.max(1, Math.min(page, totalPages));

    const startIndex = (page - 1) * resultsPerPage;
    const endIndex = Math.min(startIndex + resultsPerPage, totalResults);
    const paginatedResults = results.slice(startIndex, endIndex);

    let message = `<b>🎉 Se encontraron un total de ${totalResults} resultados para "${searchTerm}". 🎉</b>\n\n`;
    message += `<b>Mostrando resultados ${startIndex + 1} - ${endIndex} (Página ${page} de ${totalPages}):</b>\n\n`;

    for (const { sheetName, headers, row } of paginatedResults) {
        message += `<b>Hoja: ${sheetName}</b>\n`;

        for (let i = 0; i < headers.length; i++) {
            const header = headers[i];
            const value = row[i] !== undefined ? row[i] : '';
            message += `<b>${header}:</b> ${value}\n`;
        }

        message += '\n';
    }

    const keyboard = [];
    if (page > 1) {
        keyboard.push([{ text: '⬅️ Anterior', callback_data: `page_${page - 1}` }]);
    }
    if (page < totalPages) {
        keyboard.push([{ text: 'Siguiente ➡️', callback_data: `page_${page + 1}` }]);
    }

    await bot.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
    });
}

// Mensaje de bienvenida al iniciar el bot
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const welcomeMessage = `<b>✨ ¡Bienvenido! ✨</b>\n\n💻 Este es un bot para analizar archivos.\n\n📁 Por favor, envía un archivo Excel (.xlsx) o CSV (.csv) para comenzar.\n\n`;

    const imagePath = path.join(__dirname, 'avatar6771823169.jpg');

    await bot.sendPhoto(chatId, imagePath, {
        caption: welcomeMessage,
        parse_mode: 'HTML',
        reply_markup: { remove_keyboard: true }
    });
});

// Manejo de subida de archivos
bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const fileId = msg.document.file_id;
    const fileName = msg.document.file_name;

    if (!fileName.endsWith('.xlsx') && !fileName.endsWith('.csv')) {
        await bot.sendMessage(chatId, 'Por favor, envía un archivo Excel (.xlsx) o CSV (.csv).');
        return;
    }

    try {
        // Obtener la información del archivo
        const fileInfo = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;

        // Descargar el archivo por partes
        const response = await axios({
            method: 'get',
            url: fileUrl,
            responseType: 'stream'
        });

        const timestamp = Date.now();
        const filePath = path.join(__dirname, 'archivos', `${timestamp}_${fileName}`);
        const writer = fs.createWriteStream(filePath);

        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        await bot.sendMessage(chatId, `<b>Archivo:</b> ${fileName} <b>subido correctamente ✅.</b>`, { parse_mode: 'HTML' });
        await mostrarContenidoArchivo(filePath);

        await bot.sendMessage(chatId, '¿Qué te gustaría buscar en el archivo?', {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Buscar por Distrito', callback_data: 'search_district' }],
                    [{ text: 'Buscar por Vivienda', callback_data: 'search_housing' }]
                ]
            }
        });

        await cleanOldFiles(path.join(__dirname, 'archivos'));

    } catch (error) {
        console.error('Error al procesar el archivo:', error);
        await handleErrorMessage(chatId, 'Ocurrió un error al procesar el archivo. Por favor, inténtalo de nuevo más tarde.');
    }
});

// Manejo de consultas de botones
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const option = query.data;

    if (option.startsWith('page_')) {
        const page = parseInt(option.split('_')[1]);
        await sendPaginatedResults(chatId, page);
        await bot.answerCallbackQuery(query.id);
        return;
    }

    let message;
    switch (option) {
        case 'search_district':
            message = 'Por favor, escribe el Distrito que deseas buscar en el archivo:';
            break;
        case 'search_housing':
            message = 'Por favor, escribe la Vivienda que deseas buscar en el archivo:';
            break;
        default:
            message = 'Opción no reconocida. Por favor, intenta de nuevo.';
    }

    await bot.sendMessage(chatId, message);
    await bot.answerCallbackQuery(query.id);
});

// Manejo de consultas de texto
bot.on('text', async (msg) => {
    const chatId = msg.chat.id;
    const searchTerm = msg.text.trim();

    if (searchTerm && searchTerm !== '/start') {
        await bot.sendMessage(chatId, 'Buscando en el archivo...');

        try {
            const filePath = path.join(__dirname, 'archivos');
            const files = await fsPromises.readdir(filePath);
            const lastFile = files[files.length - 1];
            const lastFilePath = path.join(filePath, lastFile);

            await buscarEnArchivo(lastFilePath, searchTerm, chatId);
        } catch (error) {
            console.error('Error al buscar en el archivo:', error);
            await handleErrorMessage(chatId, 'Ocurrió un error al buscar en el archivo. Por favor, inténtalo de nuevo más tarde.');
        }
    }
});

// Función para manejar errores y enviar un mensaje al usuario
async function handleErrorMessage(chatId, errorMessage) {
    const errorText = `<b>❌ Ocurrió un error:</b>\n\n${errorMessage}`;
    await bot.sendMessage(chatId, errorText, { parse_mode: 'HTML' });
}

// Iniciar el bot
console.log('Bot iniciado. Esperando archivos...');