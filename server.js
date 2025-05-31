// server.js

require('dotenv').config();

const express = require('express');
const tmi = require('tmi.js');
const cors = require('cors');
const mongoose = require('mongoose'); // NIEUW: Importeer Mongoose
const app = express();
const port = process.env.PORT || 3000;

// --- CORS Configuratie ---
const frontendUrl = 'https://maelmon-trading-cards.onrender.com';

const corsOptions = {
    origin: frontendUrl,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    optionsSuccessStatus: 204
};
app.use(cors(corsOptions));

// Middleware om JSON-requests te parsen
app.use(express.json());

// --- MongoDB Verbinding ---
mongoose.connect(process.env.MONGODB_URI) // Gebruik de MONGODB_URI uit je .env
    .then(() => console.log('Verbonden met MongoDB Atlas!'))
    .catch(err => console.error('Fout bij verbinden met MongoDB:', err));

// --- MongoDB Schema en Model voor Kaarten ---
// Definieer hoe een 'Card' eruitziet in je database
const cardSchema = new mongoose.Schema({
    name: { type: String, required: true },
    type: String, // Bijv. Fire, Water, Grass
    attack: Number,
    defense: Number,
    imageUrl: String // URL naar de afbeelding van de kaart
    // Voeg hier later meer eigenschappen toe zoals rarity, abilities, etc.
});

const Card = mongoose.model('Card', cardSchema); // Maak een Model aan van het Schema

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
    console.log(`Twitch bot connected: ${address}:${port}`);
});

twitchClient.on('message', async (channel, tags, message, self) => { // Maak de functie async
    if (self) return;
    console.log(`[${channel}] ${tags['display-name']}: ${message}`);

    if (message.toLowerCase() === '!hello') {
        twitchClient.say(channel, `Hello, ${tags['display-name']}! Welcome to MaelMon Trading Cards!`);
    }

    if (message.toLowerCase() === '!addcard') {
        // Voorbeeld: !addcard NaamVanKaart,Type,Attack,Defense,ImageURL
        const parts = message.slice('!addcard '.length).split(',');
        if (parts.length === 5) {
            const [name, type, attack, defense, imageUrl] = parts.map(p => p.trim());
            try {
                const newCard = new Card({ name, type, attack: parseInt(attack), defense: parseInt(defense), imageUrl });
                await newCard.save(); // Sla de nieuwe kaart op in MongoDB
                twitchClient.say(channel, `Kaart "${name}" succesvol toegevoegd aan de database!`);
            } catch (error) {
                console.error('Fout bij toevoegen kaart via Twitch:', error);
                twitchClient.say(channel, `Fout bij toevoegen kaart. Check logs. ` + error.message);
            }
        } else {
            twitchClient.say(channel, `Gebruik: !addcard Naam,Type,Attack,Defense,ImageURL`);
        }
    }

    if (message.toLowerCase() === '!claimcard') {
        // Hier zou de logica komen om een kaart toe te wijzen aan de kijker
        // Voor nu, een simpele bevestiging
        twitchClient.say(channel, `${tags['display-name']}, je hebt geprobeerd een kaart te claimen! (Feature coming soon!)`);
    }

});

twitchClient.connect().catch(console.error);


// --- Express Server Routes ---
app.get('/', (req, res) => {
    res.send('Welcome to the MaelMon Trading Cards Backend!');
});

// NIEUW: Haal alle kaarten op uit MongoDB
app.get('/api/cards', async (req, res) => {
    try {
        const cards = await Card.find({}); // Haal alle kaarten op uit de 'cards' collectie
        res.json(cards);
    } catch (error) {
        console.error('Fout bij ophalen kaarten uit MongoDB:', error);
        res.status(500).json({ message: 'Fout bij ophalen kaarten', error: error.message });
    }
});

// NIEUW: Route om handmatig een kaart toe te voegen (via frontend/Postman)
app.post('/api/cards', async (req, res) => {
    try {
        const newCard = new Card(req.body); // Data komt uit de request body (JSON)
        await newCard.save(); // Sla de nieuwe kaart op
        res.status(201).json(newCard); // Stuur de gemaakte kaart terug met status 201 Created
    } catch (error) {
        console.error('Fout bij toevoegen kaart:', error);
        res.status(400).json({ message: 'Kan kaart niet toevoegen', error: error.message });
    }
});


app.listen(port, () => {
    console.log(`MaelMon Backend server running on http://localhost:${port}`);
});