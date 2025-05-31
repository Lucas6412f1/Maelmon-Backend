// server.js

require('dotenv').config(); // Laadt omgevingsvariabelen uit .env

const express = require('express');
const tmi = require('tmi.js'); // Twitch Chat Integratie
const app = express();
const port = process.env.PORT || 3000; // Render zal een PORT variabele instellen

// --- Twitch Chat Bot Configuratie ---
const twitchClient = new tmi.Client({
    options: { debug: true, messagesLogLevel: "info" },
    connection: {
        reconnect: true,
        secure: true
    },
    identity: {
        username: process.env.TWITCH_BOT_USERNAME,
        password: process.env.TWITCH_BOT_OAUTH_TOKEN
    },
    channels: [ process.env.TWITCH_CHANNEL_NAME ]
});

twitchClient.on('connected', (address, port) => {
    console.log(`Twitch bot connected: <span class="math-inline">\{address\}\:</span>{port}`);
});

twitchClient.on('message', (channel, tags, message, self) => {
    if (self) return;

    console.log(`[${channel}] ${tags['display-name']}: ${message}`);

    // Voorbeeld: reageer op een "!hello" commando
    if (message.toLowerCase() === '!hello') {
        twitchClient.say(channel, `Hello, ${tags['display-name']}!`);
    }

    // Voorbeeld: reageer op een "!claimcard" commando
    if (message.toLowerCase() === '!claimcard') {
        twitchClient.say(channel, `${tags['display-name']}, you tried to claim a card! (Feature coming soon!)`);
    }
});

twitchClient.connect().catch(console.error);

// --- Express Server Configuratie ---
app.use(express.json()); // Middleware om JSON-requests te parsen

// Eenvoudige test-route
app.get('/', (req, res) => {
    res.send('Welcome to the MaelMon Trading Cards Backend!');
});

// Voorbeeld API-route
app.get('/api/cards', (req, res) => {
    const cards = [
        { id: 1, name: 'Flame MaelMon', type: 'Fire' },
        { id: 2, name: 'Aqua MaelMon', type: 'Water' }
    ];
    res.json(cards);
});

// Start de server
app.listen(port, () => {
    console.log(`MaelMon Backend server running on http://localhost:${port}`);
});